// The look's tokens in index.css, checked in light and dark mode: every colour has a dark value,
// text reads at 4.5:1 (WCAG AA) where it's used, status backgrounds can be told apart, and
// nothing moves when the system asks for less motion.
import { describe, expect, it } from "vitest";
import css from "../index.css?raw";
import { APPS } from "./apps.ts";

const source = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** What's between the braces of the first block that starts with `head`. */
function inside(text: string, head: string): string {
  const at = text.indexOf(head);
  if (at < 0) throw new Error(`index.css has no ${head}`);
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`${head} isn't closed`);
}

/** A block's own custom properties, leaving out those of blocks inside it (keyframes). */
function properties(body: string): Map<string, string> {
  let own = body;
  while (/\{[^{}]*\}/.test(own)) own = own.replace(/[^{};]*\{[^{}]*\}/g, "");
  return new Map([...own.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const light = properties(inside(source, "@theme"));
const darkOnly = properties(inside(inside(source, "@media (prefers-color-scheme: dark)"), ":root"));
const dark = new Map([...light, ...darkOnly]);
const MODES = { light, dark };

/** A token's value in a mode, following var() to what it names. */
function token(mode: Map<string, string>, name: string): string {
  const value = mode.get(name);
  if (value === undefined) throw new Error(`index.css has no ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(mode, ref[1]!) : value;
}

function channels(hex: string): number[] {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`${hex} isn't a hex colour`);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
}
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = channels(hex).map(linear) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** How far apart two colours look (OKLab). About 0.02 is the smallest difference people see. */
function apart(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = channels(hex).map(linear) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(...x.map((v, i) => v - y[i]!));
}

/** The web app's own source, tests left out. */
function code(): [string, string][] {
  const files = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  expect(Object.keys(files).length).toBeGreaterThan(50);
  return Object.entries(files);
}

describe("colours", () => {
  it("each have a dark value", () => {
    for (const [name, value] of light) {
      if (name.startsWith("--color-") && !value.startsWith("var(")) {
        expect(darkOnly.has(name), `${name} has no dark value`).toBe(true);
      }
    }
  });

  it("give each sub-product a colour that reads on a panel, light and dark", () => {
    for (const app of APPS.filter((a) => a.hue)) {
      for (const [mode, values] of Object.entries(MODES)) {
        const ratio = contrast(token(values, app.hue!), token(values, "--color-panel"));
        expect(ratio, `${app.id} in ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("are what a pane marked with its sub-product takes as its hue", () => {
    expect(light.get("--color-hue")).toBe("var(--color-accent)");
    for (const app of APPS.filter((a) => a.hue)) {
      const rule = properties(inside(source, `[data-product="${app.id}"]`));
      expect(rule.get("--color-hue"), app.id).toBe(`var(${app.hue})`);
    }
  });

  it("keep a badge's text readable on its own background", () => {
    for (const tone of ["ok", "warn", "bad", "info", "accent", "jarvis"]) {
      for (const [mode, values] of Object.entries(MODES)) {
        const ratio = contrast(
          token(values, `--color-${tone}`),
          token(values, `--color-${tone}-soft`),
        );
        expect(ratio, `${tone} in ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keep text readable on a solid fill, light and dark", () => {
    for (const fill of ["accent", "bad", "jarvis"]) {
      for (const [mode, values] of Object.entries(MODES)) {
        const ratio = contrast(token(values, "--color-on-fill"), token(values, `--color-${fill}`));
        expect(ratio, `${fill} in ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("give initials eight tints that read in ink and can be told apart", () => {
    const tints = Array.from({ length: 8 }, (_, i) => `--color-avatar-${i + 1}`);
    for (const [mode, values] of Object.entries(MODES)) {
      for (const [i, a] of tints.entries()) {
        const ratio = contrast(token(values, "--color-ink"), token(values, a));
        expect(ratio, `${a} in ${mode}`).toBeGreaterThanOrEqual(4.5);
        for (const b of tints.slice(i + 1)) {
          const gap = apart(token(values, a), token(values, b));
          expect(gap, `${a} and ${b} in ${mode}`).toBeGreaterThanOrEqual(0.02);
        }
      }
    }
  });

  it("tell a warning, a failure and the accent highlight apart", () => {
    const soft = ["accent", "ok", "warn", "bad", "info"].map((t) => `--color-${t}-soft`);
    for (const [mode, values] of Object.entries(MODES)) {
      for (const [i, a] of soft.entries()) {
        for (const b of soft.slice(i + 1)) {
          const gap = apart(token(values, a), token(values, b));
          expect(gap, `${a} and ${b} in ${mode}`).toBeGreaterThanOrEqual(0.02);
        }
      }
    }
  });
});

describe("type", () => {
  it("uses the system's own font, since the CSP serves fonts only from Hearth", () => {
    expect(light.get("--font-sans")).toMatch(/^"Segoe UI Variable Text",.*system-ui, sans-serif$/);
    expect(source).not.toMatch(/Inter|@font-face|url\(/);
  });

  it("is sized from the scale, never 10 or 11 px by hand", () => {
    for (const [file, text] of code()) expect(text, file).not.toMatch(/text-\[1[01]px\]/);
  });
});

describe("text on a fill", () => {
  it("uses text-on-fill, since white on the dark-mode accent reads at 2.8:1", () => {
    for (const [file, text] of code()) expect(text, file).not.toMatch(/\btext-white\b/);
  });
});

describe("motion", () => {
  it("ends at once, everywhere, when the system asks for less", () => {
    const reduced = inside(source, "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/^\s*\*,\s*::before,\s*::after\s*\{/);
    // A looping animation (the pulsing "Thinking…" dot) must stop, not flicker every 1ms.
    for (const rule of [
      "animation-duration: 1ms",
      "animation-iteration-count: 1",
      "transition-duration: 1ms",
    ]) {
      expect(reduced).toContain(`${rule} !important`);
    }
  });
});
