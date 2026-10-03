// Spreadsheets (M7): workbooks of sheets with Excel-style formulas, worked out by IronCalc. A
// workbook is saved whole, last write wins (D20); its body is the results as markdown tables, so
// search, backlinks and Jarvis read it. Jarvis changes cells with sheet.set (D51).
import {
  emptyWorkbook,
  parseCell,
  type Workbook,
  WorkbookSchema,
  workbookMarkdown,
} from "@hearth/core";
import { entity, sheetBook } from "@hearth/db";
import {
  ActionError,
  createEntity,
  defineAction,
  defineModule,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { describeRow, id, liveEntity, title } from "../shared.ts";
import { results } from "./engine.ts";

async function load(db: Parameters<typeof liveEntity>[0], bookId: string) {
  const row = await liveEntity(db, bookId, "spreadsheet");
  if (!row) throw new ActionError("not_found", "No such spreadsheet");
  const [b] = await db.select().from(sheetBook).where(eq(sheetBook.entityId, bookId));
  const parsed = WorkbookSchema.safeParse(b?.data);
  return { row, book: parsed.success ? parsed.data : emptyWorkbook(), version: b?.version ?? 0 };
}

type Ctx = Parameters<Parameters<typeof defineAction>[0]["handler"]>[1];

async function store(ctx: Ctx, bookId: string, book: Workbook, version: number, name?: string) {
  const next = version + 1;
  await ctx.tx
    .insert(sheetBook)
    .values({ entityId: bookId, data: book, version: next })
    .onConflictDoUpdate({ target: sheetBook.entityId, set: { data: book, version: next } });
  await updateEntity(
    ctx,
    bookId,
    { title: name, body: workbookMarkdown(book, results(book)) },
    { type: "spreadsheet" },
  );
  return next;
}

/** "Budget!B3" or "B3" (on the first sheet). */
function target(book: Workbook, ref: string) {
  const bang = ref.lastIndexOf("!");
  const sheetName = bang >= 0 ? ref.slice(0, bang).replace(/^'|'$/g, "") : null;
  const sheet = sheetName
    ? book.sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase())
    : book.sheets[0];
  const cell = ref.slice(bang + 1).toUpperCase();
  if (!sheet) throw new ActionError("invalid_input", `No sheet named ${sheetName}`);
  if (!parseCell(cell)) throw new ActionError("invalid_input", `${cell} isn't a cell like B3`);
  return { sheet, cell };
}

export const sheetsModule = defineModule({
  name: "sheets",
  description: "Spreadsheets: workbooks with Excel-style formulas.",
  entityTypes: ["spreadsheet"],
  events: [],
  kernelEvents: ["entity.created", "entity.updated"],
  reflexes: [],
  noReflexesBecause:
    "A spreadsheet is a tool you work in; nothing in it should wake Jarvis by itself.",
  knowledge: {
    async spreadsheet(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "spreadsheet");
      return row ? describeRow(row, ["a spreadsheet; its results, sheet by sheet"]) : null;
    },
  },
  actions: [
    defineAction({
      name: "sheet.create",
      description: "Make a new spreadsheet with one empty sheet.",
      input: z.object({ title }),
      risk: "internal",
      async handler(i, ctx) {
        const row = await createEntity(ctx, { type: "spreadsheet", title: i.title, body: "" });
        await ctx.tx.insert(sheetBook).values({ entityId: row.id, data: emptyWorkbook() });
        return { id: row.id };
      },
    }),
    defineAction({
      name: "sheet.list",
      description: "Spreadsheets, most recently changed first.",
      input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      risk: "read",
      handler: (i, ctx) =>
        ctx.tx
          .select({ id: entity.id, title: entity.title, updatedAt: entity.updatedAt })
          .from(entity)
          .where(and(eq(entity.type, "spreadsheet"), isNull(entity.deletedAt)))
          .orderBy(desc(entity.updatedAt))
          .limit(i.limit),
    }),
    defineAction({
      name: "sheet.get",
      description:
        "A spreadsheet: each sheet's cells as typed (values and =formulas), their results, and the version.",
      input: z.object({ id }),
      risk: "read",
      async handler(i, ctx) {
        const b = await load(ctx.tx, i.id);
        return {
          id: i.id,
          title: b.row.title,
          book: b.book,
          results: results(b.book),
          version: b.version,
        };
      },
    }),
    defineAction({
      name: "sheet.save",
      description: "Save a whole workbook, replacing what was there. The last save wins.",
      input: z.object({ id, book: WorkbookSchema, title: title.optional() }),
      risk: "internal",
      async handler(i, ctx) {
        const b = await load(ctx.tx, i.id);
        return { id: i.id, version: await store(ctx, i.id, i.book, b.version, i.title) };
      },
    }),
    defineAction({
      name: "sheet.set",
      description:
        'Change cells: { "B3": "42", "Budget!C1": "=SUM(A1:A9)" }. Cells without a sheet name are on the first sheet; an empty string clears a cell. Add a sheet by naming it in addSheet. Returns the new results of the cells set.',
      input: z.object({
        id,
        cells: z.record(z.string().max(80), z.string().max(2000)),
        addSheet: z.string().trim().min(1).max(31).optional(),
      }),
      risk: "internal",
      async handler(i, ctx) {
        const refs = Object.keys(i.cells);
        if (refs.length > 500) throw new ActionError("invalid_input", "At most 500 cells at once");
        const b = await load(ctx.tx, i.id);
        const book = structuredClone(b.book);
        if (
          i.addSheet &&
          !book.sheets.some((s) => s.name.toLowerCase() === i.addSheet!.toLowerCase())
        )
          book.sheets.push({
            id: crypto.randomUUID().slice(0, 8),
            name: i.addSheet,
            cells: {},
            widths: {},
          });
        for (const [ref, value] of Object.entries(i.cells)) {
          const t = target(book, ref);
          if (value === "") delete t.sheet.cells[t.cell];
          else t.sheet.cells[t.cell] = value;
        }
        const checked = WorkbookSchema.safeParse(book);
        if (!checked.success)
          throw new ActionError("invalid_input", checked.error.issues[0]!.message);
        const version = await store(ctx, i.id, checked.data, b.version);
        const res = results(checked.data);
        const now: Record<string, string> = {};
        for (const ref of refs) {
          const t = target(checked.data, ref);
          now[ref] = res[checked.data.sheets.indexOf(t.sheet)]?.[t.cell] ?? "";
        }
        return { id: i.id, version, results: now };
      },
    }),
  ],
});
