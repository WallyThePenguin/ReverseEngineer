// An approval waiting for you stays in the inbox until you decide it (D58): its ⋯ menu offers no
// snooze, and a snooze Hearth refuses anyway puts the card straight back.
import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxRow } from "./types.ts";

const client = new QueryClient();
const errors: string[] = [];
vi.mock("./live.ts", () => ({
  queryClient: client,
  live: { refresh: () => {}, connected: () => false },
  toast: { show: () => {} },
  reportError: (err: Error) => errors.push(err.message),
}));

const { rowMenu } = await import("./inbox.ts");
const { act } = await import("./query.ts");

const row = (id: string, approvalStatus: string | null = null) =>
  ({
    notification: { id, state: "unseen", title: id, approvalId: approvalStatus && `ap-${id}` },
    entityTitle: null,
    entityType: null,
    approvalStatus,
  }) as unknown as InboxRow;
const labels = (r: InboxRow, view: "live" | "snoozed" | "done") =>
  rowMenu(r, view, { done: () => {}, snooze: () => {} }).map((i) => i.label);

const LIVE = ["inbox.list", { view: "live", lane: "signal", limit: 100 }];
const ids = () => (client.getQueryData(LIVE) as InboxRow[]).map((r) => r.notification.id);

afterEach(() => vi.unstubAllGlobals());

describe("an approval waiting for you", () => {
  it("isn't offered a snooze from its menu, though every other live card is", () => {
    expect(labels(row("a", "pending"), "live")).toEqual(["Done"]);
    expect(labels(row("b"), "live")).toEqual(["Done", "Snooze…"]);
    // Once it's decided it can be put away like anything else.
    expect(labels(row("c", "executed"), "live")).toEqual(["Done", "Snooze…"]);
    expect(labels(row("d"), "done")).toEqual(["Not done"]);
  });

  it("comes straight back when Hearth refuses to snooze it", async () => {
    const refusal = { status: "error", code: "conflict", message: "This one needs a yes or a no." };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(refusal), { status: 409 }));
    client.setQueryData(LIVE, [row("a", "pending"), row("b")]);
    const snoozing = act("inbox.snooze", { id: "a", until: "2026-10-05T09:00:00Z" });
    expect(ids()).toEqual(["b"]);
    expect(await snoozing).toBeNull();
    expect(ids()).toEqual(["a", "b"]);
    expect(errors).toEqual([refusal.message]);
  });
});
