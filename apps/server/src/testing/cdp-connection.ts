// A real Chromium for the driver's tests, spoken to over its own debugging WebSocket with flat
// sessions, as the extension speaks to Chrome (Playwright's sessions can't address a frame's
// child session). Pages come from a small HTTP server; *.test names all point at it, so
// a.test and b.test are two sites and their frames run in separate processes.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export interface CdpMessage {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

/** Pages by host and path ("a.test/form"), or by path alone for any host. */
export type Site = Record<string, string | ((body: string) => string)>;

export class FixtureServer {
  readonly server: Server;
  readonly posts: { url: string; body: string }[] = [];
  port = 0;
  private readonly site: Site;

  constructor(site: Site) {
    this.site = site;
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const host = (req.headers.host ?? "").split(":")[0];
        const path = (req.url ?? "/").split("?")[0];
        if (req.method === "POST") this.posts.push({ url: `${host}${path}`, body });
        const page = this.site[`${host}${path}`] ?? this.site[path ?? "/"];
        if (page === undefined) {
          res.writeHead(404).end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(typeof page === "function" ? page(body) : page);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(host: string, path = "/"): string {
    return `http://${host}:${this.port}${path}`;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

/** One Chromium and its browser-wide debugging connection. */
export class CdpConnection {
  private readonly proc: ChildProcess;
  private readonly profile: string;
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  private readonly listeners = new Set<(m: CdpMessage) => void>();

  private constructor(proc: ChildProcess, profile: string, ws: WebSocket) {
    this.proc = proc;
    this.profile = profile;
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else for (const l of this.listeners) l(msg);
    });
  }

  static async launch(executable: string): Promise<CdpConnection> {
    const profile = mkdtempSync(join(tmpdir(), "hearth-driver-"));
    const proc = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--site-per-process",
        "--force-device-scale-factor=1",
        "--window-size=1280,800",
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let err = "";
      const timer = setTimeout(() => reject(new Error(`Chromium didn't start: ${err}`)), 20_000);
      proc.stderr?.on("data", (chunk) => {
        err += String(chunk);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      proc.on("exit", () => reject(new Error(`Chromium exited: ${err}`)));
    });
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    return new CdpConnection(proc, profile, ws);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome didn't answer (cdp ${method}) in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (m: CdpMessage) => void): void {
    this.listeners.add(listener);
  }

  async close(): Promise<void> {
    this.ws.close();
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    // Windows keeps the profile busy for a moment after the process goes.
    for (let n = 0; n < 10; n++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
