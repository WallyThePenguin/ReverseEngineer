// What every request handler can see.
import type { Caller, Kernel } from "@hearth/kernel";
import type pg from "pg";
import type { ServerConfig } from "./config.ts";
import type { EventHub } from "./hub.ts";

export interface ServerDeps {
  kernel: Kernel;
  pool: pg.Pool;
  config: ServerConfig;
  hub: EventHub;
}

export interface AppEnv {
  Variables: {
    deps: ServerDeps;
    /** Who's calling, or null when signed out. */
    caller: Caller | null;
    /** The raw session token, when the caller came in with one. */
    token: string | null;
    /** True when the caller authenticated with a cookie (so the Origin check applies). */
    viaCookie: boolean;
  };
}
