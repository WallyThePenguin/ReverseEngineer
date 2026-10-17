// Settings for bringing things in: a Notion export becomes notes.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { queryClient, reportError, toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { restore } from "../lib/trash.ts";

interface NotionImport {
  id: string;
  title: string;
  createdAt: string;
  trashedAt: string | null;
}

/** Moves a whole import to the trash, with an Undo; restoring its page brings it all back. */
export async function undoImport(id: string): Promise<boolean> {
  const r = await act<{ trashed: number }>("notion.undo_import", { id });
  if (!r) return false;
  const n = r.trashed;
  toast.show(`Moved the import's ${n} note${n === 1 ? "" : "s"} to the trash.`, "info", {
    label: "Undo",
    run: () => void restore(id),
  });
  return true;
}

export function ImportSettings() {
  const [busy, setBusy] = createSignal(false);
  const imports = useAction<NotionImport[]>("notion.imports", () => ({ limit: 20 }));

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/import/notion?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/zip" },
        body: file,
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        pages?: number;
        databases?: number;
        error?: string;
      };
      if (!res.ok || !body.id) throw new Error(body.error ?? "The import failed.");
      toast.show(
        `Imported ${body.pages} page${body.pages === 1 ? "" : "s"} and ${body.databases} database${body.databases === 1 ? "" : "s"} from Notion.`,
      );
      void queryClient.invalidateQueries();
      layout.open({ view: "note", id: body.id }, { beside: true });
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Import</h2>
      <p class="text-sm text-muted">
        Bring your Notion pages in as notes. In Notion, choose Export, pick "Markdown & CSV" with
        subpages included, and upload the zip here. Links between pages become @mentions; images and
        files stay in Notion. Pip treats imported pages as outside content.
      </p>
      <label class="inline-flex cursor-pointer items-center gap-2 rounded-md bg-sunk px-3 py-2 text-sm">
        <input
          type="file"
          accept=".zip,application/zip"
          class="hidden"
          aria-label="Notion export zip"
          disabled={busy()}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
        <Show when={busy()} fallback="Upload a Notion export…">
          Importing…
        </Show>
      </label>
      <Show when={(imports.data ?? []).length > 0}>
        <ul class="divide-y divide-line rounded-md border border-line text-sm">
          <For each={imports.data}>
            {(i) => (
              <li class="flex items-center gap-3 px-3 py-2">
                <div class="min-w-0 flex-1">
                  <button
                    type="button"
                    class="block max-w-full truncate text-left hover:underline disabled:no-underline"
                    disabled={i.trashedAt !== null}
                    onClick={() => layout.open({ view: "note", id: i.id }, { beside: true })}
                  >
                    {i.title}
                  </button>
                  <p class="text-xs text-muted">
                    Imported {ago(i.createdAt)}
                    {i.trashedAt ? ` · undone ${ago(i.trashedAt)}, in the trash` : ""}
                  </p>
                </div>
                <Show
                  when={i.trashedAt}
                  fallback={
                    <Button small kind="danger" onClick={() => void undoImport(i.id)}>
                      Undo this import
                    </Button>
                  }
                >
                  <Button small onClick={() => void restore(i.id)}>
                    Restore
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
