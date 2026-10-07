// What the driver knows about one tab (B1), kept up from the page's events: its frames and the
// child sessions of those from other sites, how far each frame's page has loaded, the browser's
// log, a dialog waiting for an answer, the last screenshot's size, and its refs.
import { RefMap } from "./refs.ts";
import type { DriverEvent } from "./transport.ts";

export interface FrameInfo {
  id: string;
  parent: string | null;
  /** The child session the frame is in; undefined for the tab's own. */
  session: string | undefined;
  url: string;
}

export interface ConsoleEntry {
  level: string;
  source: string;
  text: string;
  url: string;
  at: number;
}

/** How a screenshot's pixels map to the page (B1): image px = CSS px × scale. */
export interface ShotMeta {
  imageW: number;
  imageH: number;
  cssW: number;
  cssH: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  scale: number;
}

const CONSOLE_MAX = 200;

export class TabState {
  readonly tabId: number;
  readonly refs = new RefMap();
  readonly frames = new Map<string, FrameInfo>();
  /** Child sessions, by the frame each is for. */
  readonly sessions = new Map<string, string>();
  /** The <iframe> that holds each child session's frame, for where its page sits on screen. */
  readonly owners = new Map<string, { session: string | undefined; node: number }>();
  /** Hearth's isolated world in each frame: `${session}|${frameId}` → context id. */
  readonly worlds = new Map<string, number>();
  /** The load steps each frame's current page has reached (commit, DOMContentLoaded, load...). */
  readonly lifecycle = new Map<string, Set<string>>();
  readonly console: ConsoleEntry[] = [];
  mainFrame: string | null = null;
  /** New pages in the tab's own frame so far. */
  navigations = 0;
  /** The tab's own frame is loading a page: asked for, or under way, until it stops. */
  starting = false;
  /** Other pages the tab's own page asked to go to so far (a link, a form, a script). */
  asked = 0;
  /** The page the tab's own page last asked to go to, until it arrives or loading stops. */
  heading: string | null = null;
  dialog: { type: string; message: string } | null = null;
  shot: ShotMeta | null = null;
  /** When you last used the tab yourself, from Hearth's live view. */
  ownerAt = 0;
  /** What the last read showed of each ref, to say what an action changed. */
  last: Map<string, string> | null = null;
  /** Whether the frames and sessions have been asked for since the driver first saw the tab. */
  seeded = false;
  private readonly waiters = new Set<() => void>();

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  /** The frame session's own frame: the tab's main frame, or the frame a child session is for. */
  rootFrame(session: string | undefined): string | null {
    return session ? (this.sessions.get(session) ?? null) : this.mainFrame;
  }

  /** The child session a frame from another site is in, if it is in one. */
  sessionOf(frameId: string): string | undefined {
    for (const [session, frame] of this.sessions) if (frame === frameId) return session;
    return undefined;
  }

  /** Waits until `done` is true, or `ms` passes; says which. */
  waitFor(done: () => boolean, ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (!done()) return;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), ms);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(ok);
      };
      this.waiters.add(check);
    });
  }

  private forgetWorlds(match: (key: string) => boolean): void {
    for (const k of [...this.worlds.keys()]) if (match(k)) this.worlds.delete(k);
  }

  /** Chrome let go of the tab: everything known about its page goes. */
  reset(): void {
    this.refs.clear();
    this.frames.clear();
    this.sessions.clear();
    this.owners.clear();
    this.worlds.clear();
    this.lifecycle.clear();
    this.mainFrame = null;
    this.dialog = null;
    this.last = null;
    this.seeded = false;
    this.starting = false;
    this.heading = null;
  }

  handle(e: DriverEvent): void {
    // biome-ignore lint/suspicious/noExplicitAny: protocol events, read field by field.
    const p = e.params as Record<string, any>;
    switch (e.method) {
      case "Page.frameNavigated": {
        const f = p.frame as { id: string; parentId?: string; url: string; urlFragment?: string };
        const main = !f.parentId && !e.sessionId;
        this.frames.set(f.id, {
          id: f.id,
          parent: f.parentId ?? null,
          session: e.sessionId,
          url: f.url + (f.urlFragment ?? ""),
        });
        if (main) {
          this.mainFrame = f.id;
          this.navigations++;
          this.heading = null;
          this.refs.clear();
          this.worlds.clear();
          this.owners.clear();
          this.last = null;
          for (const [id, frame] of this.frames)
            if (id !== f.id && !frame.session) this.frames.delete(id);
        } else {
          this.refs.drop((r) => r.frameId === f.id);
          this.forgetWorlds((k) => k.endsWith(`|${f.id}`));
        }
        break;
      }
      case "Page.navigatedWithinDocument": {
        const frame = this.frames.get(String(p.frameId));
        if (frame) frame.url = String(p.url);
        break;
      }
      case "Page.frameRequestedNavigation":
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading":
        if (!e.sessionId && (p.frameId === this.mainFrame || this.mainFrame === null)) {
          this.starting = e.method !== "Page.frameStoppedLoading";
          if (!this.starting) this.heading = null;
          // Heard as the page asks, before the new one comes. A #part of the same page isn't one,
          // nor is a page asked for in a new tab or window, or a download.
          const at = this.mainFrame ? this.frames.get(this.mainFrame)?.url : undefined;
          if (
            e.method === "Page.frameRequestedNavigation" &&
            (!p.disposition || p.disposition === "currentTab") &&
            String(p.url).split("#")[0] !== at?.split("#")[0]
          ) {
            this.asked++;
            this.heading = String(p.url);
          }
        }
        break;
      case "Page.frameDetached":
        if (p.reason !== "swap") {
          this.frames.delete(String(p.frameId));
          this.refs.drop((r) => r.frameId === p.frameId);
        }
        break;
      case "Page.lifecycleEvent": {
        const id = String(p.frameId);
        if (p.name === "init") this.lifecycle.set(id, new Set());
        else (this.lifecycle.get(id) ?? this.lifecycle.set(id, new Set()).get(id))?.add(p.name);
        break;
      }
      case "Target.attachedToTarget": {
        const info = p.targetInfo as { targetId: string; type: string; url: string };
        if (info.type !== "iframe") break;
        this.sessions.set(String(p.sessionId), info.targetId);
        this.frames.set(info.targetId, {
          id: info.targetId,
          parent: null,
          session: String(p.sessionId),
          url: info.url,
        });
        break;
      }
      case "Target.detachedFromTarget": {
        const session = String(p.sessionId);
        const frame = this.sessions.get(session);
        this.sessions.delete(session);
        this.refs.drop((r) => r.session === session);
        this.forgetWorlds((k) => k.startsWith(`${session}|`));
        if (frame && this.frames.get(frame)?.session === session) this.frames.delete(frame);
        break;
      }
      case "Log.entryAdded": {
        const entry = p.entry as Record<string, unknown>;
        this.console.push({
          level: String(entry.level ?? "info"),
          source: String(entry.source ?? "other"),
          text: String(entry.text ?? "").slice(0, 500),
          url: String(entry.url ?? ""),
          at: Date.now(),
        });
        if (this.console.length > CONSOLE_MAX)
          this.console.splice(0, this.console.length - CONSOLE_MAX);
        break;
      }
      case "Page.javascriptDialogOpening":
        this.dialog = { type: String(p.type ?? "alert"), message: String(p.message ?? "") };
        break;
      case "Page.javascriptDialogClosed":
        this.dialog = null;
        break;
      case "Hearth.detached":
        this.reset();
        break;
    }
    for (const check of [...this.waiters]) check();
  }
}
