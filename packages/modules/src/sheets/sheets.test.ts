import { DEFAULT_DAY_RULES, mergeWorkbook, renameSheetRefs, type Workbook } from "@hearth/core";
import { entity } from "@hearth/db";
import { budget, fastest } from "@hearth/db/testing";
import { type Caller, jarvisCaller, ownerCaller, setSetting } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { results } from "./engine.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

interface Sheet {
  title: string;
  version: number;
  book: { sheets: { name: string; cells: Record<string, string> }[] };
  results: Record<string, string>[];
}

describe("spreadsheets", () => {
  it("works out formulas, keeps what you typed, and puts the results in the body", async () => {
    const { id } = await ok<{ id: string }>("sheet.create", { title: "Budget" });
    const book = {
      sheets: [
        {
          id: "s1",
          name: "Costs",
          cells: { A1: "Rent", B1: "1200", A2: "Food", B2: "300", B3: "=SUM(B1:B2)" },
          widths: {},
        },
        { id: "s2", name: "Plan", cells: { A1: "=Costs!B3*12" }, widths: {} },
      ],
    };
    expect(await ok("sheet.save", { id, book })).toEqual({ id, version: 1 });
    const s = await ok<Sheet>("sheet.get", { id });
    expect(s.book.sheets[0]!.cells.B3).toBe("=SUM(B1:B2)");
    expect(s.results[0]!.B3).toBe("1500");
    expect(s.results[1]!.A1).toBe("18000");
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, id));
    expect(row?.body).toContain("| Food | 300 |");
    expect(row?.body).toContain("| 18000 |");
  });

  it("lets Jarvis set cells by name, and refuses what isn't a cell", async () => {
    const { id } = await ok<{ id: string }>("sheet.create", { title: "Scores" });
    const jarvis = jarvisCaller("agent");
    const set = await ok<{ results: Record<string, string> }>(
      "sheet.set",
      { id, cells: { A1: "2", A2: "3", "Totals!A1": "=Sheet1!A1+Sheet1!A2" }, addSheet: "Totals" },
      jarvis,
    );
    expect(set.results).toEqual({ A1: "2", A2: "3", "Totals!A1": "5" });
    await ok("sheet.set", { id, cells: { A2: "" } }, jarvis);
    const s = await ok<Sheet>("sheet.get", { id });
    expect(s.book.sheets.map((x) => x.name)).toEqual(["Sheet1", "Totals"]);
    expect(s.results[1]!.A1).toBe("2");
    for (const cells of [{ ZZ9: "1" }, { "Nope!A1": "1" }, { A501: "1" }])
      expect(await t.kernel.execute("sheet.set", { id, cells }, jarvis)).toMatchObject({
        status: "error",
        code: "invalid_input",
      });
    expect(await ok<{ id: string }[]>("sheet.list")).toMatchObject([{ id }]);
  });

  it("refuses a save made from an old version; Jarvis's cells survive the merge", async () => {
    const { id } = await ok<{ id: string }>("sheet.create", { title: "Budget" });
    const sheet = (cells: Record<string, string>) => ({
      sheets: [{ id: "s1", name: "Sheet1", cells, widths: {} }],
    });
    const v1 = sheet({ A1: "Rent", B1: "1200" });
    await ok("sheet.save", { id, book: v1, baseVersion: 0 });
    await ok("sheet.set", { id, cells: { A2: "Food", B2: "300" } }, jarvisCaller("owner"));
    const mine = sheet({ A1: "Rent", B1: "1300" });
    const stale = await t.kernel.execute(
      "sheet.save",
      { id, book: mine, baseVersion: 1 },
      ownerCaller(),
    );
    expect(stale).toMatchObject({ status: "error", code: "conflict" });
    const theirs = await ok<Sheet & { book: Workbook }>("sheet.get", { id });
    const merged = mergeWorkbook(v1, mine, theirs.book);
    await ok("sheet.save", { id, book: merged, baseVersion: theirs.version });
    const s = await ok<Sheet>("sheet.get", { id });
    expect(s.book.sheets[0]!.cells).toEqual({ A1: "Rent", B1: "1300", A2: "Food", B2: "300" });
    expect(s.version).toBe(3);
    const jarvis = await t.kernel.execute("sheet.save", { id, book: mine }, jarvisCaller("owner"));
    expect(jarvis).toMatchObject({ status: "error", code: "invalid_input" });
  });

  it("keeps formulas working when a sheet they point at is renamed", () => {
    const book: Workbook = {
      sheets: [
        { id: "a", name: "Costs", cells: { B1: "1200", B2: "300", B3: "=SUM(B1:B2)" }, widths: {} },
        { id: "b", name: "Plan", cells: { A1: "=Costs!B3*12" }, widths: {} },
      ],
    };
    for (const name of ["Monthly costs", "Q4", "Spend"])
      expect(results(renameSheetRefs(book, 0, name))[1]!.A1).toBe("18000");
  });

  it("works out a 3,000-cell sheet in under 50 ms", async () => {
    // Nine formulas to a value, as the audit measured it: 2.7 s before evaluation was paused.
    const cells: Record<string, string> = {};
    for (let r = 1; r <= 300; r++)
      for (let c = 0; c < 10; c++)
        cells[`${"ABCDEFGHIJ"[c]}${r}`] = c === 0 ? String(r * 3) : `=A${r}*${c + 1}`;
    const book = { sheets: [{ id: "s1", name: "Big", cells, widths: {} }] };
    expect(results(book)[0]!.J300).toBe("9000");
    // The first few runs are slow while V8 compiles IronCalc's WebAssembly fully (100+ ms), so
    // they don't count: a server works out sheets all day. The best of ten then allows for a
    // machine busy with other work. It's about 20 ms on a developer's PC, so 50 still fails a
    // 10x slowdown; budget() gives slower machines more.
    const best = await fastest(() => results(book), { runs: 10, warmup: 3 });
    expect(best).toBeLessThan(budget(50));
  });

  it("works out NOW() and TODAY() in the owner's time zone", async () => {
    const { id } = await ok<{ id: string }>("sheet.create", { title: "Clock" });
    const book = { sheets: [{ id: "s", name: "S", cells: { A1: "=NOW()" }, widths: {} }] };
    // "10/4/2026, 3:13 PM" → 15
    const hour = (s = "") => {
      const m = /(\d+):\d+ (AM|PM)/.exec(s)!;
      return (Number(m[1]) % 12) + (m[2] === "PM" ? 12 : 0);
    };
    const offset =
      (hour(results(book, "UTC")[0]!.A1) - hour(results(book, "Asia/Tokyo")[0]!.A1) + 24) % 24;
    expect(offset).toBe(15); // Tokyo is UTC+9.
    await setSetting(t.tdb.db, "owner.dayRules", { ...DEFAULT_DAY_RULES, timeZone: "Asia/Tokyo" });
    await ok("sheet.set", { id, cells: { A1: "=NOW()" } }, jarvisCaller("owner"));
    const s = await ok<Sheet>("sheet.get", { id });
    expect(hour(s.results[0]!.A1)).toBe(hour(results(book, "Asia/Tokyo")[0]!.A1));
    // A clock's result is never kept: the next read works it out again.
    expect(results(book, "Nowhere/Atlantis")[0]!.A1).toBe(results(book, "UTC")[0]!.A1);
  });
});
