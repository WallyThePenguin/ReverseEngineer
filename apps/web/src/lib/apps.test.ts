// The registry of sub-products (D65): every view belongs to exactly one, every place keeps its
// g-key, and no view name a link might carry ever stops opening.
import { describe, expect, it } from "vitest";
import {
  APPS,
  appOf,
  goLabel,
  listFor,
  PLACES,
  paletteLabel,
  phoneTabs,
  placeOf,
  productOf,
} from "./apps.ts";
import { decodePath, decodeRoute, LIST_VIEWS, RECORD_VIEWS } from "./routes.ts";

const ID = "01a0f976-b334-7462-a9ca-bd9b458c8a2c";

describe("the sub-products", () => {
  it("are Today and six more, with Settings as a utility", () => {
    expect(APPS.filter((a) => !a.utility).map((a) => a.id)).toEqual([
      "today",
      "mail",
      "calendar",
      "tasks",
      "docs",
      "people",
      "jarvis",
    ]);
    expect(APPS.filter((a) => a.utility).map((a) => a.id)).toEqual(["settings"]);
  });

  it("give every list view to exactly one of them or Settings", () => {
    for (const view of LIST_VIEWS) {
      const owners = APPS.filter((a) => a.views.includes(view)).map((a) => a.id);
      expect(owners, view).toHaveLength(1);
      expect(appOf(view).id).toBe(owners[0]);
    }
  });

  it("give every record view to exactly one of them", () => {
    for (const view of RECORD_VIEWS) {
      const owners = APPS.filter((a) => a.records.includes(view)).map((a) => a.id);
      expect(owners, view).toHaveLength(1);
    }
    expect(appOf("note").id).toBe("docs");
    expect(appOf("chat").id).toBe("jarvis");
    expect(appOf("thread").id).toBe("mail");
  });

  it("open Jarvis on what it did, with Memory and Chrome as its other tabs", () => {
    expect(appOf("activity").views).toEqual(["activity", "memory", "browser"]);
    // The other tabbed ones: Docs, Today and Settings.
    expect(appOf("notes").views).toEqual(["notes", "sheets", "canvases"]);
    expect(appOf("settings").views).toEqual(["settings", "voice", "trash"]);
  });

  it("make Today the Today app's home, with the inbox beside it", () => {
    expect(appOf("today").views).toEqual(["today", "inbox"]);
    expect(appOf("inbox").id).toBe("today");
    expect(productOf("today")).toBe("today");
  });

  it("each have their own colour, except Settings, which keeps the accent", () => {
    for (const app of APPS) {
      if (app.utility) expect(app.hue, app.id).toBeUndefined();
      else expect(app.hue, app.id).toBe(`--color-${app.id}`);
    }
  });

  it("colour a view by its sub-product, and leave Settings' views the accent", () => {
    for (const view of [...LIST_VIEWS, ...RECORD_VIEWS]) {
      const app = appOf(view);
      expect(productOf(view), view).toBe(app.utility ? undefined : app.id);
    }
    expect(productOf("canvases")).toBe("docs");
    expect(productOf("trash")).toBeUndefined();
  });
});

describe("places", () => {
  it("list every list view once, in the sidebar", () => {
    expect(PLACES.map((p) => p.view).sort()).toEqual([...LIST_VIEWS].sort());
  });

  it("each have their own g-key", () => {
    const keys = PLACES.map((p) => p.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^g [a-z]$/);
    // The ones fingers already know.
    expect(Object.fromEntries(PLACES.map((p) => [p.view, p.keys]))).toEqual({
      today: "g h",
      inbox: "g i",
      mail: "g e",
      tasks: "g t",
      notes: "g n",
      calendar: "g c",
      canvases: "g w",
      sheets: "g x",
      people: "g p",
      memory: "g m",
      voice: "g v",
      browser: "g b",
      activity: "g a",
      settings: "g s",
      trash: "g d",
    });
  });

  it("are named as their tabs are, in the shortcuts sheet and Cmd+K too", () => {
    expect(PLACES.map((p) => p.label)).toEqual([
      "Today",
      "Updates",
      "Mail",
      "Tasks",
      "Notes",
      "Calendar",
      "Boards",
      "Sheets",
      "People",
      "Memory",
      "Dictation",
      "Chrome",
      "What Pip did",
      "Settings",
      "Trash",
    ]);
    expect(PLACES.map(goLabel)).toEqual([
      "Go to Today",
      "Go to Updates",
      "Go to Mail",
      "Go to Tasks",
      "Go to Notes",
      "Go to Calendar",
      "Go to Boards",
      "Go to Sheets",
      "Go to People",
      "Go to Memory",
      "Go to Dictation",
      "Go to Chrome",
      "Go to what Pip did",
      "Go to Settings",
      "Go to the trash",
    ]);
    expect(PLACES.map(paletteLabel)).toEqual([
      "Go to Today (your morning on one screen)",
      "Go to Updates (everything Pip told you)",
      "Go to Mail",
      "Go to Tasks",
      "Go to Notes",
      "Go to Calendar",
      "Go to Boards (canvas boards)",
      "Go to Sheets (spreadsheets)",
      "Go to People",
      "Go to Memory (what Pip remembers)",
      "Go to Dictation (dictation history, dictionary, snippets)",
      "Go to Chrome (your Chrome, live)",
      "Go to what Pip did",
      "Go to Settings",
      "Go to the trash (restore what you deleted)",
    ]);
    expect(goLabel(placeOf("activity"))).toBe("Go to what Pip did");
  });

  it("still open from every view name a link may carry", () => {
    for (const view of LIST_VIEWS) expect(decodeRoute(view)).toEqual({ view });
    for (const view of RECORD_VIEWS) expect(decodeRoute(`${view}/${ID}`)).toEqual({ view, id: ID });
    expect(decodePath(`/inbox+task/${ID}`)).toEqual([{ view: "inbox" }, { view: "task", id: ID }]);
    expect(decodePath("/today")).toEqual([{ view: "today" }]);
    // Hearth opens on Today; /inbox still opens Updates.
    expect(decodePath("/")).toEqual([{ view: "today" }]);
    expect(decodePath("/nonsense")).toEqual([{ view: "today" }]);
    expect(decodePath("/inbox")).toEqual([{ view: "inbox" }]);
  });

  it("send a lone pane to the list its trashed record was in", () => {
    expect(listFor("task")).toBe("tasks");
    expect(listFor("spreadsheet")).toBe("sheets");
    expect(listFor("company")).toBe("people");
    expect(listFor("memory_note")).toBe("memory");
    expect(listFor("conversation")).toBeUndefined();
    const types = PLACES.flatMap((p) => p.lists ?? []);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("the phone's tab bar", () => {
  it("shows Today, Mail, Jarvis in the middle and Tasks, each a sub-product's home", () => {
    const names = phoneTabs().map((t) => (t === "jarvis" ? "Jarvis" : t.label));
    expect(names).toEqual(["Today", "Mail", "Jarvis", "Tasks"]);
    for (const tab of phoneTabs())
      if (tab !== "jarvis") expect(appOf(tab.view).views[0]).toBe(tab.view);
    // Calendar is behind More.
    expect(APPS.find((a) => a.id === "calendar")?.phoneTab).toBeUndefined();
    const slots = APPS.flatMap((a) => (a.phoneTab === undefined ? [] : [a.phoneTab]));
    expect(new Set(slots).size).toBe(slots.length);
  });
});
