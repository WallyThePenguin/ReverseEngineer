// A Hearth server on a fresh test database, with a cookie jar like a browser's.
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { createApp } from "../app.ts";
import type { BrowserBridge } from "../browser/bridge.ts";
import type { ServerConfig } from "../config.ts";

export const TEST_ORIGIN = "http://localhost:4400";

export interface TestServer extends TestKernel {
  server: ReturnType<typeof createApp>;
  /** Sends a request as the browser: same-origin, with whatever cookies it has. */
  browser(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  /** Sends a request with a bearer token and no cookies. */
  api(path: string, token: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  cookies: Map<string, string>;
}

export async function createTestServer(
  config: Partial<ServerConfig> = {},
  opts: { bridge?: BrowserBridge } = {},
): Promise<TestServer> {
  const tk = await createTestKernel(ALL_MODULES);
  const server = createApp({
    kernel: tk.kernel,
    bridge: opts.bridge,
    config: {
      host: "127.0.0.1",
      port: 4400,
      origin: TEST_ORIGIN,
      devAuth: false,
      webDist: null,
      chrome: { mode: "off", task: "", chromePath: null, profile: null, args: [] },
      ...config,
    },
  });
  const cookies = new Map<string, string>();

  const send = async (
    path: string,
    init: RequestInit & { json?: unknown },
    headers: Record<string, string>,
  ) => {
    const { json, ...rest } = init;
    const h = new Headers(headers);
    for (const [k, v] of new Headers(rest.headers)) h.set(k, v);
    if (json !== undefined) h.set("content-type", "application/json");
    const res = await server.app.request(path, {
      ...rest,
      headers: h,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    return res;
  };

  return {
    ...tk,
    server,
    cookies,
    async browser(path, init = {}) {
      const headers: Record<string, string> = { origin: TEST_ORIGIN };
      if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await send(path, init, headers);
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(";");
        const [name, value] = pair!.split("=") as [string, string];
        const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
        if (expired || !value) cookies.delete(name.trim());
        else cookies.set(name.trim(), value);
      }
      return res;
    },
    api(path, token, init = {}) {
      return send(path, init, { authorization: `Bearer ${token}` });
    },
    async destroy() {
      await server.stop();
      await tk.destroy();
    },
  };
}
