/** Nook's themes, with the colours a swatch of each shows: generated from design/nook/tokens.json by scripts/nook-themes.ts.
   Don't edit by hand; change tokens.json and run `node scripts/nook-themes.ts`. */
export const NOOK_THEMES = [
  { id: "light", name: "Light", dark: false, canvas: "#e8e8ed", surface: "#ffffff", ink: "#1d1d1f", accent: "#0a60c8" },
  { id: "dark", name: "Dark", dark: true, canvas: "#0d0d0f", surface: "#1c1c1e", ink: "#f5f5f7", accent: "#4da3ff" },
  { id: "midnight", name: "Midnight", dark: true, canvas: "#000000", surface: "#0a0a0c", ink: "#ffffff", accent: "#5aacff" },
  { id: "dusk", name: "Dusk", dark: true, canvas: "#1a1512", surface: "#261f1b", ink: "#f8f0e6", accent: "#ff9f47" },
  { id: "paper", name: "Paper", dark: false, canvas: "#e6dfd0", surface: "#fbf7ef", ink: "#2a241c", accent: "#9a4a1c" },
  { id: "contrast", name: "High contrast", dark: false, canvas: "#ffffff", surface: "#ffffff", ink: "#000000", accent: "#0030b8" },
] as const;
