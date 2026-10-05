// An approval waiting for you stays in the inbox until you decide it (D58): its "more" menu offers
// no snooze, a snooze Hearth refuses anyway puts the card straight back, and its card shows what
// it would do, why, and the exact text in full.
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

const { approvalParts, rowMenu } = await import("./inbox.ts");
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

describe("an approval's card", () => {
  const why = "Other people would see this, so it needs your yes.";

  it("shows what it would do, why, and the email's text exactly as it would go", () => {
    const text = "Hi Dana,\n\nThe lease looks fine.  Signed copy attached.\n\nBest,\nM\n";
    const title = "Jarvis asks: Send an email to dana@example.com: Re: lease";
    expect(approvalParts({ title, body: `${text}\n\n${why}` })).toEqual({ what: title, why, text });
  });

  it("never shortens the text, however long", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}.`).join("\n\n");
    expect(approvalParts({ title: "t", body: `${text}\n\n${why}` }).text).toBe(text);
  });

  it("has only a why when there's nothing more to show", () => {
    const hard = "This is hard to undo, so it needs your yes.";
    expect(approvalParts({ title: "t", body: hard })).toEqual({ what: "t", why: hard, text: null });
    expect(approvalParts({ title: "t", body: null })).toEqual({ what: "t", why: null, text: null });
  });
});
