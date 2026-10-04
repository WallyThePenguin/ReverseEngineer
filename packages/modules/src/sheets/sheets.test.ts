import { entity } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

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
});
