// Settings for bringing things in: a Notion export becomes notes.

import { createSignal, Show } from "solid-js";
import { queryClient, reportError, toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";

export function ImportSettings() {
  const [busy, setBusy] = createSignal(false);

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
        files stay in Notion. Jarvis treats imported pages as outside content.
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
    </section>
  );
}
