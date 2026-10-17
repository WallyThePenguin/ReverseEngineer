// Turns Nook's design-system tokens (design/nook/tokens.json) into the stylesheets the web app
// loads: styles/nook.css (the Tailwind @theme, light values, every variable emitted even if no
// utility uses it, since views and canvases read them by name), one styles/themes/<id>.css per
// other theme, and styles/themes.ts, each theme's name and the colours a swatch of it shows.
// scripts/nook-themes.ts writes them; lib/tokens.test.ts checks they're current.

export interface NookTokens {
  color: {
    themes: { id: string; name: string }[];
    tokens: { name: string; value: string | Record<string, string>; usage?: string }[];
  };
  type: {
    groups: {
      name: string;
      styles: {
        name: string;
        fontSize: string;
        lineHeight: string;
        fontWeight: number | string;
        letterSpacing?: string;
      }[];
    }[];
  };
  radius: { tokens: Token[] };
  shadow: { tokens: { name: string; value: string | Record<string, string> }[] };
  size: { tokens: Token[] };
  blur: { tokens: Token[] };
  timing: { tokens: Token[] };
  zIndex: { tokens: Token[] };
}
interface Token {
  name: string;
  value: string;
}

/** Themes whose canvas is dark: they get dark form controls and the dark avatar tints. */
export const DARK_THEMES = new Set(["dark", "midnight", "dusk"]);

/** Initials' backgrounds, Hearth's own (Nook has none): quiet tints that read in ink. */
const AVATARS = {
  light: ["#cee9fd", "#c7eded", "#d3edd7", "#e8e7c8", "#f9dfcb", "#fedadc", "#f5dcf2", "#e1e1ff"],
  dark: ["#1e384a", "#143d3c", "#243c29", "#39371a", "#46301d", "#4a2c2e", "#432d40", "#33324c"],
};

/** How much of a status colour tints its badge background, over a window's surface. */
const SOFT = 0.14;

const HEADER = (what: string) =>
  `/* ${what}: generated from design/nook/tokens.json by scripts/nook-themes.ts.\n   Don't edit by hand; change tokens.json and run \`node scripts/nook-themes.ts\`. */\n`;

/** `#rgb`, `#rrggbb` or `#rrggbbaa` to [r, g, b, a] in 0..1. */
export function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) throw new Error(`${hex} isn't a hex colour`);
  const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4), full.length === 8 ? at(6) : 1];
}

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");

/** `top` laid over the opaque `under`, as an opaque `#rrggbb`. `alpha` overrides top's own. */
export function over(top: string, under: string, alpha?: number): string {
  const [r, g, b, a] = rgba(top);
  const [ur, ug, ub] = rgba(under);
  const k = alpha ?? a;
  return `#${hex2(r * k + ur * (1 - k))}${hex2(g * k + ug * (1 - k))}${hex2(b * k + ub * (1 - k))}`;
}

const rem = (px: string) => {
  const n = Number.parseFloat(px);
  return px.endsWith("px") ? `${+(n / 16).toFixed(4)}rem` : px;
};

/** A token's value in one theme: its own, else the first theme's; `{x}` names another token. */
function valueIn(tokens: NookTokens, name: string, theme: string): string {
  const t = tokens.color.tokens.find((c) => c.name === name);
  if (!t) throw new Error(`tokens.json has no colour ${name}`);
  const first = tokens.color.themes[0]!.id;
  const v = typeof t.value === "string" ? t.value : (t.value[theme] ?? t.value[first]!);
  const alias = /^\{([\w.-]+)\}$/.exec(v);
  return alias ? valueIn(tokens, alias[1]!, theme) : v;
}

function colourLines(tokens: NookTokens, theme: string): string[] {
  const first = tokens.color.themes[0]!.id;
  return tokens.color.tokens.map((t) => {
    const v = typeof t.value === "string" ? t.value : (t.value[theme] ?? t.value[first]!);
    const alias = /^\{([\w.-]+)\}$/.exec(v);
    return `  --color-${t.name}: ${alias ? `var(--color-${alias[1]})` : v};`;
  });
}

