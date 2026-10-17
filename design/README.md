# Design

`nook/` is Nook's design system, copied as it is from the design-system artifact made for Hearth
(claude.ai artifact `SVAzbN96AMpqUwBFSMjS9e`): its README, `tokens.json`, the 31 components (each a
README and a preview), the component bundle, the logos and Pip. Don't edit it here; change the
design system and copy it in again.

What the app takes from it:

- **Tokens.** `node scripts/nook-themes.ts` turns `nook/tokens.json` into the web app's
  stylesheets (`apps/web/src/styles/`: `nook.css`, one file per theme, and the theme list).
  `apps/web/src/lib/tokens.test.ts` fails when they're out of date, and checks every theme's
  contrast. `apps/web/src/index.css` gives Hearth's older colour names Nook's values.
- **Marks.** `apps/web/public/icon.svg` and the PNG icons are `nook/assets/Logos/nook-mark.svg`;
  `NookMark` in `apps/web/src/components/Mark.tsx` draws it in the app.
- **Components.** The views move onto Nook's components (Button, Controls, Badge, Menu, Toast,
  Window, Sidebar and the rest) as they're rebuilt; each component's README is its spec.
