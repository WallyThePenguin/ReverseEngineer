// Puts this device's theme on the page before it draws, so a dark theme never flashes light. It
// runs as the page's first script (the CSP allows no inline ones); lib/theme.ts keeps it current
// after. Its ids and its key are lib/theme.ts's, and lib/theme.test.ts checks they agree.
(() => {
  const THEMES = ["light", "dark", "midnight", "dusk", "paper", "contrast"];
  let choice = null;
  try {
    choice = localStorage.getItem("hearth.theme");
  } catch {}
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = THEMES.includes(choice)
    ? choice
    : dark
      ? "dark"
      : "light";
})();
