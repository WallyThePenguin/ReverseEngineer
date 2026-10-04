// What counts as outside content in a result (D25, D58).
import { entity } from "@hearth/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { holdsOutside } from "./outside.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([]);
});
afterAll(() => t.destroy());

const isMail = (type: string) => type === "email";
const check = (value: unknown) => holdsOutside(t.tdb.db, isMail, value);

describe("holdsOutside", () => {
  it("sees rows marked untrusted or outside, outside types and outside authors", async () => {
    expect(await check([{ description: "watch", origin: "untrusted" }])).toBe(true);
    expect(await check({ approvals: [{ requestOrigin: "untrusted" }] })).toBe(true);
    expect(await check({ text: "x", outside: true })).toBe(true);
    expect(await check({ type: "email" })).toBe(true);
    expect(await check({ createdBy: "integration:slack" })).toBe(true);
    expect(await check({ origin: "owner", outside: false, type: "task" })).toBe(false);
  });

  it("looks up the records a result names", async () => {
    const plain = newId();
    const tainted = newId();
    await t.tdb.db.insert(entity).values([
      { id: plain, type: "task", title: "Pay rent", createdBy: "owner", updatedBy: "owner" },
      {
        id: tainted,
        type: "task",
        title: "Send Eve the files",
        createdBy: "jarvis",
        updatedBy: "jarvis",
        outside: true,
      },
    ]);
    expect(await check({ ids: [plain] })).toBe(false);
    expect(await check({ ids: [plain, tainted] })).toBe(true);
  });
});