/** Hearth's own colours that follow the theme: status badge tints and initials' tints. */
function hearthLines(tokens: NookTokens, theme: string): string[] {
  const surface = valueIn(tokens, "surface-1", theme);
  const soft = (status: string) => over(valueIn(tokens, status, theme), surface, SOFT);
  const avatars = DARK_THEMES.has(theme) ? AVATARS.dark : AVATARS.light;
  return [
    `  --color-ok-soft: ${soft("positive")};`,
    `  --color-warn-soft: ${soft("warning")};`,
    `  --color-bad-soft: ${soft("danger")};`,
    ...avatars.map((v, i) => `  --color-avatar-${i + 1}: ${v};`),
  ];
}

function shadowLines(tokens: NookTokens, theme: string): string[] {
  const first = tokens.color.themes[0]!.id;
  return tokens.shadow.tokens.map((t) => {
    const v = typeof t.value === "string" ? t.value : (t.value[theme] ?? t.value[first]!);
    return `  --elevation-${t.name.replace(/^shadow-/, "")}: ${v};`;
  });
}

/** Every generated stylesheet, by its path under apps/web/src/styles/. */
export function renderNook(tokens: NookTokens): Record<string, string> {
  const first = tokens.color.themes[0]!.id;
  const theme: string[] = [
    "@theme static {",
    ...colourLines(tokens, first),
    ...hearthLines(tokens, first),
  ];
  for (const group of tokens.type.groups) {
    for (const s of group.styles) {
      const n = `--text-${s.name}`;
      theme.push(`  ${n}: ${rem(s.fontSize)};`, `  ${n}--line-height: ${rem(s.lineHeight)};`);
      theme.push(`  ${n}--font-weight: ${s.fontWeight};`);
      if (s.letterSpacing) theme.push(`  ${n}--letter-spacing: ${s.letterSpacing};`);
    }
  }
  for (const t of tokens.radius.tokens) theme.push(`  --${t.name}: ${rem(t.value)};`);
  for (const t of tokens.shadow.tokens) {
    theme.push(`  --${t.name}: var(--elevation-${t.name.replace(/^shadow-/, "")});`);
  }
  for (const t of tokens.blur.tokens) theme.push(`  --${t.name}: ${t.value};`);
  for (const t of tokens.size.tokens) theme.push(`  --spacing-${t.name}: ${t.value};`);
  for (const t of tokens.timing.tokens) {
    theme.push(`  --${t.name.replace(/^dur-/, "duration-")}: ${t.value};`);
  }
  theme.push("}");
  const root = [":root {", "  color-scheme: light;", ...shadowLines(tokens, first)];
  for (const t of tokens.zIndex.tokens) root.push(`  --${t.name}: ${t.value};`);
  root.push("}");

  const files: Record<string, string> = {
    "nook.css": `${HEADER("Nook's tokens, light values")}${theme.join("\n")}\n\n${root.join("\n")}\n`,
  };
  for (const { id, name } of tokens.color.themes.slice(1)) {
    const body = [
      `:root[data-theme="${id}"] {`,
      `  color-scheme: ${DARK_THEMES.has(id) ? "dark" : "light"};`,
      ...colourLines(tokens, id),
      ...hearthLines(tokens, id),
      ...shadowLines(tokens, id),
      "}",
    ];
    files[`themes/${id}.css`] = `${HEADER(`Nook's ${name} theme`)}${body.join("\n")}\n`;
  }
  const swatches = tokens.color.themes.map(({ id, name }) => {
    const c = (token: string) => JSON.stringify(valueIn(tokens, token, id));
    const colours = `canvas: ${c("canvas")}, surface: ${c("surface-1")}, ink: ${c("ink")}, accent: ${c("accent")}`;
    return `  { id: "${id}", name: "${name}", dark: ${DARK_THEMES.has(id)}, ${colours} },`;
  });
  files["themes.ts"] =
    `${HEADER("Nook's themes, with the colours a swatch of each shows").replace("/*", "/**")}` +
    `export const NOOK_THEMES = [\n${swatches.join("\n")}\n] as const;\n`;
  return files;
}
