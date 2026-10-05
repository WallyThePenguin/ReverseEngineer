// The registry of sub-products (D65): every view belongs to exactly one, every place keeps its
// g-key, and no view name a link might carry ever stops opening.
import { describe, expect, it } from "vitest";
import { APPS, appOf, goLabel, listFor, PLACES, paletteLabel, phoneTabs, placeOf } from "./apps.ts";
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

  it("each have their own colour, except Settings, which keeps the accent", () => {
    for (const app of APPS) {
      if (app.utility) expect(app.hue, app.id).toBeUndefined();
      else expect(app.hue, app.id).toBe(`--color-${app.id}`);
    }
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
  });

  it("keep the names the sidebar, the shortcuts sheet and Cmd+K have always used", () => {
    expect(PLACES.map((p) => p.label)).toEqual([
      "Inbox",
      "Mail",
      "Tasks",
      "Notes",
      "Calendar",
      "Canvas",
      "Spreadsheets",
      "People",
      "Memory",
      "Voice",
      "Browser",
      "Jarvis's activity",
      "Settings",
      "Trash",
    ]);
    expect(goLabel(placeOf("inbox"))).toBe("Go to Inbox");
    expect(goLabel(placeOf("browser"))).toBe("Go to the browser");
    expect(paletteLabel(placeOf("canvases"))).toBe("Go to Canvas (boards)");
    expect(paletteLabel(placeOf("trash"))).toBe("Go to the trash (restore what you deleted)");
    expect(paletteLabel(placeOf("activity"))).toBe("Go to Jarvis's activity");
  });

  it("still open from every view name a link may carry", () => {
    for (const view of LIST_VIEWS) expect(decodeRoute(view)).toEqual({ view });
    for (const view of RECORD_VIEWS) expect(decodeRoute(`${view}/${ID}`)).toEqual({ view, id: ID });
    expect(decodePath(`/inbox+task/${ID}`)).toEqual([{ view: "inbox" }, { view: "task", id: ID }]);
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
  it("shows Inbox, Tasks and Calendar, each a sub-product's home", () => {
    expect(phoneTabs().map((p) => p.label)).toEqual(["Inbox", "Tasks", "Calendar"]);
    for (const tab of phoneTabs()) expect(appOf(tab.view).views[0]).toBe(tab.view);
    const slots = APPS.flatMap((a) => (a.phoneTab === undefined ? [] : [a.phoneTab]));
    expect(new Set(slots).size).toBe(slots.length);
  });
});
