// A pretend Hearth extension and live-view page for the browser bridge's tests: WebSockets to a
// test server that queue messages, so a test can wait for the next one of a type.
import { BRIDGE_PROTOCOL, EXTENSION_ID } from "@hearth/modules";
import WebSocket from "ws";

export type Msg = Record<string, unknown> & { type: string };

export function socket(base: string, path: string, origin: string) {
  const ws = new WebSocket(`${base}${path}`, { origin });
  const inbox: Msg[] = [];
  const waiters: { type: string; resolve(m: Msg): void }[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(msg);
    else inbox.push(msg);
  });
  const next = (type: string) =>
    new Promise<Msg>((resolve, reject) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0] as Msg);
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`No ${type} message`)), 3000);
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  return { ws, next, opened, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** An answer that fails, the way the extension reports an error with a code. */
export class Refusal {
  readonly error: string;
  readonly code: string | undefined;
  constructor(error: string, code?: string) {
    this.error = error;
    this.code = code;
  }
}

export interface FakeOptions {
  /** The protocol its hello says (the current one by default); null leaves it out, like 0.2. */
  protocol?: number | null;
  /** Its ID, which Chrome puts in the Origin. */
  id?: string;
  version?: string;
  /** Answers pings (the real extension does). */
  pong?: boolean;
}

/** A pretend Chrome extension that answers calls from a table and records them. */
export async function fakeExtension(
  base: string,
  token: string,
  answers: Record<string, (p: Msg) => unknown>,
  opts: FakeOptions = {},
) {
  const ext = socket(base, "/api/browser/bridge", `chrome-extension://${opts.id ?? EXTENSION_ID}`);
  const calls: Msg[] = [];
  await ext.opened;
  const protocol = opts.protocol === undefined ? BRIDGE_PROTOCOL : opts.protocol;
  ext.send({
    type: "hello",
    token,
    version: opts.version ?? "0.3.0",
    ...(protocol === null ? {} : { protocol }),
  });
  ext.ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    if (msg.type === "ping" && opts.pong !== false) return ext.send({ type: "pong" });
    if (msg.type !== "call") return;
    calls.push(msg);
    const answer = answers[String(msg.method)];
    const params = msg.params as Msg;
    const key = msg.method === "cdp" ? String(params.method) : String(msg.method);
    const result = (answers[key] ?? answer)?.(params) ?? {};
    if (result instanceof Refusal)
      ext.send({ type: "result", id: msg.id, error: result.error, code: result.code });
    else ext.send({ type: "result", id: msg.id, result });
  });
  return { ...ext, calls };
}
