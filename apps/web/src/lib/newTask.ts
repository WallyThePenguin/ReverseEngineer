// "New task" from Cmd+K, or from Today's box: Tasks opens, its add box ready to type in, starting
// from what you'd typed on Today.

import { createSignal } from "solid-js";
import { layout } from "./panes.ts";

/** What the add box starts with ("" for nothing), or null when nothing's asked. */
const [wanted, setWanted] = createSignal<string | null>(null);

/** Whether Tasks should put the cursor in its add box (and take it, with newTaskTaken). */
export const newTaskWanted = () => wanted() !== null;

/** Says Tasks has it, and gives what was typed for it ("" for nothing). */
export function newTaskTaken(): string {
  const typed = wanted() ?? "";
  setWanted(null);
  return typed;
}

export function askNewTask(beside = false, typed = "") {
  layout.open({ view: "tasks" }, { beside });
  setWanted(typed);
}
