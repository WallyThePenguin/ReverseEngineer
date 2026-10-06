// Over the box you ask Jarvis in: the record you have open, which goes with what you ask so "this"
// means it (lib/looking.ts). It says what it is by kind and title, so you see what Jarvis will
// take "this" to be; tapping it leaves it out.

import { Icon } from "../components/icons.tsx";
import { Pill } from "../components/kit/Pill.tsx";
import { TYPE_LABEL } from "../lib/format.ts";
import { KIND_OF_VIEW, type Looking } from "../lib/looking.ts";
import { useAction } from "../lib/query.ts";
import type { Entity } from "../lib/types.ts";

/** The record's kind and title, as the chip says it: "Task · Book the dentist". */
export function useLookingRecord(looking: () => Looking | null) {
  const rec = useAction<Entity>(
    "entity.get",
    () => ({ id: looking()?.id }),
    () => !!looking(),
  );
  const type = () => rec.data?.type ?? KIND_OF_VIEW[looking()?.view ?? ""];
  return {
    type,
    label: () => {
      const kind = TYPE_LABEL[type() ?? ""] ?? "Record";
      const title = rec.data?.title?.trim();
      return title ? `${kind} · ${title}` : kind;
    },
  };
}

export function LookingChip(props: { label: string; onTakeOff: () => void }) {
  return (
    <Pill
      tone="jarvis"
      icon="paperclip"
      class="max-w-full"
      title="Jarvis is told you have this open, so “this” means it. Tap to leave it out."
      onClick={() => props.onTakeOff()}
    >
      <span class="min-w-0 truncate">{props.label}</span>
      <Icon name="x" size={12} label="Leave it out" />
    </Pill>
  );
}
