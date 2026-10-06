// Every place but Today and Mail loads when it's first opened, so Hearth's first download is the
// shell, Today and Mail. Opening one the first time waits a moment for its file.

import { lazy } from "solid-js";

export const Activity = lazy(() =>
  import("../views/Activity.tsx").then((m) => ({ default: m.Activity })),
);
export const Browser = lazy(() =>
  import("../views/Browser.tsx").then((m) => ({ default: m.Browser })),
);
export const Calendar = lazy(() =>
  import("../views/Calendar.tsx").then((m) => ({ default: m.Calendar })),
);
export const Canvases = lazy(() =>
  import("../views/Canvas.tsx").then((m) => ({ default: m.Canvases })),
);
export const CanvasView = lazy(() =>
  import("../views/Canvas.tsx").then((m) => ({ default: m.CanvasView })),
);
export const Memory = lazy(() =>
  import("../views/Memory.tsx").then((m) => ({ default: m.Memory })),
);
export const Notes = lazy(() => import("../views/Notes.tsx").then((m) => ({ default: m.Notes })));
export const NoteView = lazy(() =>
  import("../views/Notes.tsx").then((m) => ({ default: m.NoteView })),
);
export const People = lazy(() =>
  import("../views/People.tsx").then((m) => ({ default: m.People })),
);
export const RecordView = lazy(() =>
  import("../views/Record.tsx").then((m) => ({ default: m.RecordView })),
);
export const Settings = lazy(() =>
  import("../views/Settings.tsx").then((m) => ({ default: m.Settings })),
);
export const Sheets = lazy(() =>
  import("../views/Sheets.tsx").then((m) => ({ default: m.Sheets })),
);
export const SheetView = lazy(() =>
  import("../views/Sheets.tsx").then((m) => ({ default: m.SheetView })),
);
export const Tasks = lazy(() => import("../views/Tasks.tsx").then((m) => ({ default: m.Tasks })));
export const TaskView = lazy(() =>
  import("../views/TaskView.tsx").then((m) => ({ default: m.TaskView })),
);
export const Trash = lazy(() => import("../views/Trash.tsx").then((m) => ({ default: m.Trash })));
export const Voice = lazy(() => import("../views/Voice.tsx").then((m) => ({ default: m.Voice })));
