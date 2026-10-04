// What one driver step works with (B1): the tab, its protocol commands and isolated worlds, and
// the policy the kernel sent along (blocked and trusted sites, pacing, an approved step's site).
import { onSiteList } from "@hearth/core";
import { type DriverPolicy, judge, type Verdict } from "@hearth/modules/driver-kit";
import { fail } from "./errors.ts";
import type { TabState } from "./tab.ts";
import type { Cdp, CdpTransport } from "./transport.ts";
import type { Worlds } from "./world.ts";

interface FrameTree {
  frame: { id: string; parentId?: string; url: string; urlFragment?: string };
  childFrames?: FrameTree[];
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export class DriverContext {
  readonly transport: CdpTransport;
  readonly cdp: Cdp;
  readonly tab: TabState;
  readonly worlds: Worlds;
  readonly policy: DriverPolicy;

  constructor(
    transport: CdpTransport,
    cdp: Cdp,
    tab: TabState,
    worlds: Worlds,
    policy: DriverPolicy,
  ) {
    this.transport = transport;
    this.cdp = cdp;
    this.tab = tab;
    this.worlds = worlds;
    this.policy = policy;
  }

  /** A site the owner trusts Jarvis to act on, and hasn't blocked. */
  trusted(url: string): boolean {
    const host = hostOf(url);
    return (
      Boolean(host) &&
      onSiteList(host, this.policy.trusted) &&
      !onSiteList(host, this.policy.blocked)
    );
  }

  /** Whether a press may go ahead where it is, by the frame's own site (or the tab's). */
  judge(v: Pick<Verdict, "sends" | "floor">, frameUrl: string): "go" | "ask" {
    const url = /^https?:/.test(frameUrl) ? frameUrl : this.url();
    return judge(
      { sends: v.sends, floor: v.floor as Verdict["floor"], why: "" },
      this.trusted(url),
    );
  }

  /** Refuses a blocked site to anyone but the owner. */
  assertAllowed(url: string): void {
    if (this.policy.owner) return;
    const host = hostOf(url);
    if (host && onSiteList(host, this.policy.blocked))
      throw fail("blocked", `${host} is on the owner's list of sites Jarvis never opens.`);
  }

  /** An approved step runs only on the site it was approved for. */
  assertSite(): void {
    const site = this.policy.site;
    if (!site) return;
    const host = hostOf(this.url());
    if (host !== site && !host.endsWith(`.${site}`))
      throw fail(
        "changed",
        `Tab ${this.tab.tabId} is on ${host} now, not ${site}. Nothing was done.`,
      );
  }

  /** The address of the tab's page, as last heard. */
  url(): string {
    return (this.tab.mainFrame && this.tab.frames.get(this.tab.mainFrame)?.url) || "";
  }

  /** The address of a frame's page, asked of Chrome when it wasn't heard (a frame from before). */
  async frameUrl(session: string | undefined, frameId: string): Promise<string> {
    const known = this.tab.frames.get(frameId)?.url;
    if (known) return known;
    const { frameTree } = await this.cdp
      .send<{ frameTree: FrameTree }>("Page.getFrameTree", {}, session)
      .catch(() => ({ frameTree: null }));
    const find = (t: FrameTree | null): string => {
      if (!t) return "";
      if (t.frame.id === frameId) return t.frame.url;
      for (const c of t.childFrames ?? []) {
        const u = find(c);
        if (u) return u;
      }
      return "";
    };
    const url = find(frameTree);
    const frame = this.tab.frames.get(frameId);
    if (frame) frame.url = url;
    else this.tab.frames.set(frameId, { id: frameId, parent: null, session, url });
    return url;
  }

  /** Learns the tab's frames when the driver first sees it (or after Chrome let it go). */
  async seed(): Promise<void> {
    if (this.tab.seeded && this.tab.mainFrame) return;
    const { frameTree } = await this.cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree");
    const visit = (t: FrameTree) => {
      const f = t.frame;
      this.tab.frames.set(f.id, {
        id: f.id,
        parent: f.parentId ?? null,
        session: undefined,
        url: f.url + (f.urlFragment ?? ""),
      });
      for (const c of t.childFrames ?? []) visit(c);
    };
    visit(frameTree);
    this.tab.mainFrame = frameTree.frame.id;
    await this.refreshSessions();
    this.tab.seeded = true;
  }

  /** The child sessions the extension has for the tab's frames from other sites. */
  async refreshSessions(): Promise<void> {
    const list = await this.transport
      .call<{ sessionId: string; targetId: string }[]>("tabs.frames", { tabId: this.tab.tabId })
      .catch(() => []);
    for (const { sessionId, targetId } of list ?? []) {
      this.tab.sessions.set(sessionId, targetId);
      if (!this.tab.frames.has(targetId))
        this.tab.frames.set(targetId, { id: targetId, parent: null, session: sessionId, url: "" });
    }
  }
}
