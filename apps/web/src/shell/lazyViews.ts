// Every place but Today and Mail loads when it's first opened, so Hearth's first download is the
// shell, Today and Mail. Opening one the first time shows a skeleton while its file comes, and a
// page from before an update moves to the new Hearth rather than break (loadView.tsx).

import { view } from "./loadView.tsx";

export const Activity = view(() => import("../views/Activity.tsx").then((m) => m.Activity));
export const Browser = view(() => import("../views/Browser.tsx").then((m) => m.Browser));
export const Calendar = view(() => import("../views/Calendar.tsx").then((m) => m.Calendar));
export const Canvases = view(() => import("../views/Canvas.tsx").then((m) => m.Canvases));
export const CanvasView = view(() => import("../views/Canvas.tsx").then((m) => m.CanvasView));
export const Memory = view(() => import("../views/Memory.tsx").then((m) => m.Memory));
export const Notes = view(() => import("../views/Notes.tsx").then((m) => m.Notes));
export const NoteView = view(() => import("../views/Notes.tsx").then((m) => m.NoteView));
export const People = view(() => import("../views/People.tsx").then((m) => m.People));
export const RecordView = view(() => import("../views/Record.tsx").then((m) => m.RecordView));
export const Settings = view(() => import("../views/Settings.tsx").then((m) => m.Settings));
export const Sheets = view(() => import("../views/Sheets.tsx").then((m) => m.Sheets));
export const SheetView = view(() => import("../views/Sheets.tsx").then((m) => m.SheetView));
export const Tasks = view(() => import("../views/Tasks.tsx").then((m) => m.Tasks));
export const TaskView = view(() => import("../views/TaskView.tsx").then((m) => m.TaskView));
export const Trash = view(() => import("../views/Trash.tsx").then((m) => m.Trash));
export const Voice = view(() => import("../views/Voice.tsx").then((m) => m.Voice));
