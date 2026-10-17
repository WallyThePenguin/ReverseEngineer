/* @ds-bundle: {"format":4,"namespace":"Nook","components":[]} */
/* Nook runtime helpers. Components are HTML+CSS; this script only wires themes and Pip. */
window.Nook = {
  version: "3",
  themes: ["light","dark","midnight","dusk","paper","contrast"],
  setTheme: function (theme, el) { (el || document.documentElement).setAttribute("data-theme", theme); },
  pip: { setState: function (svg, state) {
    if (!svg) return; svg.setAttribute("class", "pip pip--" + state);
    svg.setAttribute("aria-label", "Pip the ghost, " + state); } }
};
