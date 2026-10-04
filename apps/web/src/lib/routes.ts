// Pane routes and how they're written in the URL: /inbox+task/0190...+note/0191...

export type ListView =
  | "inbox"
  | "mail"
  | "tasks"
  | "notes"
  | "canvases"
  | "people"
  | "calendar"
  | "memory"
  | "voice"
  | "browser"
  | "activity"
  | "settings";

export type PaneRoute =
  | { view: ListView }
  | { view: "task" | "note" | "canvas" | "record" | "chat" | "thread"; id: string };

export const MAX_PANES = 3;
const LIST_VIEWS = new Set([
  "inbox",
  "mail",
  "tasks",
  "notes",
  "canvases",
  "people",
  "calendar",
  "memory",
  "voice",
  "browser",
  "activity",
  "settings",
]);
const RECORD_VIEWS = new Set(["task", "note", "canvas", "record", "chat", "thread"]);
const ID = /^[0-9a-f-]{36}$/i;

export function encodeRoute(r: PaneRoute): string {
  return "id" in r ? `${r.view}/${r.id}` : r.view;
}

export function decodeRoute(s: string): PaneRoute | null {
  const [view, id] = s.split("/");
  if (view && LIST_VIEWS.has(view) && !id) return { view } as PaneRoute;
  if (view && RECORD_VIEWS.has(view) && id && ID.test(id)) return { view, id } as PaneRoute;
  return null;
}

export function decodePath(path: string): PaneRoute[] {
  const routes = path
    .replace(/^\/+/, "")
    .split("+")
    .map((s) => decodeRoute(decodeURIComponent(s)))
    .filter((r): r is PaneRoute => r !== null)
    .slice(0, MAX_PANES);
  return routes.length ? routes : [{ view: "inbox" }];
}

export function encodePath(routes: PaneRoute[]): string {
  return `/${routes.map(encodeRoute).join("+")}`;
}

/** Where a record of a given type opens. */
export function routeFor(type: string, id: string): PaneRoute {
  if (type === "task") return { view: "task", id };
  if (type === "note") return { view: "note", id };
  if (type === "canvas") return { view: "canvas", id };
  if (type === "conversation") return { view: "chat", id };
  if (type === "email_thread" || type === "email") return { view: "thread", id };
  return { view: "record", id };
}
