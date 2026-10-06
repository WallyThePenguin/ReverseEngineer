// Smoke steps for the canvas and spreadsheets (M7), run from smoke.ts.
import type { Page } from "playwright";

interface Smoke {
  step: (name: string, fn: (p: Page) => Promise<void>) => Promise<void>;
  keys: (...k: string[]) => Promise<void>;
  base: string;
  tag: string;
}

export async function boardSteps({ step, keys, base, tag }: Smoke) {
  await step("a canvas board with a sticky, a box, an arrow and a task card", async (p) => {
    await p.goto(`${base}/canvases`);
    await p.getByRole("heading", { name: "Boards" }).waitFor();
    await p.getByRole("button", { name: "New board" }).click();
    // Name it and draw once the board has loaded: the toolbar shows before that, and loading sets
    // the name the board came with and frames the view, which would move what's drawn already.
    await p.getByText("Double-click anywhere to write").waitFor();
    const name = p.getByLabel("Board name");
    await name.fill(`Trip plan ${tag}`);
    await name.press("Enter");
    const board = p.locator("[data-toolbar]").locator("..");
    const box = (await board.boundingBox())!;
    await p.mouse.dblclick(box.x + 200, box.y + 250);
    await p.keyboard.type(`Book flights ${tag}`);
    await keys("Escape");
    await p.getByTitle("Box (R)").click();
    await p.mouse.click(box.x + 600, box.y + 250);
    await p.keyboard.type("Hotel");
    await keys("Escape");
    await p.getByTitle("Arrow (A)").click();
    await p.mouse.move(box.x + 200, box.y + 250);
    await p.mouse.down();
    await p.mouse.move(box.x + 400, box.y + 250, { steps: 5 });
    await p.mouse.move(box.x + 600, box.y + 250, { steps: 5 });
    await p.mouse.up();
    await p.getByRole("button", { name: "@ Record" }).click();
    await p.getByLabel("Find a record").fill(`Pay rent ${tag}`);
    await p.getByRole("button", { name: new RegExp(`Pay rent ${tag}`) }).click();
    const id = new URL(p.url()).pathname.split("canvas/")[1]!.split("+")[0]!;
    type Saved = {
      title: string;
      board: {
        nodes: { type: string }[];
        edges: { from: { type: string }; to: { type: string } }[];
      };
    };
    const read = () =>
      p.evaluate(async (id) => {
        const r = await fetch("/api/actions/canvas.get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        return ((await r.json()) as { result: Saved }).result;
      }, id);
    const kindsOf = (b: Saved) =>
      b.board.nodes
        .map((n) => n.type)
        .sort()
        .join(",");
    // The board saves a moment after the last change, later on a busy PC: read until it has.
    let saved = await read();
    for (let waited = 0; waited < 15_000; waited += 250) {
      if (
        saved.title === `Trip plan ${tag}` &&
        kindsOf(saved) === "entitymention,shape,text" &&
        saved.board.edges.length > 0
      )
        break;
      await p.waitForTimeout(250);
      saved = await read();
    }
    const kinds = kindsOf(saved);
    if (saved.title !== `Trip plan ${tag}`) throw new Error(`board named ${saved.title}`);
    if (kinds !== "entitymention,shape,text") throw new Error(`board holds ${kinds}`);
    const edge = saved.board.edges[0];
    if (edge?.from.type !== "connected" || edge?.to.type !== "connected")
      throw new Error(`arrow ${JSON.stringify(saved.board.edges)}`);
    await p.reload();
    await p.getByText(`Book flights ${tag}`).waitFor();
  });

  await step("a spreadsheet that adds up as you type", async (p) => {
    await p.goto(`${base}/sheets`);
    await p.getByRole("heading", { name: "Sheets" }).waitFor();
    await p.getByRole("button", { name: "New spreadsheet" }).click();
    await p.locator('[data-cell="A1"]').waitFor();
    const name = p.getByLabel("Spreadsheet name");
    await name.fill(`Budget ${tag}`);
    await name.press("Enter");
    await p.locator('[data-cell="A1"]').click();
    for (const v of ["1200", "300", "=SUM(A1:A2)"]) {
      await p.keyboard.type(v);
      await keys("Enter");
    }
    await p.locator('[data-cell="A3"]', { hasText: "1500" }).waitFor();
    await p.waitForTimeout(1500);
    const id = new URL(p.url()).pathname.split("sheet/")[1]!.split("+")[0]!;
    const saved = await p.evaluate(async (id) => {
      const r = await fetch("/api/actions/sheet.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      type Saved = { title: string; book: { sheets: { cells: Record<string, string> }[] } };
      return ((await r.json()) as { result: Saved & { results: Record<string, string>[] } }).result;
    }, id);
    if (saved.title !== `Budget ${tag}`) throw new Error(`spreadsheet named ${saved.title}`);
    if (saved.book.sheets[0]?.cells.A3 !== "=SUM(A1:A2)" || saved.results[0]?.A3 !== "1500")
      throw new Error(`saved ${JSON.stringify(saved)}`);
    await p.reload();
    await p.locator('[data-cell="A3"]', { hasText: "1500" }).waitFor();
  });
}
