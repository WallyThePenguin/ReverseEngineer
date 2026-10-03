import { type Origin, PRINCIPAL, type Via } from "@hearth/core";
import type { Caller } from "./types.ts";

export function ownerCaller(via: Via = "ui", extra: Partial<Caller> = {}): Caller {
  return { principal: PRINCIPAL.owner, kind: "owner", origin: "owner", via, ...extra };
}

export function systemCaller(extra: Partial<Caller> = {}): Caller {
  return { principal: PRINCIPAL.system, kind: "system", origin: "system", via: "system", ...extra };
}

export function jarvisCaller(origin: Origin, extra: Partial<Caller> = {}): Caller {
  return { principal: PRINCIPAL.jarvis, kind: "agent", origin, via: "jarvis", ...extra };
}

/** An integration syncing records in (Google, later Slack). What it writes is outside content. */
export function integrationCaller(name: string, extra: Partial<Caller> = {}): Caller {
  return {
    principal: `integration:${name}`,
    kind: "integration",
    origin: "untrusted",
    via: "integration",
    ...extra,
  };
}
