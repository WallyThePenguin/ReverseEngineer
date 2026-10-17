// Nook's tokens as the web app loads them, checked in all six themes: the generated stylesheets
// match design/nook/tokens.json, every theme sets every colour, text reads at 4.5:1 (WCAG AA)
// where it's used, status backgrounds can be told apart, and nothing moves when the system asks
// for less motion.
import { describe, expect, it } from "vitest";
import tokensJson from "../../../../design/nook/tokens.json?raw";
import css from "../index.css?raw";
import nookCss from "../styles/nook.css?raw";
import { APPS } from "./apps.ts";
import { type NookTokens, over, renderNook, rgba } from "./nookTokens.ts";

const tokens = JSON.parse(tokensJson) as NookTokens;
const styles = import.meta.glob<string>("../styles/**/*.{css,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const source = strip(css);

/** What's between the braces of the first block that starts with `head`. */
function inside(text: string, head: string): string {
  const at = text.indexOf(head);
  if (at < 0) throw new Error(`no ${head}`);
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

/** Nook's light values, then index.css's own names for them. */
const nook = properties(inside(strip(nookCss), "@theme"));
const aliases = properties(inside(source, "@theme"));
const light = new Map([...nook, ...aliases]);

/** Each theme's variables, by id: light's, with the theme's own file over them. */
const THEMES = new Map(
  tokens.color.themes.map(({ id }, i) => {
    if (i === 0) return [id, light] as const;
    const file = styles[`../styles/themes/${id}.css`];
    if (!file) throw new Error(`styles/themes/${id}.css is missing`);
    const own = properties(inside(strip(file), `:root[data-theme="${id}"]`));
    return [id, new Map([...light, ...own])] as const;
  }),
);

/** A token's value in a theme, following var() to what it names. */
function token(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`no ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(theme, ref[1]!) : value;
}

/** The colour a token shows: one that's see-through is laid over `under` (a panel). */
function solid(theme: Map<string, string>, name: string, under = "--color-panel"): string {
  const value = token(theme, name);
  return rgba(value)[3] < 1 ? over(value, solid(theme, under, "--color-canvas")) : value;
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => rgba(hex).slice(0, 3).map(linear) as [number, number, number];

/** WCAG contrast ratio between two opaque colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** How far apart two colours look (OKLab). About 0.02 is the smallest difference people see. */
function apart(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = rgb(hex);
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

/** Checks `ratio(a, b) >= min` for each pair in every theme. */
function reads(pairs: [string, string][], min = 4.5) {
  for (const [id, theme] of THEMES) {
    for (const [text, back] of pairs) {
      const ratio = contrast(solid(theme, text), solid(theme, back));
      expect(ratio, `${text} on ${back} in ${id}`).toBeGreaterThanOrEqual(min);
    }
  }
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

describe("the generated stylesheets", () => {
  it("are what design/nook/tokens.json makes (run node scripts/nook-themes.ts)", () => {
    for (const [path, text] of Object.entries(renderNook(tokens))) {
      expect(styles[`../styles/${path}`], path).toBe(text);
    }
  });

  it("set every colour in every theme", () => {
    const colours = [...nook.keys()].filter((n) => n.startsWith("--color-"));
    for (const [id, theme] of THEMES) {
      if (theme === light) continue;
      const own = properties(inside(strip(styles[`../styles/themes/${id}.css`]!), ":root"));
      for (const name of colours) expect(own.has(name), `${name} in ${id}`).toBe(true);
    }
  });
});

describe("colours", () => {
  it("keep text readable on the canvas and every surface it sits on", () => {
    const text = ["--color-ink", "--color-ink-muted", "--color-ink-subtle"];
    const backs = ["--color-canvas", "--color-surface-1", "--color-surface-2"];
    reads(text.flatMap((t) => backs.map((b) => [t, b] as [string, string])));
  });

  it("give each sub-product an icon colour that shows on a panel (3:1, non-text)", () => {
    reads(
      APPS.filter((a) => a.hue).map((a) => [a.hue!, "--color-panel"]),
      3,
    );
  });

  it("are what a pane marked with its sub-product takes as its hue", () => {
    expect(light.get("--color-hue")).toBe("var(--color-accent)");
    for (const app of APPS.filter((a) => a.hue)) {
      const rule = properties(inside(source, `[data-product="${app.id}"]`));
      expect(rule.get("--color-hue"), app.id).toBe(`var(${app.hue})`);
    }
  });

  it("keep a badge's text readable on its own background", () => {
    reads(
      ["ok", "warn", "bad", "info", "accent", "jarvis"].map((t) => [
        `--color-${t}`,
        `--color-${t}-soft`,
      ]),
    );
  });

  it("keep text readable on a solid fill", () => {
    reads(["accent", "bad", "jarvis"].map((f) => ["--color-on-fill", `--color-${f}`]));
  });

  it("give initials eight tints that read in ink and can be told apart", () => {
    const tints = Array.from({ length: 8 }, (_, i) => `--color-avatar-${i + 1}`);
    reads(tints.map((t) => ["--color-ink", t]));
    for (const [id, theme] of THEMES) {
      for (const [i, a] of tints.entries()) {
        for (const b of tints.slice(i + 1)) {
          const gap = apart(token(theme, a), token(theme, b));
          expect(gap, `${a} and ${b} in ${id}`).toBeGreaterThanOrEqual(0.02);
        }
      }
    }
  });

  // Nook never lets colour stand alone: a status badge has a dot and a word (Paper's sienna
  // accent and amber warning are close by design). So a tint has only to show on its panel.
  it("give a badge or a highlight a tint that shows on the panel under it", () => {
    const soft = ["accent", "ok", "warn", "bad"].map((t) => `--color-${t}-soft`);
    for (const [id, theme] of THEMES) {
      for (const s of soft) {
        const gap = apart(solid(theme, s), solid(theme, "--color-panel"));
        expect(gap, `${s} in ${id}`).toBeGreaterThanOrEqual(0.02);
      }
    }
  });
});

describe("type", () => {
  it("uses the system's own font, since the CSP serves fonts only from Hearth", () => {
    expect(aliases.get("--font-sans")).toMatch(
      /^"Segoe UI Variable Text",.*system-ui, sans-serif$/,
    );
    expect(source).not.toMatch(/Inter|@font-face|url\(/);
  });

  it("is sized from the scale, never below 12 px by hand", () => {
    for (const [file, text] of code()) {
      expect(text, file).not.toMatch(/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/);
    }
  });
});

describe("text on a fill", () => {
  it("uses text-on-fill, since white on a dark theme's accent doesn't read", () => {
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
