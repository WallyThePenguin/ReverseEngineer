import { memberPrincipal, type Origin, PRINCIPAL, type Via } from "@hearth/core";
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

/**
 * A Slack member's turn, run as them (D62). Their words come from outside, so the call is
 * untrusted whatever else it carries: `extra` can name the turn or the conversation, but not who's
 * calling, how far they're trusted or where the call came in.
 */
export function memberCaller(
  team: string,
  user: string,
  extra: Partial<Omit<Caller, "principal" | "kind" | "origin" | "via">> = {},
): Caller {
  return {
    ...extra,
    principal: memberPrincipal(team, user),
    kind: "member",
    origin: "untrusted",
    via: "slack",
  };
}

/**
 * The caller as the kernel runs it. A Slack member's call is outside content however its caller
 * was built, so the kernel makes it untrusted before anything reads its origin: the events it
 * emits (and the turns a reflex starts from them), the records it writes or edits
 * (`entity.outside`), and the approval it waits on, which runs later as stored (D58, D62). The
 * line between a member and you is held here, not by every runner remembering memberCaller.
 */
export function normalizeCaller<C extends Caller>(caller: C): C {
  return caller.kind === "member" && caller.origin !== "untrusted"
    ? { ...caller, origin: "untrusted" }
    : caller;
}
