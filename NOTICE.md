# Notices

Hearth (shown to you as Nook) is licensed under the MIT License (see [LICENSE](LICENSE)). Its
look, `design/nook/`, is Hearth's own and under the same license.

Some files are copied or adapted from other open-source projects. Each such file keeps its
original notice at the top, and is listed here with where it came from.

| Hearth path | Origin | Upstream path | License |
|---|---|---|---|
| `apps/desktop/` (all of it, except `src-tauri/src/hearth/` and `src/components/settings/HearthSettings.tsx`, which are Hearth's) | [Handy](https://github.com/cjpais/Handy) at `ffbc950`, changed where marked | the whole repository | MIT (`apps/desktop/LICENSE`) |
| `apps/web/src/components/icons.tsx` (the icons' SVG markup) | [Lucide](https://github.com/lucide-icons/lucide) v0.548.0 | `icons/*.svg` | ISC, with MIT for the parts from Feather (both in the file's header) |
| `apps/web/src/components/brands.tsx` (the marks' paths) | [Simple Icons](https://github.com/simple-icons/simple-icons) | `icons/*.svg` | CC0 1.0; the marks are their owners' trademarks |

Projects Hearth borrows ideas from without copying code: Macro (macro-inc/macro, AGPLv3),
Twenty (twentyhq/twenty, AGPLv3 and MIT parts). The canvas's data shape
(`packages/core/src/canvas.ts`) and its arrows' side and curve rules
(`apps/web/src/canvas/geometry.ts`) follow Macro's block-canvas, written anew.
