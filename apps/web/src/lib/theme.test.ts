// The theme: public/theme-boot.js, which puts it on before the page draws, and lib/theme.ts, which
// keeps it current after, agree on where it's kept, which themes there are and what "system"
// shows; and choosing one keeps it on this device and shows it at once.
// Runs against a fake browser (no DOM here), as panes.test.ts does.
import { beforeEach, describe, expect, it, vi } from "vitest";
import boot from "../../public/theme-boot.js?raw";
import { NOOK_THEMES } from "../styles/themes.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const IDS = NOOK_THEMES.map((t) => t.id);
let kept: Map<string, string>;
let root: { dataset: Record<string, string> };
let meta: { content: string; setAttribute: (k: string, v: string) => void };
let systemDark = false;
let systemChanged: ((e: { matches: boolean }) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  kept = new Map();
  root = { dataset: {} };
  meta = {
    content: "",
    setAttribute(_k, v) {
      this.content = v;
    },
  };
  systemDark = false;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => kept.set(k, v),
    removeItem: (k: string) => kept.delete(k),
  });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => meta });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: systemDark,
      addEventListener: (_: string, f: typeof systemChanged) => {
        systemChanged = f;
      },
    }),
    addEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

/** What the boot script puts on, given what's kept and the system's setting. */
function booted(stored: string | null, dark: boolean, storageOff = false): string | undefined {
  const page = { documentElement: { dataset: {} as Record<string, string> } };
  const storage = {
    getItem: (k: string) => {
      if (storageOff) throw new Error("storage is off");
      return k === "hearth.theme" ? stored : null;
    },
  };
  new Function("localStorage", "matchMedia", "document", boot)(
    storage,
    () => ({ matches: dark }),
    page,
  );
  return page.documentElement.dataset.theme;
}

describe("the boot script", () => {
  it("keeps the theme where lib/theme.ts does, and knows the same themes", async () => {
    const { THEME_KEY } = await import("./theme.ts");
    expect(boot).toContain(JSON.stringify(THEME_KEY));
    expect(boot).toContain(`const THEMES = ${JSON.stringify(IDS).replaceAll(",", ", ")};`);
  });

  it("puts on what lib/theme.ts shows, for every choice and system setting", async () => {
    const { themeFor } = await import("./theme.ts");
    for (const dark of [false, true]) {
      for (const id of IDS) expect(booted(id, dark), id).toBe(themeFor(id, dark));
      expect(booted(null, dark)).toBe(themeFor("system", dark));
    }
  });

  it("follows the system for a theme it doesn't know, or with storage turned off", () => {
    expect(booted("sepia", true)).toBe("dark");
    expect(booted("dusk", false, true)).toBe("light");
  });
});

describe("choosing a theme", () => {
  it("follows the system until you choose, then keeps yours on this device", async () => {
    systemDark = true;
    const { theme } = await import("./theme.ts");
    expect(theme.choice()).toBe("system");
    expect(root.dataset.theme).toBe("dark");
    expect(meta.content).toBe(NOOK_THEMES.find((t) => t.id === "dark")!.canvas);

    theme.choose("paper");
    expect(kept.get("hearth.theme")).toBe("paper");
    expect(root.dataset.theme).toBe("paper");
    // A change of the system's setting doesn't move a theme you chose.
    systemChanged?.({ matches: false });
    expect(root.dataset.theme).toBe("paper");

    theme.choose("system");
    expect(kept.has("hearth.theme")).toBe(false);
    expect(root.dataset.theme).toBe("light");
  });

  it("starts from the one kept on this device", async () => {
    kept.set("hearth.theme", "midnight");
    const { theme } = await import("./theme.ts");
    expect(theme.choice()).toBe("midnight");
    expect(root.dataset.theme).toBe("midnight");
  });
});
