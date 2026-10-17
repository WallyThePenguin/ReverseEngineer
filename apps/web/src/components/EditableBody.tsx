// A body you read rendered and click to edit. Saves on blur or Ctrl+Enter, with the record's
// revision so two edits never silently overwrite each other.

import { fromEditForm, toEditForm } from "@hearth/core";
import { createSignal, Show } from "solid-js";
import { Body } from "./Body.tsx";
import { MentionEditor } from "./MentionEditor.tsx";

export function EditableBody(props: {
  body: string | null;
  placeholder: string;
  save: (body: string) => Promise<boolean>;
  /** Ticks a checklist line: false when it wasn't saved. */
  onToggleLine?: (line: number) => Promise<boolean>;
  rows?: number;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let saving = false;

  const start = () => {
    setDraft(toEditForm(props.body ?? ""));
    setEditing(true);
  };
  // Ctrl+Enter saves and closes the editor, and closing it blurs the text box; the guard stops
  // that blur from saving the same text a second time with a stale revision.
  const finish = async () => {
    if (saving || !editing()) return;
    const next = fromEditForm(draft());
    if (next === (props.body ?? "")) return setEditing(false);
    saving = true;
    const ok = await props.save(next);
    if (ok) setEditing(false);
    saving = false;
  };

  return (
    <Show
      when={editing()}
      fallback={
        <div
          class="min-h-16 cursor-text rounded-md px-1 py-1 hover:bg-sunk/60"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            start();
          }}
        >
          <Show when={props.body?.trim()} fallback={<p class="text-faint">{props.placeholder}</p>}>
            <Body text={props.body} onToggle={props.onToggleLine} />
          </Show>
        </div>
      }
    >
      <MentionEditor
        value={draft()}
        onInput={setDraft}
        onSubmit={finish}
        onBlur={() => void finish()}
        rows={props.rows ?? 10}
        autofocus
        placeholder="Write… type @ to link a task, note or person, or @Pip to ask for help."
      />
      <p class="mt-1 text-xs text-faint">Saves when you click away or press Ctrl+Enter.</p>
    </Show>
  );
}

export { toggleLine } from "../lib/text.ts";
