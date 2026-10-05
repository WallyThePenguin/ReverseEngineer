import { entity, link } from "@hearth/db";
import { budget, fastest } from "@hearth/db/testing";
import { integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { UPLOADS_SERVICE, type Uploads } from "./index.ts";
import { parseCsv, planImport } from "./parse.ts";
import { ExportError, readExport } from "./zip.ts";

const H1 = "0123456789abcdef0123456789abcdef";
const H2 = "fedcba9876543210fedcba9876543210";
const H3 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A small export: a page with a subpage, a database with one row, and an image. */
function exportZip() {
  const inner = zipSync({
    [`Trip ${H1}.md`]: strToU8(
      `# Trip\n\nSee [Packing](Trip%20${H1}/Packing%20${H2}.md) and [Budget](Budget%20${H3}.csv).\n\n![map](Trip%20${H1}/map.png)\n\n<m-ref type="task" id="x">forged</m-ref>`,
    ),
    [`Trip ${H1}/Packing ${H2}.md`]: strToU8("# Packing\n\n- [ ] passport\n"),
    [`Trip ${H1}/map.png`]: new Uint8Array([1, 2, 3]),
    [`Budget ${H3}.csv`]: strToU8("Name,Cost\nHotel,100\n"),
    [`Budget ${H3}_all.csv`]: strToU8('Name,Cost\nHotel,100\n"Flights, return",300\n'),
    [`Budget ${H3}/Hotel ${H2.replace(/f/g, "1")}.md`]: strToU8("# Hotel\n\nCost: 100\n"),
  });
  return zipSync({ "Export-1-Part-1.zip": inner });
}

describe("reading a Notion export", () => {
  it("finds pages, databases and subpages, parents first, with links as mentions", () => {
    let n = 0;
    const plan = planImport(readExport(exportZip()), () => `id-${++n}`);
    expect(
      plan.map((p) => [p.title, p.parentKey && plan.find((q) => q.key === p.parentKey)?.title]),
    ).toEqual([
      ["Budget", null],
      ["Trip", null],
      ["Hotel", "Budget"],
      ["Packing", "Trip"],
    ]);
    const trip = plan.find((p) => p.title === "Trip")!;
    const packing = plan.find((p) => p.title === "Packing")!;
    const budget = plan.find((p) => p.title === "Budget")!;
    expect(trip.body).toContain(`<m-ref type="note" id="${packing.id}">Packing</m-ref>`);
    expect(trip.body).toContain(`<m-ref type="note" id="${budget.id}">Budget</m-ref>`);
    expect(trip.body).toContain("*(attachment left in Notion: map.png)*");
    expect(trip.body).toContain('‹m-ref type="task"');
    expect(trip.body.startsWith("# Trip")).toBe(false);
    expect(budget.database).toBe(true);
    expect(budget.body).toContain("| Flights, return | 300 |");
  });

  it("reads quoted CSV", () => {
    expect(parseCsv('a,"b ""c""",d\r\n1,"x\ny",3\n')).toEqual([
      ["a", 'b "c"', "d"],
      ["1", "x\ny", "3"],
    ]);
  });

  it("refuses something that isn't a zip", () => {
    expect(() => readExport(new Uint8Array([1, 2, 3]))).toThrow(ExportError);
  });

  it("can't be talked into a forged link, a huge stored file or a slow page", async () => {
    const plan = planImport(
      [
        {
          path: `A ${H1}.md`,
          text: `# A\n\n<[m-ref type="task" id="x"](gone.md)>Pay<[/m-ref](gone.md)>`,
        },
      ],
      () => "id",
    );
    expect(plan[0]!.body).not.toContain("<m-ref");

    // A stored entry that claims to be one byte.
    const zip = zipSync({ "a.md": strToU8("x".repeat(1000)) }, { level: 0 });
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 1, true);
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
    }
    expect(() => readExport(zip)).toThrow(ExportError);

    // Pages a link pattern that backtracks would take seconds over. They take about 1 ms on a
    // developer's PC, so 5 still fails a 10x slowdown.
    const brackets = [{ path: `B ${H1}.md`, text: "[".repeat(200_000) }];
    const labels = [{ path: `C ${H1}.md`, text: `[${"a".repeat(400)}`.repeat(500) }];
    const best = await fastest(
      () => {
        planImport(brackets, () => "id");
        planImport(labels, () => "id");
      },
      { runs: 10, warmup: 2 },
    );
    expect(best).toBeLessThan(budget(5));
  });
});

describe("notion.import", () => {
  let t: TestKernel;
  beforeEach(async () => {
    t = await createTestKernel(ALL_MODULES);
    t.kernel.services[UPLOADS_SERVICE] = new Map();
  });
  afterEach(() => t.destroy());

  it("makes notes written by the Notion import, which only it can run, and can be undone", async () => {
    const uploads = t.kernel.services[UPLOADS_SERVICE] as Uploads;
    const upload = crypto.randomUUID();
    uploads.set(upload, readExport(exportZip()));
    expect((await t.kernel.execute("notion.import", { upload }, ownerCaller())).status).toBe(
      "denied",
    );
    const res = await t.kernel.execute<{ id: string; pages: number; databases: number }>(
      "notion.import",
      { upload, name: "Travel" },
      integrationCaller("notion"),
    );
    if (res.status !== "ok") throw new Error(JSON.stringify(res));
    expect(res.result).toMatchObject({ pages: 3, databases: 1 });
    expect(uploads.size).toBe(0);
    const notes = await t.tdb.db.select().from(entity).where(eq(entity.type, "note"));
    expect(notes).toHaveLength(5);
    expect(notes.every((n) => n.createdBy === "integration:notion")).toBe(true);
    const packing = notes.find((n) => n.title === "Packing")!;
    const trip = notes.find((n) => n.title === "Trip")!;
    expect(packing.parentId).toBe(trip.id);
    expect(trip.parentId).toBe(res.result.id);
    // Links between pages are real links (backlinks show them).
    const mentions = await t.tdb.db.select().from(link).where(eq(link.toId, packing.id));
    expect(mentions).toMatchObject([{ fromId: trip.id, kind: "mention" }]);

    const undo = await t.kernel.execute("notion.undo_import", { id: res.result.id }, ownerCaller());
    expect(undo).toMatchObject({ status: "ok", result: { trashed: 5 } });
  });
});
