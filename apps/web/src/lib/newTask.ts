// Cmd+K's "New task" with nothing typed: Tasks opens, its add box ready to type in.

import { createSignal } from "solid-js";
import { layout } from "./panes.ts";

const [wanted, setWanted] = createSignal(false);

/** Whether Tasks should put the cursor in its add box (and say it has, with newTaskTaken). */
export const newTaskWanted = wanted;
export const newTaskTaken = () => setWanted(false);

export function askNewTask(beside = false) {
  layout.open({ view: "tasks" }, { beside });
  setWanted(true);
}
