// The Undo on Jarvis's note about something it did on its own (D71, D72): one press, which says
// exactly what it puts back. Pressing it doesn't open the row.

import { createSignal, Show } from "solid-js";
import { Button } from "../../components/ui.tsx";
import { act } from "../../lib/query.ts";
import type { InboxRow } from "../../lib/types.ts";
import { undoLabel } from "../../lib/undo.ts";

export function UndoButton(props: { row: InboxRow }) {
  const [busy, setBusy] = createSignal(false);
  const undo = async () => {
    setBusy(true);
    await act("calendar.undo", { notificationId: props.row.notification.id });
    setBusy(false);
  };
  return (
    <Show when={undoLabel(props.row)}>
      {(label) => (
        <div class="mt-2" onClick={(e) => e.stopPropagation()}>
          <Button small disabled={busy()} onClick={() => void undo()}>
            {label()}
          </Button>
        </div>
      )}
    </Show>
  );
}
