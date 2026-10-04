// Reading a Notion export ("Markdown & CSV"): each page is a .md file named "Title <32 hex>.md",
// its subpages sit in a folder of the same name, and a database is a .csv (with "_all.csv" for
// every row) beside a folder of its row pages. Links between pages are relative paths, which
// become @mentions of the imported notes.

export interface ImportFile {
  path: string;
  text: string;
}

export interface PlannedPage {
  id: string;
  key: string;
  title: string;
  body: string;
  parentKey: string | null;
  database: boolean;
}

export const MAX_PAGES = 5000;
const MAX_BODY = 200_000;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 30;
const NOTION_ID = /\s+[0-9a-f]{32}$/i;

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const plainName = (key: string) => basename(key).replace(NOTION_ID, "").trim() || "Untitled";

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Text that came from Notion can't carry Hearth's own link tags. */
const defuse = (s: string) => s.replace(/<(\/?m-ref)/gi, "‹$1");
/** Stands in for "<" in the tags the import writes, until the page's own text is defused. */
const OPEN = "\uE000";
const labelText = (s: string) => s.replace(/[<>]/g, "").trim() || "link";

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function table(rows: string[][]): string {
  const [head, ...rest] = rows;
  if (!head) return "";
  const cols = head.slice(0, MAX_COLUMNS);
  const cell = (s = "") =>
    defuse(s)
      .replace(/\|/g, "\\|")
      .replace(/\s*\n\s*/g, " ");
  const line = (r: string[]) => `| ${cols.map((_, i) => cell(r[i])).join(" | ")} |`;
  const out = [line(cols), `| ${cols.map(() => "---").join(" | ")} |`];
  for (const r of rest.slice(0, MAX_ROWS)) out.push(line(r));
  if (rest.length > MAX_ROWS) out.push("", `(${rest.length - MAX_ROWS} more rows not imported)`);
  return out.join("\n");
}

/** Works out the notes to make, parents first, with links between them as @mentions. */
export function planImport(files: ImportFile[], newId: () => string): PlannedPage[] {
  const pages = new Map<string, PlannedPage>();
  const sources = new Map<string, { path: string; text: string }>();
  if (files.length > MAX_PAGES * 2)
    throw new Error(`That export has more than ${MAX_PAGES} pages.`);
  const csv = files.filter((f) => f.path.toLowerCase().endsWith(".csv"));
  const csvPaths = new Set(csv.map((f) => normalize(f.path)));
  for (const f of files) {
    const path = normalize(f.path);
    if (path.toLowerCase().endsWith(".md")) {
      const key = path.slice(0, -3);
      const heading = /^#\s+(.+)$/m.exec(f.text.slice(0, 2000));
      pages.set(key, {
        id: newId(),
        key,
        title: (heading?.[1]?.trim() || plainName(key)).slice(0, 500),
        body: "",
        parentKey: null,
        database: false,
      });
      sources.set(key, { path, text: f.text });
    }
  }
  for (const f of csv) {
    const path = normalize(f.path);
    const all = path.endsWith("_all.csv");
    const key = path.slice(0, all ? -8 : -4);
    // "_all.csv" has every row; the plain one only the current view's.
    if (!all && csvPaths.has(`${key}_all.csv`)) continue;
    if (pages.has(key) && !pages.get(key)!.database) continue;
    pages.set(key, {
      id: newId(),
      key,
      title: plainName(key).slice(0, 500),
      body: table(parseCsv(f.text)),
      parentKey: null,
      database: true,
    });
  }
  if (pages.size > MAX_PAGES) throw new Error(`That export has more than ${MAX_PAGES} pages.`);

  for (const p of pages.values()) {
    // A page's folder is named like the page it belongs to (a parent page or a database).
    let dir = dirname(p.key);
    while (dir && !pages.has(dir)) dir = dirname(dir);
    p.parentKey = dir || null;
  }

  for (const [key, src] of sources) {
    const page = pages.get(key)!;
    const here = dirname(src.path);
    let text = src.text.slice(0, MAX_BODY * 2).replaceAll(OPEN, "");
    // The title is the note's title, not its first line.
    text = text.replace(/^\s*#\s+.+\n?/, "");
    // Labels stop at a bracket or line end, so a page of "[" can't make this slow.
    text = text.replace(
      /(!?)\[([^[\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g,
      (whole, bang: string, label: string, href: string) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return whole;
        let target: string;
        try {
          target = normalize(`${here}/${decodeURIComponent(href)}`);
        } catch {
          return label;
        }
        const linked = pages.get(target.replace(/(_all)?\.(md|csv)$/i, ""));
        if (linked && !bang)
          return `${OPEN}m-ref type="note" id="${linked.id}">${labelText(label || linked.title)}${OPEN}/m-ref>`;
        if (bang || !/\.(md|csv)$/i.test(target))
          return `*(attachment left in Notion: ${labelText(basename(target))})*`;
        return label;
      },
    );
    // Only the tags written above are real: anything in the page that reads as one is defused,
    // including one pieced together around a link.
    page.body = defuse(text).replaceAll(OPEN, "<").trim().slice(0, MAX_BODY);
  }

  const depth = (p: PlannedPage) => {
    let d = 0;
    for (let k = p.parentKey; k; k = pages.get(k)?.parentKey ?? null) d++;
    return d;
  };
  return [...pages.values()].sort((a, b) => depth(a) - depth(b) || a.key.localeCompare(b.key));
}
