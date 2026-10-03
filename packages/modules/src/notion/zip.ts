// Opening a Notion export zip. Big exports come as a zip of zips ("Part-1.zip"...), opened one
// level down. Only pages and databases are read; images and files stay behind.
import { strFromU8, unzipSync } from "fflate";
import type { ImportFile } from "./parse.ts";

const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export class ExportError extends Error {}

export function readExport(zip: Uint8Array): ImportFile[] {
  let total = 0;
  let count = 0;
  const out: ImportFile[] = [];
  const open = (bytes: Uint8Array, depth: number) => {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        // Sizes are checked before anything is inflated, so a zip bomb never expands.
        filter: (f) => {
          const name = f.name.toLowerCase();
          const wanted =
            name.endsWith(".md") || name.endsWith(".csv") || (depth === 0 && name.endsWith(".zip"));
          if (!wanted) return false;
          // A stored entry is copied at its stored size whatever size it claims, so both count,
          // and one that claims a different size isn't a real export.
          if (f.compression === 0 && f.size !== f.originalSize)
            throw new ExportError("That isn't a zip file Hearth can open.");
          const size = Math.max(f.size, f.originalSize);
          if (!name.endsWith(".zip") && size > MAX_FILE) return false;
          total += size;
          count += 1;
          if (total > MAX_TOTAL || count > MAX_ENTRIES)
            throw new ExportError("That export is too big to import at once.");
          return true;
        },
      });
    } catch (err) {
      if (err instanceof ExportError) throw err;
      throw new ExportError("That isn't a zip file Hearth can open.");
    }
    for (const [name, data] of Object.entries(entries)) {
      if (name.toLowerCase().endsWith(".zip")) open(data, depth + 1);
      else out.push({ path: name, text: strFromU8(data) });
    }
  };
  open(zip, 0);
  return out;
}
