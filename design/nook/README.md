Nook is a desktop environment: a tiling window manager whose windows are the product's views, with Pip, a small glowing cube ghost, as the resident agent. Build every screen to feel like macOS and iOS: bright, quiet, translucent, with large rounded shapes, real depth and one accent colour.

## Brand

- The product is Nook. Write it as a proper noun, never "the Nook" or "NOOK". The agent is Pip; Pip is "it" in prose and speaks in first person. Never call Pip an AI, assistant or bot in the interface.
- Use `assets/Logos/nook-mark.svg` for icons and the dock and `nook-wordmark.svg` where the name is written as a logo; elsewhere set Nook in `title-1`. Use `assets/Mascot` for Pip; the Pip component carries the animated version.
- Voice: short plain sentences, sentence case, no exclamation marks, no emoji. Pip says what it did and what it needs ("I drafted a reply to Maya. Send it?"). Errors say what happened and the next step.
- Tagline: "Your desk, in order."

## Principles

- Windows are the unit. Each view (Today, Inbox, Tasks, Mail, Calendar, Notes, Canvas, Sheets, Graph, People, Meetings, Voice, Browser, Pip, Activity, Memory, Settings) lives in a `Window`, never in a page with a banner.
- One accent. `accent` means interactive and focused: the focused window's border, the primary button, the active workspace, selection, links and the focus ring. Nothing else is filled with it.
- Chrome is vibrant glass with a lit edge; content is solid. Sidebar, menu bar, dock, titlebars and toolbars use `glass`; menus, popovers, alerts, the palette and toasts use `glass-strong`; both carry `glass-edge` inset at the top. Everything you read or edit sits on `surface-1`, `surface-2` or `surface-3`.
- Depth is layered, motion is quiet. Use the five shadow levels and the timing tokens below; nothing is flat and nothing bounces without a reason.

## Themes

Six themes, chosen with `data-theme` on the root: `light` (default), `dark`, `midnight` (true black, OLED), `dusk` (warm charcoal, amber accent), `paper` (cream reading mode, sienna accent) and `contrast` (7:1 text, black outlines, opaque chrome, solid outlines instead of shadows). Every colour and shadow token has a value in every theme, so components never branch on theme. Follow the system between Light and Dark by default; a theme change crossfades over `dur-base`.

## Colour

- Desktop and gaps between tiles: `canvas`. Window and panel bodies: `surface-1`. Grouped content, cards, table stripes: `surface-2`. Hover, pressed, inset, segmented track: `surface-3`.
- Text: `ink` primary, `ink-muted` secondary, `ink-subtle` placeholders and disabled only. On `glass` use `ink` only.
- Controls that must be seen (field, checkbox, radio, switch and slider track) take a `border-strong` outline. Dividers and outlines use `hairline`.
- `accent` fills carry `on-accent`. Accent as text is `accent-ink`. Selected list rows are `accent-soft` with `ink`; selected menu and palette rows are solid `accent` with `on-accent`.
- Status: `positive` running or connected, `warning` waiting or degraded, `danger` failed or destructive, always with a word or icon. Window controls use `traffic-close`, `traffic-min`, `traffic-zoom` on the focused window only.
- Pip's colours (`pip-body`, `pip-eye`, `pip-glow`, `pip-glow-ink`) are reserved for Pip.

## Charts and graphs

- Data series use `chart-1` to `chart-8` in order; at most five per chart, the rest in `chart-8`. Magnitude uses `seq-1` to `seq-5` with a Fewer/More legend; the ramp follows the theme's accent hue in Dusk and Paper.
- Gridlines use `chart-grid`, three at most; labels use `caption` in `ink-muted`; label the last point or add a legend; every chart has an `aria-label` with its headline.
- Chart containers are `surface-1` cards of `radius-lg` at `shadow-2`.
- The Graph view colours nodes by type (`node-task`, `node-note`, `node-person`, `node-event`, `node-mail`), scales radius with link count, draws `edge` lines at 55%, and marks the selected node with a `focus` ring and `accent` edges.

