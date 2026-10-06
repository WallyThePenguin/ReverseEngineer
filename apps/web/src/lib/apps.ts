// Hearth is Today plus six sub-products, with Settings as a utility (D65). This is the one list
// of them, and of the places you go: the sidebar, the phone's tab bar, Cmd+K, the g-keys and
// where a pane lands when its record goes to the trash all read it from here.

import type { IconName } from "../components/icons.tsx";
import type { ListView, RecordView } from "./routes.ts";

export type AppId =
  | "today"
  | "mail"
  | "calendar"
  | "tasks"
  | "docs"
  | "people"
  | "jarvis"
  | "settings";

/** A sub-product (or Settings): the views it owns, and how it looks. */
export interface App {
  id: AppId;
  label: string;
  /** Its icon (components/icons.tsx), or "mark" for Jarvis's own mark. */
  icon: IconName | "mark";
  /**
   * Its colour token in index.css. A pane or row marked `data-product="<id>"` takes it as
   * `--color-hue`. Settings has none, so it keeps the accent.
   */
  hue?: `--color-${AppId}`;
  /** The list views it owns, its home first. */
  views: readonly ListView[];
  /** The record views that open inside it. */
  records: readonly RecordView[];
  /** Settings: a utility, not a sub-product. */
  utility?: true;
  /**
   * Its slot on the phone's tab bar, counting from the left. Without one, it's behind More.
   * Jarvis's tab opens its pane, whatever list is showing; the others open their home.
   */
  phoneTab?: number;
}

export const APPS: readonly App[] = [
  {
    id: "today",
    label: "Today",
    icon: "sun",
    hue: "--color-today",
    views: ["today", "inbox"],
    records: [],
    phoneTab: 1,
  },
  {
    id: "mail",
    label: "Mail",
    icon: "mail",
    hue: "--color-mail",
    views: ["mail"],
    records: ["thread"],
    phoneTab: 2,
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: "calendar-days",
    hue: "--color-calendar",
    views: ["calendar"],
    records: [],
  },
  {
    id: "tasks",
    label: "Tasks",
    icon: "circle-check-big",
    hue: "--color-tasks",
    views: ["tasks"],
    records: ["task"],
    phoneTab: 4,
  },
  {
    id: "docs",
    label: "Docs",
    icon: "file-text",
    hue: "--color-docs",
    views: ["notes", "sheets", "canvases"],
    records: ["note", "sheet", "canvas"],
  },
  {
    id: "people",
    label: "People",
    icon: "users",
    hue: "--color-people",
    views: ["people"],
    // A record pane can hold any type (a person, a meeting, an event), and its route doesn't say
    // which, so it sits with People, whose pages are all records.
    records: ["record"],
  },
  {
    id: "jarvis",
    label: "Jarvis",
    icon: "mark",
    hue: "--color-jarvis",
    views: ["memory", "activity", "browser"],
    records: ["chat"],
    phoneTab: 3,
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    views: ["settings", "voice", "trash"],
    records: [],
    utility: true,
  },
];

/** A place you go to by name: a list view in the sidebar, in Cmd+K and on a g-key. */
export interface Place {
  view: ListView;
  /** Its name in the sidebar and on the phone's tab bar. */
  label: string;
  /** Its icon in the sidebar and on the phone's tab bar. */
  icon: IconName;
  /** The keys that go there. */
  keys: string;
  /** What follows "Go to" in the shortcuts sheet and Cmd+K, when it isn't the label. */
  go?: string;
  /** What Cmd+K adds in brackets, to say what's there. */
  about?: string;
  /** The record types it lists: a lone pane lands here once its record goes to the trash. */
  lists?: readonly string[];
}

/** In the sidebar's order. */
export const PLACES: readonly Place[] = [
  {
    view: "today",
    label: "Today",
    icon: "today",
    keys: "g h",
    about: "your morning on one screen",
  },
  {
    view: "inbox",
    label: "Updates",
    icon: "inbox",
    keys: "g i",
    about: "everything Jarvis told you",
  },
  { view: "mail", label: "Mail", icon: "mail", keys: "g e" },
  { view: "tasks", label: "Tasks", icon: "tasks", keys: "g t", lists: ["task"] },
  { view: "notes", label: "Notes", icon: "docs", keys: "g n", lists: ["note"] },
  { view: "calendar", label: "Calendar", icon: "calendar", keys: "g c" },
  {
    view: "canvases",
    label: "Canvas",
    icon: "board",
    keys: "g w",
    about: "boards",
    lists: ["canvas"],
  },
  {
    view: "sheets",
    label: "Spreadsheets",
    icon: "sheet",
    keys: "g x",
    lists: ["spreadsheet"],
  },
  {
    view: "people",
    label: "People",
    icon: "people",
    keys: "g p",
    lists: ["person", "company"],
  },
  {
    view: "memory",
    label: "Memory",
    icon: "memory",
    keys: "g m",
    about: "what Jarvis remembers",
    lists: ["memory_note"],
  },
  {
    view: "voice",
    label: "Voice",
    icon: "dictation",
    keys: "g v",
    about: "dictation history, dictionary, snippets",
  },
  {
    view: "browser",
    label: "Browser",
    icon: "browser",
    keys: "g b",
    go: "the browser",
    about: "your Chrome, live",
  },
  { view: "activity", label: "Jarvis's activity", icon: "activity", keys: "g a" },
  { view: "settings", label: "Settings", icon: "settings", keys: "g s" },
  {
    view: "trash",
    label: "Trash",
    icon: "trash-2",
    keys: "g d",
    go: "the trash",
    about: "restore what you deleted",
  },
];

/** "Go to the trash": the shortcuts sheet's name for a place. */
export const goLabel = (p: Place) => `Go to ${p.go ?? p.label}`;

/** "Go to the trash (restore what you deleted)": Cmd+K's name for a place. */
export const paletteLabel = (p: Place) => (p.about ? `${goLabel(p)} (${p.about})` : goLabel(p));

/** The sub-product (or Settings) a view belongs to. */
export function appOf(view: ListView | RecordView): App {
  const app = APPS.find((a) => [...a.views, ...a.records].includes(view));
  if (!app) throw new Error(`No app owns the view "${view}"`);
  return app;
}

/**
 * What a pane or row showing this view sets as `data-product`, so it takes its sub-product's
 * colour: none for Settings, which keeps the accent.
 */
export function productOf(view: ListView | RecordView): AppId | undefined {
  const app = appOf(view);
  return app.hue ? app.id : undefined;
}

/** The place for a list view. */
export function placeOf(view: ListView): Place {
  const place = PLACES.find((p) => p.view === view);
  if (!place) throw new Error(`No place for the view "${view}"`);
  return place;
}

/** The list a record of this type belongs in, if it has one. */
export const listFor = (type: string): ListView | undefined =>
  PLACES.find((p) => p.lists?.includes(type))?.view;

/** A tab on the phone's bar: a sub-product's home, or Jarvis, whose tab opens its pane. */
export type PhoneTab = Place | "jarvis";

/** The phone's tabs, left to right. More, for everything else, follows them. */
export const phoneTabs = (): PhoneTab[] =>
  APPS.filter((a) => a.phoneTab !== undefined)
    .sort((a, b) => a.phoneTab! - b.phoneTab!)
    .map((a) => (a.id === "jarvis" ? "jarvis" : placeOf(a.views[0]!)));