## Type

- One family, `sans` (SF Pro on macOS, Segoe UI Variable on Windows); `mono` for code, logs, paths and keys.
- `large-title` at the top of a full-page view; `title-1` window titles; `title-2` sections; `title-3` cards. `body` for reading; `callout` for controls, menus, rows and cells; `caption` for metadata and the menu bar; `overline` for group labels in capitals; `display-xl` for welcome and empty states only.

## Shape, depth and space

- Spacing `space-1` to `space-16`; `tile-gap` between tiled windows and from the screen edge.
- Corners: `radius-win` windows and tiles; `radius-sm` buttons and rows; `radius-md` fields, menus, popovers; `radius-lg` cards, charts, widgets; `radius-xl` sidebar, dock, palette; `radius-sheet` alerts; `radius-pill` switches, pills, badges.
- Depth: `shadow-1` buttons and cards, `shadow-2` widgets and charts, `shadow-3` tiled windows, sidebar and dock, `shadow-4` menus, popovers, palette and toasts, `shadow-5` the focused window and dragged tiles. Hover raises one level (cards go 1 to 2). Blur: `blur-chrome`, `blur-menu`, `blur-scrim`, always with `saturate(1.8)`.
- Sizes: `bar-height`, `titlebar-height`, `sidebar-width`, `dock-icon`, `control-sm|md|lg`, `pip-size`. Layers: `z-window`, `z-bar`, `z-menu`, `z-palette`, `z-toast`.

## Motion

- Every transition uses one duration and one easing: `dur-fast` + `ease-standard` for hover, press, focus and colour; `dur-base` for switches, menus, tabs and theme changes; `dur-slow` for windows moving to a tile, sheets and the palette; `ease-spring` only when something answers the user (dock hover, Pip reacting, a badge appearing); `ease-exit` for leaving.
- Ambient loops use `dur-ambient`: Pip breathing and the island pulse. Nothing else loops. Charts draw in once over `dur-slow`.
- Under `prefers-reduced-motion` all durations become 1ms and loops stop; fades remain.

## Window manager behaviour

- Layouts per workspace: columns, main-and-stack, grid, float, chosen with a segmented control.
- Exactly one window has focus: a 2px `focus` border and `shadow-5`; the rest lose the border and their traffic lights turn gray.
- Workspaces are pills in the menu bar; the active one is solid `accent`; a dot marks one where Pip is working or an approval waits.
- Win+Space opens the launcher (CommandPalette); Ctrl+K searches inside a window; every menu action shows its shortcut as `Kbd`.
- Pip sits in the menu bar; the island grows from it with one phrase while Pip works. Anything with side effects goes through an `ApprovalCard`; destructive window actions through an `Alert`.

## Components

Use `components/`: Pip, PipIsland, Logo, Depth, Motion, ThemePicker, Button, Controls, Badge, Kbd, Window, Bar, Workspaces, TileLayout, Dock, CommandPalette, Menu, Toast, Alert, Sidebar, Tabs, ApprovalCard, TaskList, Table, Terminal, LineChart, BarChart, DonutChart, StatTile, Heatmap, NodeGraph. Classes live in `components/bundle.css` and use only these tokens. Each preview has a theme switcher at the top right.

## Iconography

No icon set is bundled yet. Use one outline set at 16 to 20px, 1.5px strokes, rounded joins, inheriting `ink` or `ink-muted`. Sidebar and dock tiles are coloured rounded squares (`chart-1` to `chart-5`) with an `on-accent` glyph. Never use emoji as icons; the letters in the previews are placeholders.

## Not synced

Fonts are the system stack (no font files). Components are HTML, CSS and inline SVG with CSS animation; `components/bundle.js` only exposes `Nook.setTheme` and `Nook.pip.setState`, there are no JavaScript components yet. Icons are letter placeholders.
