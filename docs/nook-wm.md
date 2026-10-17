# Nook arranges your windows

The design for Nook's window manager: how the desktop app tiles, groups and focuses every window
on the owner's PC, safely. Decided in D75 (docs/decisions.md). Researched on 2026-10-17 from
komorebi, GlazeWM, Seelen UI, Whim, workspacer and PowerToys FancyZones, plus the Win32 shell,
input and event APIs, then reviewed by two adversarial critics (risk and performance), whose 16
blockers this version fixes.

The owner answers the open decisions on the design page
(https://claude.ai/artifact/1SQmChXULSi65TDMUof1kG). Until they do, each takes the option marked
proposed. None of them holds up P0 or P1.

Code may be adapted only from MIT projects (PowerToys, Whim, workspacer, komorebi's app config,
AltTabAccessor); komorebi's own code, GlazeWM and Seelen UI are read for ideas only. See
"What we reuse" below.

## Summary

Nook WM is a window arranger built into the existing Tauri 2.11.5 desktop app (crate `handy`, apps/desktop/src-tauri). It adds a new `src/nook/` module tree, plus a small separate program, `nook-guard.exe`, whose only job is to put windows back. It is off by default and opt-in for each capability. Until the owner turns a capability on, Nook registers nothing, hooks nothing and creates no windows.

This revision fixes all 16 blockers raised by the two reviews.

Safety
1. The guard is its own small image, not hearth.exe. It runs from a per-version copy under %LOCALAPPDATA%, double-spawned and detached. The installer kills hearth.exe by name (tauri-bundler utils.nsh L22-62 [S]), so it never kills the guard, and an install never overwrites a running guard file.
2. NSIS PREINSTALL/PREUNINSTALL hooks run a graceful restore before that kill. The installer template already calls those hooks first (installer.nsi L728-732, L880-884 [V]). An update ends in a 'clean-for-update' state and Nook resumes afterwards.
3. Every restorer first sets a revocation event. Nook's write seam checks that event, so a stalled WM can never re-apply its layout after a restore.
4. Pause reasons are independent gates. Settling can no longer override the game guard.
5. A missing monitor or an RDP session pauses arranging and restores that monitor's windows; nothing is re-tiled onto another monitor.
6. Each Nook thread is wrapped in catch_unwind, the panic hook acts only on threads named nook-, and the guard watches a heartbeat.
7. The full WINDOWPLACEMENT is journaled at hide time, so maximized windows come back maximized.
8. A burst of restores dissolves the hidden workspaces instead of making Nook follow window after window.
9. The bar, island, popover and panel are pages bundled into the app (WebviewUrl::App, the same pattern as the recording overlay [V overlay.rs L404-407]), not pages from 127.0.0.1:4400. Port squatting, the full SPA, its EventSource connection and server-down blanks are gone. The only IPC is one validated command.

Feel
10. Idle Pip in the bar is still, and DWM acrylic is the only blur (no CSS backdrop-filter). The idle bar presents 0 frames per second.
11. The island grows inside the bar's own webview.
12. A workspace switch shows the incoming windows first, each with one SetWindowPlacement straight into its tile, then minimizes the outgoing ones. The budget is now an honest 300 ms p95.
13. LOCATIONCHANGE is hooked only for the foreground managed process and ignored during drags.
14. The callback coalesces straight into a map. The first flush happens at once, with a 16 ms high-resolution trailing timer, and hotkeys skip the coalescer.
15. Budgets are end to end and per thread, measured with QueryThreadCycleTime, ETW and PresentMon.
16. The cost of tiled windows to Wallpaper Engine is measured in P2.

Hiding stays minimize-based, so a window Nook hid is always in the taskbar even if every Nook component fails. Cloaking is a P6 opt-in, allowed only on Windows builds whose COM IIDs are verified. SW_HIDE is never used. Hotkeys use RegisterHotKey only, in the Ctrl+Win+Alt family. None is registered until the WM is enabled; Pause and Panic always are while it is, and the rest only when the owner opts in.

Delivery is seven phases:
- P0: safety rails, guard, installer hooks.
- P1: observer and a visible read-only bar.
- P2: arrange on demand.
- P3: workspaces.
- P4: focus ring.
- P5: keymap.
- P6: extras.
Each phase is gated on kill tests, per-thread CPU budgets and zero stranded windows.

Evidence tags:
- [V]: verified in this repo this pass, with file and line.
- [S]: read in upstream source this pass, with path and line.
- [S*]: reported by the earlier surveys, not re-read this pass.
- [D]: Microsoft or vendor documentation, not re-fetched.
- [I]: inferred, to be measured in the phase named.

## Principles

- Off by default, opt-in per capability. nook.wm.enabled=false. Arranging, auto-manage, workspaces, bar, ring, keymap, space reservation, cloaking and DISPLAY2 each have their own switch, all off. While everything is off, Nook installs no hook, registers no hotkey, creates no window and starts no guard.
- Nothing Nook leaves behind depends on Nook. Hiding is minimize only, so the window stays in the taskbar and Alt-Tab. Borders and AppBars are journaled. The worst case after a total failure is windows sitting minimized in the taskbar, which the owner can restore with one click.
- Write-ahead, then act. Every change to another app's window is journaled and fsynced before it happens. The undo runs on every exit path: disable, quit, panic, tray, CLI, the per-thread unwind handler, the guard (crash, kill, wedge), next start, logoff, installer update and uninstall.
- Exactly one writer at a time. A restorer first sets the revocation event Local\Nook.Revoked.<session>. Every mutating call in the Desktop seam checks it, so a slow WM can never undo a restore.
- Gates, not modes. user_paused, game_guard, session_locked, settling, display_missing, remote_session, journal_failed, breaker and revoked are independent flags. A layout pass runs only when all are clear, and game state and the foreground window are re-checked right before every pass.
- Touch only what was adopted. Nook writes only to windows it adopted:
- a window the user minimized is never un-minimized;
- a window is never moved to another monitor unless the user asks;
- DISPLAY2 is unmanaged by default;
- the shell, Wallpaper Engine, games and anti-cheat are never written to.
- Fail closed. An unwritable journal means no write and a pause. An unknown window is ignored. A DWM read error counts as cloaked. An unverified build gets no cloaking. If hearth.exe runs elevated, Nook offers Observing only.
- Event-driven and cheap. Out-of-context WinEvent hooks are narrowed by process wherever possible. Events coalesce per HWND in the callback. The first flush happens at once, a trailing flush follows at 16 ms, and hotkeys skip the coalescer. The only periodic work is a 5 s sweep, and only while Nook manages windows. EnumWindows runs only on enable, Arrange, end of settle and when the panel opens.
- Never block on another app. Calls use SWP_ASYNCWINDOWPOS, WPF_ASYNCWINDOWPLACEMENT and ShowWindowAsync, and never SendMessage without SMTO_ABORTIFHUNG. A hung app is marked 'busy' and never treated as a fight.
- Nook's own chrome is local. The bar, island, popover, panel and palette are pages bundled into the app, loaded with WebviewUrl::App like the recording overlay [V]. They make no network requests and have one validated IPC command. Hearth's remote windows keep no IPC, as today [V window.rs L6-8].
- Physical pixels and per-monitor DPI v2 everywhere. Tokens (bar-height 28, tile-gap 8, focus-border 2) are logical px times DPI/96. Tiles are placed by their visual rect (DWMWA_EXTENDED_FRAME_BOUNDS).
- The user's intent wins. Maximize, minimize, drag, Snap and float are respected. A window that fights placement floats with the reason shown, and Nook tries once, never in a loop.
- Explain every verdict. Each window carries Managed, Float or Ignore plus the first matching reason, shown in the panel's 'Why not tiled' list.
- The design system is the UI, and every gap is written down. Bar, Workspaces, PipIsland, Pip, Kbd, Controls (segmented layout picker), Menu/popover, Toast, Alert and CommandPalette are built from design/nook tokens and CSS. Where Windows can't match the spec, the gap is listed and the component README gets a note:
- other apps' 8px DWM corners instead of radius-win 12px;
- a 1px system border unless the 2px ring is chosen;
- gray traffic lights can't be drawn on other apps;
- Win+Space and Win+1..9 are Windows' own;
- DWM's fixed blur radius.
- Motion is quiet and honest. Nook never animates real windows; they snap. Chrome follows the tokens: dur-fast for pills and colour, dur-base for the island and the theme crossfade, ease-spring only when Pip answers the user. Ambient loops run only while Pip works, and stop under reduced motion, when the bar is hidden and during game guard.
- Licensing:
- MIT, Apache-2.0, BSD and ISC code may be adapted, with a NOTICE.md row and a file header;
- GPL, AGPL, LGPL, PolyForm and the Komorebi License are learn-only: no code, no translated snippets, no data.
- Ship in safe, separately useful phases, each gated on kill tests and measured budgets. The first visible thing, a read-only bar, ships in P1 before any write, in line with the owner's 'visible progress' preference.

## Architecture

PROCESSES

(1) hearth.exe, the existing Tauri app: tao main thread, tokio, WebView2.
- tao makes the process per-monitor-v2 DPI aware when the event loop is created [V tao c3bee28 src/platform_impl/windows/dpi.rs L20-29, event_loop.rs L187].
- Nook adds threads only while a capability is on.

(2) nook-guard.exe, a separate small program.
- Source: a new package apps/desktop/src-tauri/crates/nook-restore (lib + bin; deps: windows 0.61.3 subset, serde, serde_json; MIT). It has its own Cargo.lock and is Windows-only.
- The lib is also a path dependency of `handy` ([target.'cfg(windows)'.dependencies]), so the WM, the CLI and the guard share one journal and restore implementation.
- Build: a `build:guard` step (cargo build --release --manifest-path crates/nook-restore/Cargo.toml) runs before `tauri build`. It copies the exe to src-tauri/binaries/nook-guard-x86_64-pc-windows-msvc.exe, gitignored.
- Shipping: tauri.windows.conf.json [V exists] gains bundle.externalBin ["binaries/nook-guard"]. The NSIS template already installs and deletes external binaries (installer.nsi L745-746, L895-896 [V]).
- Launch, at enable: hearth copies $INSTDIR\nook-guard.exe to %LOCALAPPDATA%\app.hearth.desktop\nook\bin\nook-guard-<build8>.exe if that copy is missing, and runs the copy.
  - The installer can then always overwrite files in $INSTDIR.
  - CheckIfAppIsRunning, which matches by exe name with FindProcessCurrentUser/KillProcessCurrentUser (tauri-bundler utils.nsh L22-62 [S]), never matches the guard.
- Double spawn: hearth starts `nook-guard-X.exe --launch <args>` with DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, plus CREATE_BREAKAWAY_FROM_JOB, retried without it on ERROR_ACCESS_DENIED. That process starts the real guard and exits, so the guard is not in hearth's process tree (taskkill /T, Task Manager's End task [I: P0 kill test]).
- The guard runs:
  - SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) first;
  - OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, parent) plus a check of the parent's creation FILETIME, so a reused pid isn't mistaken for the parent;
  - then it blocks in WaitForMultipleObjects on {parent handle, Local\Nook.Restore.<session>, Local\Nook.Done.<session>, Local\Nook.Armed.<session>}.
  - Disarmed (nothing journaled), the wait is INFINITE: 0 wakeups.
  - Armed, the timeout is 5 s and it reads a heartbeat counter from the shared section Local\Nook.Beat.<session>.
  - After 3 missed beats (15 s or more) it sets Revoked and restores.
- Target: 8 MB private or less [I: P0 measures].
- The app holds the guard's handle and respawns the guard if it dies.
- Rejected host: the WinSW services (session 0 can't reach desktop windows [D]).

(3) CLI branch, in apps/desktop/src-tauri/src/main.rs before `CliArgs::parse()` [V main.rs: parse is the first statement, so unknown flags would otherwise be refused]:
`hearth.exe --nook-restore-windows [--reason=user|update|uninstall] [--wait-ms=N] [--quiet]`
- Calls SetProcessDpiAwarenessContext(PMv2).
- Sets the running instance's Restore event, carrying the reason, and waits up to wait-ms for the journal to read clean or clean-for-update. If it doesn't, it sets Revoked and runs nook_restore::restore_all itself.
- It runs before Tauri starts, so tauri-plugin-single-instance (lib.rs L898 [V]) never sees these flags, and they are never parsed from OS deep links (lib.rs L922 [V]).
- Old binaries without the flag exit with a clap error, which is harmless.

THREADS IN hearth.exe (started on enable, joined on disable; every body runs inside catch_unwind)

- nook-wm owns all WM state.
  - Asserts the thread's DPI awareness is PMv2 via GetThreadDpiAwarenessContext and AreDpiAwarenessContextsEqual.
  - Installs the WinEvent hooks; out-of-context callbacks run on this thread [D].
  - Owns an HWND_MESSAGE window for command wake-ups.
  - Loop: MsgWaitForMultipleObjectsEx({trailing timer created with CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, Revoked event}, timeout, QS_ALLINPUT, MWMO_INPUTAVAILABLE), then drain PeekMessage, then drain the command channel (std mpsc; commands run immediately), then flush if due.
  - No timeBeginPeriod.
- nook-shell: a hidden top-level window (WS_POPUP, WS_EX_TOOLWINDOW, never shown; not HWND_MESSAGE, because broadcasts skip message-only windows). It receives:
  - WM_DISPLAYCHANGE;
  - WM_SETTINGCHANGE (SPI_SETWORKAREA, ImmersiveColorSet, high contrast);
  - WM_DEVICECHANGE;
  - WM_POWERBROADCAST and RegisterPowerSettingNotification;
  - WTSRegisterSessionNotification events;
  - TaskbarCreated;
  - WM_QUERYENDSESSION and WM_ENDSESSION.
  It forwards them to nook-wm as commands.
- nook-keys: a hidden window with RegisterHotKey.
  - Separate, so Panic works even when nook-wm is stuck.
  - Panic: set Revoked, set Restore, run restore_all in-process on this thread, holding the journal mutex with a 2 s timeout. The guard is the fallback if this thread is also stuck.
- nook-com: an STA thread for the documented IVirtualDesktopManager (P1) and the opt-in cloak COM (P6). Each call has a 500 ms deadline; nook-wm caches the results.
- The Tauri main thread only creates and places Nook webview windows and emits events to them. nook-wm never waits on it.

PANIC POLICY
- Release builds use panic=unwind [V Cargo.toml L214]; there is no panic hook today.
- Each nook-* body: catch_unwind(...). On Err: set Revoked, run restore_all from the on-disk journal on a fresh thread (in-memory state may be inconsistent), toast, and leave Nook off.
- The hook callback and window procedures are extern "system", where an unwinding panic aborts the process (Rust 1.81 and later [D]). They are therefore panic-free and wrapped in catch_unwind, and on Err they set a flag that the loop handles. A true abort is the guard's case.
- A chained std::panic::set_hook (take_hook, then call the previous hook) only logs, and only for threads whose name starts with "nook-". Panics anywhere else in Hearth never affect Nook, following the existing catch_unwind pattern in lib.rs L438-442 [V].

MODULES

crates/nook-restore/src/:
- journal.rs: schema v2, atomic write, epoch.
- identity.rs: hwnd + pid + process creation time + marker.
- recover.rs: restore_all, run in two passes.
- objects.rs: named events, mutex, beat section.
- desktop.rs: `trait Desktop`, with RealDesktop and FakeDesktop (feature "fake"). Every mutating method checks Revoked and returns Err(Revoked) once it is set; in Observing mode it returns Err(ReadOnly).
- cli.rs: maybe_run(args) -> Option<i32>.
- bin/nook-guard.rs.
- examples/nook-testwin.rs.

apps/desktop/src-tauri/src/nook/:
- mod.rs: NookHandle (command Sender, snapshot).
  - init(app) is called from initialize_core_logic.
  - shutdown(app) is called from RunEvent::ExitRequested, next to hearth::sight::quitting [V lib.rs L1200].
  - prepare_update() is a Specta command.
- settings.rs: NookSettings in the existing store [V crate::settings].
- wm/thread.rs.
- wm/state.rs:
  - Wm {gates: Gates, monitors, windows: HashMap<Hwnd,Win>, spaces: HashMap<(VdId,MonitorId),MonitorSpaces>, ledger, rules, focus, drag, diag}
  - Gates {user_paused, game_guard, session_locked, settling_until, display_missing_since, remote_session, journal_failed, breaker, revoked}
  - Win {hwnd, pid, proc_start, exe: Arc<str>, class: Arc<str>, style, ex_style, verdict, state: Normal|UserMinimized|UserMaximized|Hidden{by: Nook}|Busy, frame: Option<FrameOffsets>, original: WINDOWPLACEMENT, hide_placement: Option<WINDOWPLACEMENT>, ws, last_set, min_size, flags}
- hooks.rs: hook sets and the callback, which writes into a thread-local HashMap<isize, Delta> pre-reserved to 512 entries, with no overflow path.
- window.rs.
- eligibility.rs: staged, cheap checks first.
- rules.rs plus rules/default.json.
- layout.rs: pure functions.
- place.rs.
- ledger.rs.
- workspace.rs.
- hide.rs.
- shell.rs, keys.rs, focus.rs, game.rs, vd.rs, monitors.rs.
- ui.rs: Nook windows, the `nook_ui` command, event emit.
- ring.rs (P4).
- appbar.rs (P6).
- diag.rs: QPC histograms, per-thread QueryThreadCycleTime, wakeup counters, nook.log. It never records window titles.

apps/desktop/src/nook/ (new Vite inputs next to the existing main and overlay inputs [V apps/desktop/vite.config.ts L21-28]):
- bar.html + bar.ts: vanilla TS with no framework; bar, workspaces and the island inside the bar.
- popover.html + popover.ts: popover, toast and the Keep/Undo Alert.
- panel.html + panel.tsx: React, reusing the app's Specta bindings; settings, monitors, 'Why not tiled', keys.
- palette.html (P6).
- nook.css: generated by scripts/nook-themes.ts [V generator exists], extended to emit the six themes' tokens plus the CSS subset for Bar, Workspaces, PipIsland, Pip, Kbd, Controls, Menu, Toast and Alert, with backdrop-filter stripped. It is checked like apps/web/src/lib/tokens.test.ts [V], so the bar and the web app never drift.

EXISTING FILES TOUCHED
- lib.rs: mod nook; init; commands in collect_commands!; ExitRequested; tray items 'Pause window arranging' and 'Put all windows back and turn off'.
- main.rs: the CLI branch.
- Cargo.toml windows features [V L123-141] gain:
  - Win32_UI_Accessibility, Win32_Graphics_Dwm, Win32_UI_Shell, Win32_UI_HiDpi, Win32_UI_Input_KeyboardAndMouse;
  - Win32_System_RemoteDesktop, Win32_Security, Win32_System_Power, Win32_System_SystemInformation;
  - Win32_Storage_FileSystem, Win32_System_ProcessStatus;
  - in P4, Win32_Graphics_Direct2D and Win32_Graphics_Dxgi_Common.
  regex is already a dependency [V L70].
- hearth/links.rs: Link::Theme(ThemeChoice), a strict enum of light, dark, midnight, dusk, paper, contrast or system; and Link::NookPanel.
- hearth/window.rs: from_page accepts Link::Theme only from Hearth's own windows (hearth, hearth_ask, hearth_capture [V window.rs L19-21]). hearth/deeplink.rs refuses Link::Theme coming from OS deep links.
- apps/web/src/lib/theme.ts [V localStorage key hearth.theme] and lib/desktop.ts [V closeMiniWindow pattern]: inside the desktop app, choose() and page load navigate to hearth://theme/<id>.
- apps/web/src/views/DesktopSettings.tsx [V]: an 'Arrange windows (preview)' row with a hearth://nook-panel link.
- nsis/hooks.nsh (new), wired with tauri.conf.json bundle.windows.nsis.installerHooks; the template includes it only when set [V installer.nsi L35-37].
- apps/desktop/src/components/update-checker/UpdateChecker.tsx [V L143 downloadAndInstall]: invoke nook prepare_update first. The updater is dormant today (endpoints [] [V tauri.conf.json]), but this keeps it correct.
- capabilities/nook.json (new): windows nook_bar_*, nook_popover, nook_panel and nook_palette get only core:event:allow-listen and allow-unlisten.

STATE OWNERSHIP
- nook-wm exclusively owns Wm. Everything else sends commands or reads NookState snapshots. Snapshots are published on the leading edge, with the trailing edge coalesced to 100 ms.
- Journal writes from every party happen under the named mutex Local\Nook.Journal: nook-wm waits up to 200 ms, and a timeout pauses it.
- The journal header carries an epoch. A restorer increments it, and nook-wm refuses to write once the file's epoch is newer than its own.

IPC
Nook's windows are local pages, so Tauri treats them as Local origin. Tauri 2.11.5 lets any local page call app commands when the app has no ACL manifest (crates/tauri/src/webview/mod.rs L1823-1850 [S]), the same as recording_overlay today. So:
- one command, nook_ui(cmd: UiCmd), checks webview.label() against the nook_* set;
- every argument is validated: focus targets must be HWNDs in the managed set; workspaces are 1-9; layouts come from an enum;
- pages use a strict CSP meta (default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:), no eval, and textContent only;
- the pages never show window titles, only app names.
App to page: app.emit_to(label, 'nook://state', NookState).
Hearth's remote windows (127.0.0.1:4400) keep no IPC. The bar never loads anything from 4400, so a squatter on 4400 can only send the theme link (an enum) or open the panel.
WM control never flows through the server relay, so the phone PWA can't drive it.

DATA FOR THE BAR
- Services come from hearth/status.rs, already polled every 30 s [V].
- Approvals come from the device-token notify feed [V client.rs L211 notify_feed].
- Pip's working state comes from the same client. If no device-readable field exists, a small server addition is needed [I: P1]. The bar renders whatever Rust last pushed, so it works while the server is down.

PERSISTENCE (%LOCALAPPDATA%\app.hearth.desktop\nook\, or the portable data dir [V crate::portable]; the guard and CLI receive the path as an argument)
- journal.json: safety.
- state.json: workspaces and layouts; a convenience.
- rules.json.
- nook.log: 1 MB x 3.
- disabled: a file flag that forces the WM off at start.
- bin\: guard copies.
Settings live in the existing settings store.

## Which windows Nook manages

VERDICT

Staged from cheap to expensive, first match wins. Stage A is recomputed on SHOW or UNCLOAK, since some apps change style after creating the window. Process and COM facts are cached per (pid, proc_start). Negative verdicts stay cached until DESTROY.

STAGE A: local user32 reads only, no process opened
- Own process: WINEVENT_SKIPOWNPROCESS plus a pid check. Hard deny.
- Not IsWindowVisible, WS_CHILD, GetAncestor(GA_ROOT) != hwnd, or WS_DISABLED: ignore.
- Shell classes, hard deny:
  - Progman, WorkerW (Wallpaper Engine's renderer is parented under these);
  - Shell_TrayWnd, Shell_SecondaryTrayWnd, NotifyIconOverflowWindow, TopLevelWindowForOverflowXamlIsland, XamlExplorerHostIslandWindow;
  - MultitaskingViewFrame, ForegroundStaging, TaskListThumbnailWnd, Windows.Internal.Shell.TabProxyWindow, ApplicationManager_ImmersiveShellWindow;
  - EdgeUiInputTopWndClass, Shell_InputSwitchTopLevelWindow;
  - #32768, #32769, tooltips_class32, SysShadow, IME, MSCTFIME UI, Ghost, CEF-OSC-WIDGET.
  These are excluded by class, never by process name alone.
- Game window classes: RiotWindowClass is a hard deny [I: confirm against P1 fixtures]. UnrealWindow, UnityWndClass, CryENGINE, SDL_app and GLFW30 are ignored as 'likely a game'; the owner can override these, not the hard deny.
- WS_EX_TOOLWINDOW without WS_EX_APPWINDOW, WS_EX_NOACTIVATE, or WS_EX_LAYERED with WS_EX_TRANSPARENT (click-through overlays such as Overwolf, Discord's overlay, Teams toasts): ignore.
- A WS_POPUP with no WS_THICKFRAME, no WS_MINIMIZEBOX and no WS_MAXIMIZEBOX: ignore. Whim does the same (src/Whim/Native/CoreNativeManager.cs L145-190 [S], MIT).
- Visual size under 100x50: ignore.

STAGE B: DWM
- DWMWA_CLOAKED != 0, or the call fails: ignore (fail closed), unless Nook cloaked it itself (P6).

STAGE C: process facts, via OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) and QueryFullProcessImageNameW, the hearth/foreground.rs pattern [V]
Only windows that passed A and B get here, so Nook doesn't open game or anti-cheat processes for windows it would ignore anyway.
- Hard-deny exes:
  - ShellExperienceHost, StartMenuExperienceHost, SearchHost/SearchApp, LockApp, TextInputHost, ShellHost, Widgets/WidgetBoard;
  - GameBar/GameBarFTServer, NVIDIA Overlay, nvcontainer;
  - wallpaper32/64.exe, webwallpaper32.exe, wallpaperservice32.exe;
  - vgtray.exe, vgc.exe.
- Hard-deny explorer.exe windows other than CabinetWClass.
- Hard-deny game paths (case-insensitive substring of the image path):
  - \steamapps\common\
  - \Epic Games\ (except \Epic Games\Launcher\)
  - \EA Games\
  - \Riot Games\
  - \XboxGames\
  - Overwolf overlay helpers
- A process that can't be opened (protected): ignore.
- Elevated (TokenElevation) while hearth.exe isn't: ignore, with the reason 'Windows won't let Nook move it'. If hearth.exe itself is elevated, the panel refuses Active and offers Observing only, since an elevated arranger bypasses UIPI.

STAGE D: COM (nook-com, cached)
- Not on the current virtual desktop (IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop): ignore for now; it is re-checked on UNCLOAK.

FLOAT
Never tiled, but they belong to a workspace for hiding:
- owned windows (GW_OWNER, or not their own Alt-Tab root by the GA_ROOTOWNER plus GetLastActivePopup rule [D]);
- #32770 dialogs;
- fixed size (no WS_THICKFRAME or no WS_MAXIMIZEBOX);
- WS_EX_TOPMOST windows (Chrome Picture in picture, Teams compact view);
- splash screens (Whim IsSplashScreen, CoreNativeManager.cs L101 [S]);
- launchers: steam/steamwebhelper, EpicGamesLauncher, EADesktop, Overwolf, ui32 (Wallpaper Engine's UI);
- CalculatorApp; Taskmgr when not elevated.
SnippingTool and ScreenClippingHost are ignored rather than floated.

STICKY BY DEFAULT
Known minimize-to-tray apps, flagged no_hide in rules/default.json: Discord, Steam, Epic, EA, Overwolf, Spotify, Docker Desktop. They show on every workspace and are never minimized by Nook, so tray detection never makes them blink on first sight.

MANAGE-ELIGIBLE
Everything else with WS_CAPTION and WS_THICKFRAME that is its own Alt-Tab root. This is the FancyZones standard-window test (FancyZonesWindowProcessing.cpp L25-44, WindowUtils.cpp L109-170 [S], MIT) combined with Whim's. On the owner's PC that is:
- Chrome and Edge (Chrome_WidgetWin_1);
- Code, Notion, Claude;
- Discord's main window, when the owner removes its sticky flag;
- the ms-teams main window;
- WindowsTerminal;
- Explorer (CabinetWClass);
- Settings (ApplicationFrameWindow).

UWP
- Only an uncloaked ApplicationFrameWindow (ApplicationFrameHost.exe) is managed.
- The real exe comes from its Windows.UI.Core.CoreWindow child (FindWindowExW).
- Nook never acts on the CoreWindow.
- WinUI 3 windows (WinUIDesktopWin32WindowClass) follow the generic rules.

NOOK'S OWN WINDOWS
Own-process windows never reach the hooks (SKIPOWNPROCESS):
- the Hearth main window floats;
- Ask, Capture and every nook_* window are never touched.
Tiling the Hearth main window is an open question. If chosen, it gets an in-process adapter that uses Tauri window events, for the `hearth` label only.

ADOPTION (eligible is not the same as managed)
- Manual mode (the default): existing windows are adopted only by 'Arrange this monitor'.
- Auto mode: only apps matched by a rule with action manage and auto=true, and only on a managed monitor. Nook waits 200 ms after SHOW so the app's own first placement becomes the original.
- Never adopted:
  - minimized windows;
  - maximized windows (listed as 'maximized by you');
  - windows on DISPLAY2 unless it is turned on;
  - windows on another virtual desktop.
- Adopting a window:
  1. GetWindowPlacement becomes `original`;
  2. write the journal entry and fsync;
  3. SetPropW the marker;
  4. place the window.

PER-APP OVERRIDES
- User rules: rules.json, an ordered list:
  {match: {exe?, class?, title_regex?, path_prefix?}, action: manage|float|ignore, auto?: bool, flags?: [no_hide, frame_window_rect, no_ring, layered_quirk]}
- title_regex is evaluated once, at verdict time. GetWindowTextW on another process's window reads the stored caption without sending a message, so it can't hang [D].
- Precedence: hard deny, then user rule, then rules/default.json, then heuristics.
- rules/default.json is a translated subset of applications.json from LGUG2Z/komorebi-application-specific-configuration (MIT [S license API]), with its copyright line kept, plus the Nook entries above. komorebi itself (Komorebi License 2.0.0) is learn-only.

WHY NOT TILED
Every cached window shows its verdict and first reason in the panel, for example:
- 'Owned by Discord.exe: a dialog, floats';
- 'Under \steamapps\common\: games are never touched';
- 'Elevated: Windows won't let Nook move it';
- 'Minimized by you';
- 'Likely a game (UnityWndClass): Ignore. Change'.

## Event pipeline

HOOKS
Each hook is SetWinEventHook(min, max, 0, cb, idProcess, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS), installed by nook-wm in Observing mode or later.

Global (low volume):
- G1: 0x0003 FOREGROUND.
- G2: 0x000A-0x000B MOVESIZESTART/END.
- G3: 0x0016-0x0017 MINIMIZESTART/END.
- G4: 0x0020 DESKTOPSWITCH (UAC secure desktop, lock).
- G5: 0x0014-0x0015 SWITCHSTART/END (Alt-Tab hint).

Per managed process (idProcess = pid; installed on the pid's first adopt, removed with its last):
- P1: 0x8001-0x8003 DESTROY/SHOW/HIDE.
- P2: 0x8017-0x8018 CLOAKED/UNCLOAKED.

Foreground managed process only:
- F1: 0x800B LOCATIONCHANGE. Moved to the new pid on every FOREGROUND that lands on a managed window, and removed when the foreground is unmanaged. LOCATIONCHANGE is never hooked globally.
- Background maximize or move by another program is caught by the 5 s sweep.

Global SHOW/HIDE/DESTROY (0x8001-0x8003) only while Auto mode has at least one auto rule or the panel is open. Without it, new windows of unmanaged apps never wake Nook.

NAMECHANGE is not hooked at all: the bar shows app names, not titles.

P1 measures CPU in Chrome, Discord and VS Code with and without these hooks [I], in case WinEvent hooks turn on Chromium accessibility work.

CALLBACK (runs on nook-wm, panic-free, catch_unwind-wrapped, no Win32 calls)
- Return if idObject != OBJID_WINDOW, idChild != CHILDID_SELF, or hwnd is null.
- Drop DESTROY or HIDE for HWNDs not in the window cache. Drop LOCATIONCHANGE while a drag is in progress.
- Otherwise OR the event's bit into map[hwnd] (Delta: destroyed, shown, hidden, cloaked, uncloaked, min_start, min_end, move_start, move_end, located, foreground; last timestamp) and set pending=true.
- The map is pre-reserved, so nothing is allocated in steady state and there is no overflow or resync path.

FLUSH
- Leading edge: after the message drain, if pending is set and at least 16 ms have passed since the last flush, flush now.
- Trailing edge: otherwise arm the high-resolution waitable timer for the remainder; WM_TIMER is not used.
- Target 1 ms or less p99 with 50 windows.

1. Order per HWND: destroy, show/uncloak, cloak/hide, minimize, move, location, foreground. Destroy overrides everything; only the last foreground is kept.
2. Unknown HWND seen in SHOW, UNCLOAK or FOREGROUND: run the staged verdict once.
3. Expectation ledger: HashMap<Hwnd, Expect{kind: Place(rect)|Hide|Unhide|Focus, deadline}>, with 250 ms for placements and 1 s for hide/unhide.
   - A match is consumed. A placement matches when the visual rect is within 2 px of the target.
   - After the deadline, a move whose rect still equals an expected or last_set rect within 2 px counts as a late echo, not a user move (SWP_ASYNCWINDOWPOS can deliver late).
   - An achieved size larger than the target records min_size and is not fought.
   - If a deadline passes and IsHungAppWindow is true, the window becomes Busy ('waiting for the app'): not fighting, and nothing else is queued for it.
4. External changes on managed windows:
   - min_start: the window becomes UserMinimized and leaves the layout.
   - move_start: drag begins; hide the ring; ignore LOCATIONCHANGE.
   - move_end, resolved once:
     - the position changed and the drop is over another tile: swap;
     - the size changed: new ratio or weights;
     - dropped outside the managed area or onto an unmanaged monitor: release without restoring the original.
   - located (foreground pid only) with no drag: IsZoomed and the rect detect maximize, restore or Snap; UserMaximized leaves or rejoins the layout.
   - Unexpected min_end of a Nook-hidden window: see FOLLOW.
   - 5 or more ledger-miss placements of one window within 2 s of Nook placing it: 'fighting'. It floats and the reason is shown.
5. Layout pass over dirty workspaces, only if every gate is clear. Right before the pass, re-check the game state (cached for 250 ms) and GetForegroundWindow. Diff against last_set and place via place.rs, recording an Expect for each move.
6. Publish NookState (leading edge, trailing edge at 100 ms). Safety journal writes go out immediately; state.json is debounced to 2 s.

COMMANDS
WM_HOTKEY (forwarded by nook-keys) and nook_ui commands run immediately and skip the coalescer.
- During settle, geometry commands (layout, move, workspace) are queued, keeping the latest of each kind, and run when the settle ends.
- Pause, Panic and Put back always run at once.

FOLLOW AND BURSTS
- An unexpected MINIMIZEEND of a Nook-hidden window starts a 150 ms quiet window.
- When it ends:
  - 1 to 3 such restores, with the foreground on one of them: switch to that window's workspace (SWITCHEND confirms Alt-Tab);
  - more than 3 restores within 250 ms (Win+Shift+M, Show desktop toggled back, restore tools): dissolve. Those windows join the current workspace as floating, other hidden windows stay hidden, Nook pauses and toasts 'Windows came back all at once. Arranging is paused.' It never follows.
- Ledger-expected transitions never trigger follow.

GATES (independent; a pass needs all clear)
- user_paused: the user's pause.
- game_guard: re-evaluated on FOREGROUND and before every pass. It trips on:
  - SHQueryUserNotificationState returning QUNS_RUNNING_D3D_FULL_SCREEN or QUNS_PRESENTATION_MODE, cached for 250 ms;
  - a foreground visual rect equal to rcMonitor with no WS_CAPTION;
  - a foreground process under a hard-denied game path.
  QUNS_BUSY is ignored (the NVIDIA overlay sets it falsely [S*]). While tripped: no placements; ring, bar and popover hidden; non-panic hotkeys unregistered.
- session_locked: lock, DESKTOPSWITCH or the UAC desktop.
- settling: set by WM_DISPLAYCHANGE, SPI_SETWORKAREA, a real monitor-list change on WM_DEVICECHANGE, PBT_APMRESUMEAUTOMATIC, WTS_SESSION_UNLOCK, WTS_CONSOLE_CONNECT, TaskbarCreated, or a burst of CLOAKED events from managed windows only (Start, Task View and flyouts don't count). It lasts 2 s, extended by each new signal up to 5 s. When it ends:
  - re-enumerate monitors (stable device-interface ids);
  - re-read rcWork and DPI;
  - validate the managed windows;
  - run one pass, and only if the other gates are clear (a game in front keeps blocking it).
- display_missing: set when a journaled or managed monitor id is absent at settle end.
  - Stay paused, never re-lay out onto another monitor, and poll at each settle end for up to 30 s (DisplayPort monitors can wake late).
  - Monitor returns: clear and run a pass.
  - Monitor still missing after 30 s: restore that monitor's windows. SetWindowPlacement(original) moves fully off-screen windows back onto a screen [D]; Nook-hidden windows are un-minimized from their journaled placement. Release them, turn Nook off for that monitor, and toast.
- remote_session: WTS_REMOTE_CONNECT or SM_REMOTESESSION. Un-hide everything and remove the ring, borders and AppBar, keeping positions, then pause. On WTS_CONSOLE_CONNECT, settle and stay paused, with a 'Resume arranging' toast.
- journal_failed: pause and toast.
- breaker: auto-pause on more than 200 ledger-miss non-drag events/s for 10 s, or more than 30 unexpected placements/s for 5 s. Placements from user commands don't count.
- revoked: terminal. Unhook, unregister, exit the loop.

SWEEP
- Every 5 s, only while managed or hidden windows exist; it is also the guard's heartbeat.
- Calls IsWindow, GetWindowThreadProcessId, IsIconic and IsZoomed on managed HWNDs (local user32 calls), and IsHungAppWindow for Busy windows.

ENUMWINDOWS
Only on enable, Arrange, settle end and when the panel opens.

SESSION END
- WM_QUERYENDSESSION, with a budget of 1 s or less:
  - un-minimize Nook-hidden windows, so apps save visible bounds;
  - reset borders; ABM_REMOVE;
  - journal state 'session-ending', fsynced;
  - return TRUE.
- WM_ENDSESSION(TRUE): write 'clean'.
- WM_ENDSESSION(FALSE), logoff cancelled: stay paused, re-hide nothing, toast.
Nook doesn't assume the guard outlives a logoff.

## Layout engine

layout.rs is pure and has no Win32 calls:
`fn arrange(kind, area: Rect, n, p: &LayoutParams, gap, mins: &[Option<Size>]) -> Vec<Rect>`
It is property-tested.

AREA
- Start from the monitor's rcWork in physical px.
- Bar in Overlay mode: top += round(28 * dpi/96).
- Reserve mode (P6 AppBar): rcWork already excludes the bar.
- Then subtract the outer gap.

GAPS
- g = round(tile-gap 8 * dpi/96), between tiles and at the edges, per the TileLayout README [V]. That is 8 px on both of the owner's 100% monitors.
- Integer partitioning (floor, with the remainder spread over the last tiles): no 1 px seams, and the tiles fill the area exactly.

LAYOUTS (the design's four, picked with the Controls segmented control in the panel and the bar popover)
- Columns: equal weights, adjusted by dragging a gap. max_columns 4 when the width is 2560 px or more; beyond that the last column stacks.
- MainStack: main on the left, main_ratio 0.55 (clamped to 0.2-0.8), main_count 1, the rest stacked at equal heights. One window takes the whole area.
- Grid: cols = ceil(sqrt(n)), rows = ceil(n/cols); the last row widens to fill.
- Float: Nook places nothing and only remembers rects; floating windows still belong to the workspace.

DEFAULTS
- Aspect ratio 2.0 or wider: Columns (DISPLAY2 is 2.37). Otherwise MainStack (DISPLAY1).
- The layout can be cycled with Ctrl+Win+Alt+M (P5) or picked in the bar popover.

EXCLUDED FROM A PASS
Windows that are user-maximized, user-minimized, floating, topmost, fullscreen, hidden, Busy or fighting.

MINIMUM SIZES
- Learned from the ledger.
- Re-solve once, giving those tiles their minimum.
- If the windows still don't fit, the extra window floats with the reason 'too small to fit'.
- At most one retry per pass.

RESIZING
- Dragging a tile edge is a normal resize, resolved once at MOVESIZEEND:
  - MainStack: main_ratio = (main visual width + g/2) / area width;
  - Columns: the two neighbouring weights change;
  - Grid: tiles snap back.
- Keyboard (P5): Ctrl+Win+Alt+Comma and Period change the ratio by 0.05.
- The TileLayout accent line during a gap drag is drawn only by the 2px Nook ring (P4); with the system ring there is no line (a documented gap).

PER MONITOR
- Workspaces and layouts are independent per (virtual desktop, monitor).
- A window is only ever placed within its own monitor.
- DISPLAY2 is unmanaged by default and its windows are never written.
- 'Move to monitor' is an explicit command only.

DPI
- The process is per-monitor-v2 aware [V tao dpi.rs L20-29]. nook-wm asserts it at thread start; the guard and the CLI set it themselves first.
- All rects are physical px.
- Crossing to a monitor with a different DPI: place, let the ledger observe the app's WM_DPICHANGED resize, then place again. komorebi and GlazeWM use the same pattern [S*, learn-only].
- Not needed on the owner's 100%/100% setup, but tested at 125% and 150% in P2 on a test monitor or VM.
- Explicit dpiAwareness manifest: rejected. Replacing tauri-build's default manifest (build.rs is a plain tauri_build::build() [V L37]) risks losing its other entries, and the runtime call already holds.

FRAME-BOUNDS COMPENSATION
- Targets are visual rects.
- Per side, off = GetWindowRect - DWMWA_EXTENDED_FRAME_BOUNDS: about 7 px left, right and bottom on standard frames at 100%, 0 on Chromium and Electron [S*].
- SetWindowPos x = t.left - off.left, y = t.top - off.top, cx = t.w + off.l + off.r, cy = t.h + off.t + off.b.
- Offsets are measured at adopt and after a DPI change, never while minimized or maximized.
- The rule flag frame_window_rect covers apps that report bad bounds.

SETWINDOWPOS
- Flags: SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER.
- SWP_NOCOPYBITS only when the size changes; a pure move keeps its bits, so Electron doesn't flash.
- Never SWP_NOSENDCHANGING, because apps enforce minimum sizes in WM_WINDOWPOSCHANGING [S*]. Never SWP_FRAMECHANGED, never HWND_TOPMOST.
- A multi-window re-tile is issued in one burst, shrinking windows before growing ones, to cut overlap and wallpaper peeking. Layout skew (first to last window landing) is a diag metric.
- A maximized window is never un-maximized implicitly.

MOTION
- Windows snap to their tiles. Nook never animates a real window with repeated SetWindowPos calls; that looks janky with Electron repaints.
- dur-slow ('windows moving to a new tile', tokens.json) is therefore not used for foreign windows. This is a documented gap; an optional 140 ms ghost outline drawn by the P4 ring window is the most that may be added.

DESIGN GAPS
- radius-win 12px: other apps' corners come from DWM (DWMWCP_ROUND, 8px at 100% [D]). Nook keeps them and draws the ring to match.
- Per-tile labels: the bar shows the focused app's name instead.

## Workspaces

MODEL
- Keyed by (virtual-desktop GUID from IVirtualDesktopManager::GetWindowDesktopId on nook-com, monitor device-interface id).
- Each managed monitor has workspaces 1-9: numbers first, names later, per the Workspaces README [V]. One is active.
- A window belongs to at most one workspace; floating windows belong too.
- Sticky windows show on all workspaces: those with the no_hide flag (the default tray apps), topmost windows, and Nook's own windows.
- Only DISPLAY1 has workspaces by default.
- state.json holds membership and layouts. It is a convenience and never needed for safety.

HIDING: MINIMIZE (the model Seelen UI uses; AGPL-3.0, studied only [S*])
- Hide:
  1. journal hide_placement = GetWindowPlacement(hwnd) (showCmd, flags including WPF_RESTORETOMAXIMIZED, ptMin, rcNormalPosition), fsynced;
  2. SetWindowPlacement({showCmd: SW_SHOWMINNOACTIVE, flags: WPF_ASYNCWINDOWPLACEMENT, rcNormalPosition kept}).
- Unhide:
  - Tiled window: one SetWindowPlacement({showCmd: SW_SHOWNOACTIVATE, rcNormalPosition: tile rect after frame compensation, converted to workspace coordinates}). The window restores straight into its tile, so it never lands twice.
  - Workspace coordinates: subtract (rcWork.left - rcMonitor.left, rcWork.top - rcMonitor.top) on the window's monitor [D]. This is zero for the owner's bottom taskbar and 28 px in P6 Reserve mode; unit-tested with top and left taskbars and a Reserve bar.
  - Window that was maximized (WPF_RESTORETOMAXIMIZED or UserMaximized): SetWindowPlacement(hide_placement with showCmd SW_SHOWMAXIMIZED), so it comes back maximized. That call activates the window, so these go first and the final focus call comes last.
  - Floating window: its hide_placement, with SW_SHOWNOACTIVATE.
- Switch order:
  1. show the incoming windows (each into its final rect);
  2. minimize the outgoing ones, which are now behind them;
  3. focus the target workspace's last_focus through focus.rs.
  The desktop never flashes empty and focus never falls to the taskbar.
- Minimize animation:
  - Nook sets DwmSetWindowAttribute(DWMWA_TRANSITIONS_FORCEDISABLED, TRUE) on a window before hiding it and FALSE after, journaled as transitions_disabled.
  - P1 tests whether this works on another process's window (Chrome). If not, the system animation plays. Nook never changes the system animation setting; the panel only says the owner can turn off Windows' 'Animation effects' themselves.
- Honest budget, hotkey to the last incoming window at its final rect: 300 ms or less p95 for 6 windows with minimize, 60 ms or less with P6 cloak; first fresh frame 250 ms or less [I: 240 fps capture in P3]. Chromium and Electron windows may show stale content for a few frames after restore [I].

WHY MINIMIZE
- A minimized window stays in the taskbar and Alt-Tab, so even total failure strands nothing.
- Rejected, SW_HIDE: windows leave the taskbar, apps treat them as closed, and a crash strands them.
- Rejected, off-screen: off-screen space borders DISPLAY2, and Windows pulls such windows back when displays change [S*].
- Cloak (P6 opt-in): IApplicationView::SetCloak through IApplicationViewCollection, using per-build IIDs and vtable layouts from Ciantic/AltTabAccessor and VirtualDesktopAccessor (MIT [S license API]). Enabled only when the running build is in a verified table, and recovery always uncloaks. A cloaked window can be stranded (the GlazeWM #1358 class [S*]), hence opt-in. DWMWA_CLOAK only works on the caller's own windows [D].

USER INTENT
- UserMinimized windows are never restored by Nook.
- Restore bursts and follow are handled as in eventPipeline (150 ms quiet window; more than 3 within 250 ms dissolves and pauses).
- Tray apps:
  - Known ones are sticky by default.
  - Unknown ones: an EVENT_OBJECT_HIDE within 500 ms of Nook's minimize means the app hid itself because Nook minimized it. The journal records hidden_by = 'app_after_nook'; Nook immediately ShowWindowAsync(SW_SHOWNOACTIVATE)s it, marks the app sticky in state.json and toasts.
  - A window an app hid on its own is never force-shown by unhide or recovery.

RESTORE JOURNAL (schema v2)
Location: %LOCALAPPDATA%\app.hearth.desktop\nook\journal.json, UTF-8.

{v: 2, hearth_version, session: uuid, epoch: u64, pid, proc_start: FILETIME u64, boot_time: unix ms (now - GetTickCount64), state: 'active'|'restoring'|'session-ending'|'clean-for-update'|'clean', resume: bool, seq, written_at, unclean: [unix ms...],
 windows: [{hwnd: '0x..', pid, proc_start, exe, class,
   original: WINDOWPLACEMENT, hide_placement: WINDOWPLACEMENT|null,
   hidden: null|'minimized'|'cloaked', hidden_by: null|'nook'|'app_after_nook',
   user_minimized, user_maximized, monitor: device id, rc_work,
   border_set, transitions_disabled, last_set}],
 appbars: [{hwnd, edge, rect, monitor}],
 ring: {hwnd}|null}

- Write: serialize, write journal.json.tmp, FlushFileBuffers, MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH), all under Local\Nook.Journal, with an epoch check.
- Write-ahead rules:
  - written before adopt, every hide, every border change and ABM_NEW;
  - cleared lazily after unhide;
  - last_set updated at most every 2 s;
  - a write failure refuses the action, sets journal_failed and toasts;
  - the file stays under 20 KB.
- A journal from another Hearth version or schema is restored conservatively: un-minimize and reset DWM attributes only, no placement writes. A journal from another boot is dropped.

MARKER
- SetPropW(hwnd, MAKEINTATOM(GlobalAddAtomW('Nook.State')), bits): 1 managed, 2 minimized by Nook, 4 cloaked by Nook, 8 border coloured. This is the stamping pattern FancyZones uses (FancyZonesWindowProperties.cpp L14-94 [S], MIT).
- RemovePropW on release.
- A lost or corrupt journal falls back to EnumWindows plus GetPropW.

IDENTITY CHECK BEFORE ANY RECOVERY WRITE
- IsWindow;
- the pid matches;
- GetProcessTimes creation equals proc_start;
- the marker is present or the journal entry matches.

RECOVERY (nook_restore::restore_all; one implementation for every caller; idempotent)
0. Set Revoked; increment the epoch; take the journal mutex (2 s timeout; WAIT_ABANDONED counts as acquired; on timeout continue from the last complete journal.json); state 'restoring'.
1. ABM_REMOVE every journaled AppBar first, since its removal shifts workspace coordinates [D].
2. Uncloak Nook-cloaked windows.
3. Un-minimize windows with hidden_by = nook, using their journaled hide_placement. SW_SHOWNORMAL or SW_RESTORE map to SW_SHOWNOACTIVATE; SW_SHOWMAXIMIZED stays. Re-show 'app_after_nook' windows (SW_SHOWNOACTIVATE). Leave UserMinimized and app-hidden windows alone.
4. Placement, by policy:
   - originals (panic, Put back, crash, uninstall): SetWindowPlacement(original), with the same showCmd mapping. A window the user minimized after adoption stays minimized, but its rcNormalPosition is set back to the original, so restoring it later goes to its old place.
   - keep (plain disable, update, RDP, session end): no placement writes.
5. Reset DWMWA_BORDER_COLOR to DWMWA_COLOR_DEFAULT and DWMWA_TRANSITIONS_FORCEDISABLED to FALSE, only on windows whose journal says Nook set them. DWM can't report another app's own border colour, so an app's custom border is lost after a restore; such apps get no_ring.
6. RemovePropW.
7. State 'clean', or 'clean-for-update' with resume=true; fsync; set Local\Nook.Done.
8. Second pass after 1 s: re-check steps 3-5 for each window and fix stragglers from late asynchronous messages. Messages queued to the same app thread run in order, so Nook's older moves land before the restore [I].

WHO RUNS IT
- Disable (keep policy, open question) and quit (originals).
- Panic, tray, panel, CLI (originals).
- A nook thread unwinding (originals).
- The guard, when the parent dies with the journal not clean, or after missed heartbeats (originals).
- Next start, if the journal is dirty and from the same boot (within 10 s) and the same session uuid is gone (originals).
- WM_QUERYENDSESSION (steps 1-3 and 5 only).
- Installer hooks:
  - PREINSTALL runs `hearth.exe --nook-restore-windows --reason=update --wait-ms=5000` through nsExec, so no window pops. Keep policy, then 'clean-for-update'.
  - PREUNINSTALL runs it with --reason=uninstall (originals, Nook off).
  - Both run before CheckIfAppIsRunning kills hearth.exe [V installer.nsi L728-732, L880-884].
  - POSTUNINSTALL removes nook\bin with RMDir /r /REBOOTOK.

AFTER AN UPDATE
If the state is 'clean-for-update' with resume=true and was written within 15 minutes:
- Nook comes back in its previous capability set;
- re-validates each window's identity and re-adopts it without moving it;
- after a 5 s settle, re-hides the inactive workspaces' windows (write-ahead as usual).
An update never counts as an unclean end.

AFTER AN UNCLEAN END
The WM stays off until the owner turns it back on (open question). Two unclean ends within 10 minutes means 'safe start': Nook can't be enabled until the owner clears it in the panel.

## The Nook bar

WINDOWS
All are local pages (WebviewUrl::App), none is created before its capability is on, and none is ever monitor-sized or topmost at start.
- nook_bar_<mon>: one per enabled monitor; by default DISPLAY1 only. It hosts the Bar, the Workspaces pill track and the PipIsland, so the island grows inside the bar's own webview. There is no second renderer and no hit-test gap below the bar.
- nook_popover: glass-strong surfaces taller than the bar:
  - the workspace and window list (Menu/popover);
  - services detail;
  - Nook Toasts (top right under the bar, 340px, 5 s, per the Toast README [V]);
  - the 15 s 'Keep this arrangement?' Alert (radius-sheet, 300px, the safe 'Put back' as primary).
  Pre-warmed hidden when the bar turns on. While hidden: ICoreWebView2Controller.IsVisible=false, MemoryUsageTargetLevel=Low and TrySuspend [D]. Shown with SW_SHOWNOACTIVATE for popovers and toasts; activated only for the Alert, which needs keys.
- nook_panel: a normal activatable window with the Window look (52px titlebar on glass-strong, surface-1 body) for settings, monitors, 'Why not tiled' and keys.
- nook_palette (P6): the CommandPalette, glass-strong, radius-xl, upper third, 20px input.

BAR BUILDER
Follows the overlay.rs builder [V L404-423]: .decorations(false).transparent(true).shadow(false).skip_taskbar(true).focusable(false).focused(false).visible(false).resizable(false).always_on_top(false).
- PhysicalPosition and PhysicalSize instead of overlay.rs's LogicalPosition [V L402-403].
- After creation: WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE via SetWindowLongPtrW, and DWMWA_WINDOW_CORNER_PREFERENCE = DONOTROUND.
- Shown after the page's 'ready' call.
- WebView2 hosts its input in a child window, so a click might still activate the bar [I: P1 test]. If it does, focus.rs immediately hands foreground back to the previous window; Nook holds the rights from that click.

SIZE AND PLACE
- width = rcMonitor width; height = round(bar-height 28 * dpi/96); at (rcMonitor.left, rcMonitor.top). That is 2560x28 at (0,0) on DISPLAY1.
- Recomputed at settle end and on WM_DPICHANGED.
- Monitors are matched by device-interface id, never by \\.\DISPLAYn.

GLASS
- DWM acrylic is the only blur: DWMSBT_TRANSIENTWINDOW via Tauri's window effects, which use window-vibrancy 0.6.0 (transitive, Cargo.lock L8200 [V]; Apache-2.0 OR MIT), with a transparent page.
- The page strips every CSS backdrop-filter from .re-glass and .re-glass-strong (bundle.css L16-17 [V]). In a transparent WebView2 window it would only blur the page's own pixels and add GPU cost.
- The --glass fill alpha (light #f5f5f7b8 [V tokens.json]) is tuned so it reads over acrylic's own tint. The inset 1px glass-edge highlight (the lit edge) stays.
- A never-activated window may lose its backdrop. Nook sends WM_NCACTIVATE(TRUE) once [S*, PowerToys; P1 verifies on 26300].
- Skipped (solid surface-2, opaque chrome) when:
  - Windows transparency is off (HKCU ...\Themes\Personalize EnableTransparency=0, read like sight.rs L237 [V]);
  - high contrast is on (the contrast theme is forced);
  - game guard is tripped.
- The popover uses a near-opaque glass-strong fill with no DWM backdrop, so it can carry CSS radius-md and radius-lg corners.
- blur-chrome 30px and blur-menu 50px can't be set; DWM's acrylic radius is fixed (a documented gap).

CONTENT (left to right, per the Bar README [V])
- Workspaces: active pill solid accent with on-accent text; others ink-muted on surface-3. A dot marks the workspace holding the Hearth window when Pip is working or an approval waits. If the Hearth window isn't in a workspace, the dot shows on the Pip chip. Pills appear from P3.
- The focused app's name in bold: FileDescription from the exe's version resource, or the AUMID for UWP, cached per exe. Never UI Automation or MSAA on foreign apps, and never window titles. Menus only for Nook's own views (later).
- Spacer.
- Services status (status.rs).
- Pip.
- The clock, updated on the minute by one timer aligned to the minute.
- Only ink text sits on glass; muted text lives in the popover.

PIP IN THE BAR
- Idle: the static idle pose, like the Pip README's reduced-motion rule. The four infinite idle animations (bundle.css L188-190 [V]) don't run in the bar, so the idle bar presents 0 frames.
- Working (listening, thinking): the island grows horizontally from the chip over dur-base with ease-standard: Pip at 24px, one short phrase, and the stop key in Kbd (Hearth's cancel binding, default Escape [V settings.rs L998]). Pip's state animations run only while it works, end within 1 s of Pip finishing, and stop after 30 s without a state change.
- ease-spring only when Pip reacts to the owner (an acknowledgement, a 'happy' hop once).
- Everything pauses under prefers-reduced-motion (Rust also forwards SPI_GETCLIENTAREAANIMATION), on visibilitychange, and while hidden.
- The steps() timing-function idea is only a P1 experiment; the fix is not animating at idle.

THEME
- Choice: the Hearth web app sends hearth://theme/<id> from its own windows when the theme changes and at page load. Theme storage is per device, in localStorage 'hearth.theme' [V apps/web/src/lib/theme.ts].
- Rust stores the choice and emits it to the bar.
- 'system' follows AppsUseLightTheme [V sight.rs] and WM_SETTINGCHANGE ImmersiveColorSet.
- The bar sets data-theme and crossfades over dur-base.
- The resolved focus colour feeds the ring.

MODES
- Off (default).
- Overlay (P1): reserves no space; not topmost; tiles on that monitor start below the strip (komorebi-bar's offset model [S*, learn-only]); natively maximized windows cover the bar like a desktop widget.
- Reserve (P6, opt-in AppBar):
  - ABM_NEW with a registered callback message; ABM_QUERYPOS, then ABM_SETPOS with a physical rect, then SetWindowPos to the granted rect.
  - Redo on ABN_POSCHANGED.
  - ABN_FULLSCREENAPP: hide or restore.
  - ABM_ACTIVATE and ABM_WINDOWPOSCHANGED.
  - TaskbarCreated: ABM_NEW again.
  - Subclass the window with SetWindowSubclass on the Tauri main thread (tauri#11650 [S*]).
  - Journaled before ABM_NEW; ABM_REMOVE on every exit path.
  - Afterwards check rcWork; if space is still reserved, offer 'Restart Explorer'.
  - ABM_* is never called on the real taskbar.

FULLSCREEN AND GAMES
- Overlay: the bar and popover hide while game guard is tripped or the foreground covers rcMonitor.
- Reserve: ABN_FULLSCREENAPP drives it.
- Hidden webviews get IsVisible=false and TrySuspend.

MULTI-MONITOR
One bar per enabled monitor (DISPLAY2 off by default). Bars are recreated or moved at settle end; a missing monitor's bar is destroyed.

SERVER DOWN (a deploy restarts 4400)
The bar is local, so it keeps rendering. Services show 'Hearth isn't answering', Pip's last state ages out to idle, and the WM is unaffected.

DOCK
Not built; the Windows taskbar stays the dock (an owner question).

## Focus ring

Ships in P4, off by default. One setting: ring = Off | System | Nook.

SYSTEM (recommended default once the ring is on)
- On focus: DwmSetWindowAttribute(target, DWMWA_BORDER_COLOR (34), the theme's focus colour) on the focused managed tile.
- 'Others lose the border' (Window README [V]): the previously focused managed tile gets DWMWA_COLOR_NONE (0xFFFFFFFE). That is one call per focus change.
- On release, disable or recovery, each window Nook coloured goes back to DWMWA_COLOR_DEFAULT (0xFFFFFFFF), driven by the journal's border_set and the marker bit 8. Nook never touches windows it didn't colour.
- Windows 11 22000 and later [D]. It works on other processes' windows as komorebi's border implementation uses it [S*, learn-only]; P4 confirms on build 26300.
- Pros:
  - no window and no CPU;
  - drawn by DWM in sync with the window, so it never trails;
  - follows the real corner;
  - the worst failure is a leftover colour that recovery resets.
- Cons:
  - 1px, not the design's 2px;
  - an app's own custom border colour can't be read back, so it is lost after a reset (rule flag no_ring);
  - borderless games and some custom frames show no ring.

NOOK (design-exact 2px, opt-in)
Adapted from PowerToys AlwaysOnTop (MIT [S]):
- WindowBorder.cpp L98-132: WS_POPUP | WS_DISABLED with WS_EX_LAYERED | WS_EX_TOOLWINDOW. Nook adds WS_EX_TRANSPARENT | WS_EX_NOACTIVATE and drops PowerToys' WS_EX_TOPMOST, which exists there only because its target is topmost.
- Per-pixel alpha via DwmEnableBlurBehindWindow with an off-screen region, then SetLayeredWindowAttributes (L116-132).
- A Direct2D HwndRenderTarget with premultiplied alpha draws a rounded-rect stroke (FrameDrawer.cpp L55-81).
Behaviour:
- Placement: SetWindowPos(ring, hWndInsertAfter = target, the target's visual rect inflated by round(2 * dpi/96), SWP_NOACTIVATE | SWP_NOREDRAW), as PowerToys does at WindowBorder.cpp L176 and L193. The ring sits directly under the target in z-order and shows only in the 8 px gap; any window covering the target also covers the ring.
- The stroke is focus-border (2px * scale) in the theme focus colour, with a corner radius matching the target's real DWM corner (8 px at 100%), not radius-win 12px. Redrawn only when the size changes; moves are SetWindowPos only.
- Cost: GPU memory for a render target the size of the window (about 7 MB for a half-screen tile at 2560x1400, 14 MB full) [I], instead of a CPU DIB copy per resize.
- Rejected: the DirectComposition nine-slice proposal. It is more new code for a smaller memory gain on an opt-in path.
Follow:
- Nook moves or hides the ring itself whenever it places, hides or unhides the target.
- Otherwise it follows through F1 (the foreground pid's LOCATIONCHANGE).
- Re-inserted under the target after every FOREGROUND, since activation raises the target.
- Hidden during MOVESIZE, minimize, workspace switch, settle and game guard. Skipped for topmost targets and no_ring windows.
- Also draws the TileLayout accent line during a gap drag, and optionally a 140 ms ghost outline at a tile's new rect, never under reduced motion.

BOTH
- Only the focused managed tile has the ring, per the Window and TileLayout specs [V].
- 'Deepest shadow on the focused window': DWM already gives the active window a larger shadow [I]. Nook adds none, and gray traffic lights can't be drawn on other apps (a documented gap).
- Never HWND_TOPMOST; never above a fullscreen window.
- Ring HWND and border_set are journaled. Kill tests check that no window is left with an accent colour or DWMWA_COLOR_NONE.
- Budget: focus change to ring repositioned within 16 ms p95 (Nook ring); the System ring has no lag by construction.

## Keys and input

HOOK CHOICE
- RegisterHotKey with MOD_NOREPEAT on the dedicated nook-keys thread. No WH_KEYBOARD_LL or WH_MOUSE_LL from Nook, ever by default. Reasons:
  - a low-level hook runs for every keystroke system-wide;
  - Windows silently removes it after LowLevelHooksTimeout [D];
  - it adds input latency in games;
  - anti-cheat watches for it [I].
- Baseline: hearth.exe already installs system-wide WH_KEYBOARD_LL and WH_MOUSE_LL through handy-keys 0.3.4, the Windows default keyboard implementation (settings.rs L215-226 [V]; handy-keys src/platform/windows/listener.rs L367-371, with a 10 ms loop timeout at L33 and L165-170 [V]). Nook doesn't route through it, so a handy-keys problem can't take Panic with it. Narrowing that hook is a separate, recommended follow-up outside Nook.
- No mouse-modifier drags and no focus-follows-mouse.

DEFAULT KEYMAP
Registered whenever the WM is Active, from P2. One route out must always exist:
- Ctrl+Win+Alt+Backspace: Panic. Put every window back as before Nook, remove the ring, borders and reserved space, and turn the WM off.
- Ctrl+Win+Alt+P: pause or resume arranging.

Opt-in set (P5, keys_enabled; each binding can be switched off or rebound):
- Ctrl+Win+Alt+1..9: show workspace N on the monitor that has focus.
- Ctrl+Win+Alt+Shift+1..9: send the focused window to workspace N.
- Ctrl+Win+Alt+Left/Right/Up/Down: focus the neighbouring tile.
- Ctrl+Win+Alt+Shift+arrows: swap with the neighbouring tile.
- Ctrl+Win+Alt+Enter: make the focused window the main tile.
- Ctrl+Win+Alt+F: float or unfloat.
- Ctrl+Win+Alt+M: next layout.
- Ctrl+Win+Alt+Comma / Period: shrink or grow the main area.
- Ctrl+Win+Alt+R: arrange this monitor.
- Ctrl+Win+Alt+B: show or hide the bar.
- Launcher (P6): unbound until the owner picks a chord. The design's Win+Space (design/nook/README.md, Window manager behaviour [V]) is Windows' input switcher; Ctrl+Win+Alt+Space is proposed.

NEVER REGISTERED
- Alt+Space, Alt+digit, Alt+Tab.
- Win+Space, Ctrl+Win+Space.
- Win+digit, Shift+Win+digit, Ctrl+Win+digit, Win+Alt+digit (Explorer's taskbar keys). The Workspaces README's Win+1..9 [V] is a documented gap; Kbd tooltips show the real binding.
- Any chord with L (lock).
- Ctrl+Win+Left/Right.
- Win+arrows, Win+Shift+arrows, Win+Alt+Up/Down.
- Game Bar's Win+Alt+R/G/B/K/T/PrtScn.
- Ctrl+Win+Alt+V (PowerToys).
- Ctrl+Shift+Alt+Win+letters (the Office key).
- Hearth's own bindings: ctrl+space, ctrl+shift+space, ctrl+alt+space, ctrl+alt+j/h/n/k, escape [V settings.rs L898-998].
The Ctrl+Win+Alt+Shift set overlaps the Office Hyper chord with digits and arrows. Office registers letters only [I], and the probe checks.

CONFLICT POLICY
- At opt-in and on every rebind, probe each chord with RegisterHotKey then UnregisterHotKey. This is the PowerToys hotkey_conflict_detector approach (src/runner/hotkey_conflict_detector.cpp [S: file located; ported from its idea, not its code]).
- Also check Hearth's bindings and the deny list.
- A taken chord is never saved. ERROR_HOTKEY_ALREADY_REGISTERED (1409) at registration shows on that binding in the panel as 'taken by another app' and is logged. Nothing fails silently.

CONFIGURABILITY
- The panel's Keys section reuses the ShortcutBinding shape {id, name, description, default_binding, current_binding} [V settings.rs L86], with ids nook_panic, nook_pause, nook_ws_1..9 and so on.
- Chords are parsed with global-hotkey's HotKey parser: 0.8.0, Apache-2.0 OR MIT, already in Cargo.lock L2393 [V] through tauri-plugin-global-shortcut 2.3.1. Used via the plugin's re-export or as a direct dependency at the same version.
- Panic can be rebound but not removed.

LIFECYCLE
- Registered on enable; all unregistered on disable.
- Pause keeps only Pause and Panic.
- Game guard unregisters everything except Panic.
- Lock unregisters nothing; the session_locked gate pauses instead.
- Kbd caps in tooltips, palette rows and menus show the current bindings in Windows names (Ctrl, Alt, Win), per the Kbd README [V].

FOCUS (focus.rs)
- After WM_HOTKEY or a click, Nook holds foreground rights from that input [D] and calls SetForegroundWindow directly.
- Otherwise (bar commands, follow, unhide):
  1. SendInput one zero-move INPUT_MOUSE (MOUSEEVENTF_MOVE, dwExtraInfo = NOOK_MAGIC, so Hearth's handy-keys hook ignores it);
  2. SetForegroundWindow(target);
  3. confirm GetForegroundWindow() == target from a 50 ms high-resolution timer callback, never a sleep. If it isn't, log 'focus refused' and flash nothing.
- No Alt-key trick (it opens menus).
- Chromium's foreground handling (BSD-3-Clause [S license API]) is reference for the idea only.

## Safety

OPT-IN FLOW
1. Settings > Desktop in the web app [V DesktopSettings.tsx] gains 'Arrange windows (preview)', a hearth://nook-panel link that opens the local nook_panel.
2. While the panel is open, Nook runs in Observing mode: hooks only; the Desktop seam returns ReadOnly for every write. The panel lists the monitors (DISPLAY2 unticked) and every window with its verdict and reason. If hearth.exe is elevated, Observing is all it offers.
3. 'Try on DISPLAY1' starts the guard, arranges once, and shows the 'Keep this arrangement?' Alert with a 15 s countdown. 'Put back' is the primary, safe choice; no answer also puts the originals back.
4. Keep sets enabled=true in Manual mode and registers Pause and Panic.
5. Workspaces, auto-manage per app, bar, ring, keymap, Reserve, cloak and DISPLAY2 each have their own switch with a one-line explanation, all off.

PAUSE
- From the tray ('Pause window arranging'), Ctrl+Win+Alt+P, the bar and the panel.
- No writes while paused; state is kept.
- Automatic gates: game_guard, session_locked, settling, display_missing, remote_session, journal_failed, breaker. Gates are independent, so clearing one never clears another.

KILL SWITCH (layers; each puts the originals back and turns the WM off until re-enabled)
1. Panic chord, handled on its own thread.
2. Tray 'Put all windows back and turn off'.
3. Panel button.
4. `hearth.exe --nook-restore-windows`.
5. The file flag %LOCALAPPDATA%\app.hearth.desktop\nook\disabled, read at start.
6. Safe start after two unclean ends within 10 minutes.

GUARANTEED RESTORE
- Write-ahead journal (atomic replace, epoch, version, boot time) plus a SetPropW marker on each window.
- One idempotent restore_all in nook-restore, in a fixed order: revoke, ABM_REMOVE, uncloak, un-minimize Nook's windows (journaled placement keeps maximized state), placements by policy, DWM attributes on Nook-set windows only, props, clean, then a second pass at 1 s.
- Runs on every exit path:
  - disable; quit;
  - panic, tray, panel, CLI;
  - a nook thread's catch_unwind;
  - the guard: parent death, including taskkill, End task and the installer's kill; or 15 s of missed heartbeats while armed;
  - next start (same boot);
  - WM_QUERYENDSESSION (un-hide, borders, AppBar);
  - NSIS PREINSTALL (update: keep positions, clean-for-update) and PREUNINSTALL (originals). These run before CheckIfAppIsRunning [V installer.nsi L728-732, L880-884].
- Revocation: the event plus the epoch check make a slow WM unable to write after any restorer starts.
- Identity checks (hwnd + pid + creation time + marker) protect recycled HWNDs.
- Minimize hiding means that even if every layer fails, every window is in the taskbar.

REJECTED FAILURES FROM THE EARLIER ATTEMPT, AND THE FIX
- SW_HIDE with in-memory state → minimize, journal, guard, installer hooks.
- Alt+1..4 and Alt+Space with no off switch → zero hotkeys until enabled; Ctrl+Win+Alt family; Pause and Panic; probes; visible conflicts.
- Tiling everything, un-minimizing, pulling windows off DISPLAY2, grabbing games and dialogs → Manual adoption, UserMinimized respected, DISPLAY2 unmanaged, game paths and classes denied, dialogs floated.
- An AppBar never removed, sized in logical px, blind to fullscreen → no reservation by default; physical px; ABN_FULLSCREENAPP; ABM_REMOVE on every path, including the installer.
- Rescanning on every input → per-process hooks, foreground-only LOCATIONCHANGE, coalescing; EnumWindows only on enable, Arrange, settle end and the panel.
- On by default → off.
- A fullscreen topmost window at every start → no window until a capability is on; nothing monitor-sized; nothing topmost.

ANTI-CHEAT AND GAME POLICY
- No DLL injection, no SetWindowsHookEx with a DLL, no low-level hooks from Nook.
- No ReadProcessMemory or WriteProcessMemory. No process access beyond PROCESS_QUERY_LIMITED_INFORMATION, and none for windows that cheap checks already ignore (game classes are matched before any process open).
- No writes of any kind (position, props, DWM attributes) to windows under game paths, Riot or Vanguard processes, or fullscreen windows.
- No Nook window above a fullscreen app; the bar and popover hide.
- Non-panic hotkeys are unregistered while a game is in front.
- Acceptance includes a full League match with the WM on, the bar on and the ring on [I: Vanguard's tolerance can only be confirmed by running it; the owner's go-ahead is needed].

LOCAL SURFACE
- Nook chrome is bundled local pages with CSP, textContent only, and one label-checked, argument-validated command.
- hearth://theme is accepted only from Hearth's own windows, as an enum. OS deep links can at most open the panel.
- The restore CLI and the named events can only restore, which is always safe.
- Named objects live in the per-session Local\ namespace.

FAILURE REPORTING (local only)
- nook.log (rotating, 1 MB x 3) records: recoveries and how many windows each restored, by whom (guard, CLI, installer, thread unwind); placement errors; Busy windows; fights; hotkey conflicts; gate changes; journal failures; revocations.
- Window titles are never logged.
- The panel shows them, and Hearth's toast module [V hearth/toast.rs] sends a Windows notification, for example 'Nook put 7 windows back after Hearth stopped unexpectedly. Arranging is off until you turn it on.' Windows notifications are used even when the bar is on, so safety messages don't depend on Nook chrome.
- Nothing leaves the PC.

## Performance budgets

The PC also hosts the live Hearth server, so idle cost matters most. Every budget is a delta between Nook off and Nook on.

BUDGETS
nook-wm wakeups (context switches):
- 0/s with nothing managed;
- 0.2/s or less idle with 10 managed windows (the 5 s sweep);
- 20/s or less, and 0.5 ms CPU/s or less, while typing in a managed VS Code;
- 2% of one core or less while dragging a managed Chrome with a 1000 Hz mouse, with no breaker trip.

Guard:
- 0 wakeups disarmed, 0.2/s armed;
- private bytes 8 MB or less, measured as its own process.

Hook callback: 5 µs or less p99. Flush: 1 ms or less p99 with 50 windows.

Arrange (hotkey or command to the last target's LOCATIONCHANGE at its rect):
- p50 50 ms or less, p95 100 ms or less, for 4 windows;
- layout skew 33 ms or less p95.

Workspace switch, 6 windows, hotkey to the last incoming window at its final rect:
- 300 ms or less p95 with minimize, 60 ms or less with cloak (P6);
- first fresh frame 250 ms or less [I].

Pill click:
- new workspace visible within 100 ms p95;
- the pill itself updates optimistically within 16 ms, with the dur-fast transition.

Ring: focus change to ring repositioned within 16 ms p95 (Nook ring); the System ring has none by construction.

Bar:
- 0 presents/s idle;
- GPU Engine utilisation of its msedgewebview2 GPU process 0.5% or less idle, 3% or less with the island animating;
- renderer private bytes 60 MB or less, all Nook webviews together 90 MB or less, popover 15 MB or less while suspended;
- bar JS+CSS 25 KB or less gzipped (vanilla TS, a CSS subset);
- 0 network requests ever (CSP has no http connect-src).

Wallpaper Engine:
- tiled versus maximized windows over the owner's animated wallpaper: GPU delta 1% or less at idle [I: measured in P2];
- if the regression is real, the panel shows a one-time hint pointing at Wallpaper Engine's own 'other application focused: pause' option. Nook never changes Wallpaper Engine or system settings.

MEASUREMENT (owner-run, all headless via Start-Process -WindowStyle Hidden, per the owner's rule)
typeperf/PDH is per process, and hearth.exe already wakes about 110 times a second from handy-keys (10 ms loop at listener.rs L33, 100 ms recv_timeout at manager.rs L166-170 [V]). So Nook's numbers come from:
- per-thread QueryThreadCycleTime and wakeup counters exported by diag;
- ETW CSwitch through WPR (Input, Win32k and DWM-Core providers);
- QPC-stamped latency histograms;
- PresentMon on the bar's GPU process;
- 'GPU Engine' counters per pid;
- ICoreWebView2Environment8::GetProcessInfos to find each Nook window's renderer pid, plus GetProcessMemoryInfo PrivateUsage;
- a 240 fps capture for switch and first-frame timing.
nook-wm's memory is tracked as live map and journal bytes, not working set.

SCENARIOS (scripted, shipped in P1, run with Nook off and on; diag writes a JSON export)
- 60 s idle;
- typing in VS Code;
- dragging Chrome with a 1000 Hz mouse;
- Alt-Tab spam at 5/s for 10 s;
- YouTube fullscreen and windowed;
- 20 switches of a 6-window workspace;
- a server restart (bar keeps rendering).

COALESCING
- Callback writes into a per-HWND map; leading-edge flush, trailing flush at 16 ms on a high-resolution waitable timer.
- Hotkeys and bar commands bypass the coalescer.
- LOCATIONCHANGE only from the foreground managed pid, and never during drags.
- No NAMECHANGE hook.
- Global SHOW/HIDE only in Auto mode or while the panel is open.
- NookState published on the leading edge, trailing edge at 100 ms.
- Journal written only on safety changes; state.json every 2 s or less.

CACHES
- exe, FileDescription and elevation per (pid, proc_start);
- verdict stages per HWND (negative ones until DESTROY);
- frame offsets per HWND, until a DPI change;
- monitors, until settle ends;
- virtual-desktop id per HWND, until CLOAKED or UNCLOAKED;
- SHQueryUserNotificationState for 250 ms;
- rules compiled once (regex is already a dependency [V Cargo.toml L70]).

NO-OP AVOIDANCE
- Moves are skipped against last_set.
- SWP_NOCOPYBITS only on size change.
- Only dirty workspaces are laid out.
- Hidden webviews are suspended.

CIRCUIT BREAKERS
They count ledger-miss, non-drag events and unexpected placements only, so ordinary use and user commands never trip them.

FOLLOW-UP OUTSIDE NOOK (recommended, not part of these phases)
Move Hearth's own chords to RegisterHotKey where possible, and drop handy-keys' WH_MOUSE_LL unless a mouse binding is configured. That removes system-wide input latency and about 100 wakeups/s from hearth.exe.

## Testing

1. PURE UNIT TESTS (cargo test; no Windows needed for layout, rules, journal, ledger or gates)
- layout.rs property tests: no overlaps; gaps exactly g; the union stays inside the area; deterministic; n from 0 to 16; scales 1.0, 1.25, 1.5 and 2.0; origin offsets like DISPLAY2 at (2560,0); the workspace-coordinate conversion with bottom, top and left taskbars and a Reserve bar.
- Eligibility table tests from WindowInfo fixtures captured on the owner's PC in P1. Fixtures hold class, exe, styles, owner, cloaked state and elevation, never titles. Apps covered:
  - Chrome, Edge, VS Code, Discord, Notion, Claude, Teams, Docker Desktop;
  - Steam, Epic, EA, Overwolf;
  - Riot Client and League;
  - Wallpaper Engine, WorkerW, Progman;
  - Explorer, Settings, Task Manager, Calculator;
  - #32770 dialogs and the NVIDIA overlay.
  The tests assert the staged order: process facts are never requested for Stage-A ignores.
- Rule precedence; the rules/default.json translation.
- Journal: round trip; truncated, corrupt, wrong-version and other-boot files; epoch refusal; atomic replace.
- Gates: settle ending under game_guard runs no pass; display_missing for 30 s, then that monitor restored; remote_session.
- Ledger and coalescer from scripted traces: late echoes; a restore burst of more than 3 within 250 ms dissolves and doesn't follow; Alt-Tab spam doesn't trip the breaker.
- Recovery under fault injection: FakeDesktop panics after k writes for every k, then restore_all runs, and the final state must equal the pre-Nook state. This includes a 'stalled WM' fault: the WM is delayed 3 s mid-pass while a restorer runs, and the WM's later writes must all fail with Revoked.
- Unhide of a window minimized while maximized comes back maximized.
- Web/desktop UI: tokens per theme (light, dark, midnight, dusk, paper, contrast) generated and checked like apps/web/src/lib/tokens.test.ts [V]; pill states; Kbd reading real bindings; reduced motion stops every animation; the idle bar has no running CSS animation (getAnimations().length == 0 while idle); no backdrop-filter in nook.css.

2. WINDOWS INTEGRATION ON THE SELF-HOSTED RUNNER (session 0, headless, never cancelled while running [V owner rule])
- Each test creates a private desktop with CreateDesktopW('NookTest-<n>'). The nook-testwin example creates windows there with chosen styles: captioned, owned, tool, topmost, fixed-size, minimize-to-tray, maximized, hung (stops pumping).
- A test-host stub runs the WM engine without Tauri (WebView2 isn't needed). It is killed with TerminateProcess by pid, never by name.
- Covered: hooks, verdicts, SetWindowPos with frame compensation, minimize hide and unhide (including maximized), markers, journal, guard (double-spawn, breakaway, heartbeat), CLI, revocation races.
- Kill tests: 200 randomized runs that TerminateProcess the host, the guard, or both, at random points (before or after a journal write, mid-hide, mid-restore, mid-second-pass). Afterwards, no window may be still minimized by Nook, cloaked, carrying a marker, or coloured.
- Installer tests (silent /S and /UPDATE over a running host) run only when the runner's account SID differs from the owner's, or in Windows Sandbox or a VM. tauri-bundler's CheckIfAppIsRunning kills every hearth.exe of the current user (utils.nsh L33-47 [S]), so on the owner's own account it would kill the live app. Otherwise they are skipped in CI and covered by the owner checklist.
- DWM-dependent behaviour (cloak, border colour, backdrop, extended frame bounds, transitions) may not work without an interactive session [I], so it gets owner-PC checks.

3. OWNER-PC ACCEPTANCE CHECKLIST PER PHASE (in the owner's session, only with the owner's go-ahead)
- a League match with Nook on (Vanguard);
- Wallpaper Engine running, with the GPU delta measured;
- DISPLAY2 rects unchanged (snapshot diff);
- a Teams call;
- taskkill /f /im explorer.exe, then restart it;
- Task Manager End task on Nook (the guard restores);
- sleep and resume, with a slow DisplayPort wake;
- unplugging DISPLAY2;
- a UAC prompt; an RDP connect;
- logoff with workspaces hidden;
- reinstall over a running app (resumes), and uninstall (restores, removes nook\bin);
- a deploy restarting the 4400 server (bar keeps rendering).

4. PERF SCENARIOS AND SOAK
- The scripted scenario set from performance, run per phase with Nook off and on.
- 24 h soak on the live PC with the server running. Pass: zero recoveries needed, no unresolved fights, every budget met.

5. SCREENSHOTS
The UI screenshot rig on 4472/5499 [memory] provides before and after images of the panel. The bar is screenshotted with PrintWindow from a hidden test run.

## Phases

### P0: safety rails, guard, installer hooks (no foreign window touched)
**Scope.** Packages and files:
- crates/nook-restore: journal v2, identity, restore_all with two passes, named objects (Restore, Revoked, Done, Armed, the Beat section, the Journal mutex), the Desktop trait with Real/Fake implementations, cli::maybe_run.
- nook-guard.exe: double-spawn detach, heartbeat, copied to nook\bin at enable.
- The build:guard step and externalBin in tauri.windows.conf.json.
- The main.rs branch before CliArgs::parse.
- catch_unwind wrappers and the chained nook-only panic hook.
- nsis/hooks.nsh (PREINSTALL update, PREUNINSTALL uninstall, POSTUNINSTALL removes bin) plus installerHooks in config.
- The prepare_update call in UpdateChecker.
- Tray items (no-ops until P2), the disabled file flag, safe start.
- diag and nook.log; the nook-testwin example; the test-host stub.
- nook/settings.rs, all off.
Writes are exercised only on test windows on private desktops.
**Exit criteria:**
- 200 randomized kill runs (host, guard, both) with simulated adopt, hide (including maximized) and border writes leave 0 windows minimized, cloaked, coloured or carrying a marker.
- The stalled-WM revocation test passes: 0 writes after revoke.
- A same-boot dirty journal is restored at start; another-boot or other-version journals are handled conservatively.
- A corrupt journal falls back to the marker sweep.
- The guard is not in hearth's process tree and survives taskkill /T. It uses 0 wakeups disarmed and 8 MB private or less.
- Silent install over a running host ends in 'clean-for-update' and resumes; uninstall restores and removes nook\bin (Sandbox or VM, or a different-SID runner).
- While disabled, no hook, hotkey or window exists (IsWinEventHookInstalled on the private desktop, a RegisterHotKey probe, EnumWindows).
- cargo test and pnpm check:size pass.
### P1: observer and a read-only bar (first visible deliverable)
**Scope.** WM side:
- hooks (global G1-G5; per-pid P1/P2; foreground-pid F1);
- the in-callback coalescer with leading and trailing flush;
- window.rs; staged eligibility; rules.rs and default.json (translated komorebi-asc subset);
- monitors.rs with stable ids; the shell thread; every gate (settle, display_missing, remote_session, game guard); vd.rs;
- diag with per-thread counters, and the perf scenario script.
UI:
- nook_panel (local React): monitors and 'Why not tiled';
- nook_bar on DISPLAY1 in Overlay mode (local vanilla TS): focused app name, clock, services, static idle Pip, and the island in the bar while Pip works;
- nook_popover, pre-warmed and suspended;
- the hearth://theme link from Hearth's windows; nook.css generated by scripts/nook-themes.ts with a check test;
- capabilities/nook.json and the nook_ui command.
Experiments recorded:
- DWMWA_TRANSITIONS_FORCEDISABLED on a foreign Chrome window;
- per-pid LOCATIONCHANGE noise;
- Chromium CPU with and without hooks;
- click activation in the WS_EX_NOACTIVATE bar;
- acrylic on a never-activated window.
Mode is Observing; every write is refused.
**Exit criteria:**
- 24 h on the owner's PC: nook-wm meets its wakeup budgets.
- Zero write calls to foreign windows (counted).
- The owner reviews the verdict list and it matches every running app. Progman, WorkerW and Wallpaper Engine are never eligible; Riot and Steam games are Ignored without their processes being opened when a class matched; elevated windows show their reason.
- Fixtures captured.
- The bar is exactly 2560x28 at (0,0); presents 0 frames/s at idle (PresentMon); renderer 60 MB or less; 0 network requests.
- It never shows over a fullscreen game or video.
- A bar click doesn't move the foreground (or focus.rs restores it).
- The bar keeps rendering while the 4400 server restarts.
- It follows all six themes and reduced motion.
### P2: arrange on demand (DISPLAY1 only), with Pause and Panic
**Scope:**
- layout.rs (the four layouts);
- place.rs (frame compensation, DPI second pass, shrink-first bursts, NOCOPYBITS on size change only);
- ledger.rs with late-echo matching and Busy;
- Manual adoption;
- 'Arrange this monitor' from the panel, tray and bar popover;
- 'Try' with the 15 s Keep/Put back Alert;
- drag to swap; gap resize;
- 'Put back' (originals);
- fight detection; breakers;
- nook-keys with Pause and Panic only;
- the guard armed from the first adopt.
No workspaces, no auto-manage.
**Exit criteria:**
- For the owner's 10 main apps, visual gaps are exactly 8 px between tiles and to the edges.
- 'Put back' returns every window to its exact pre-arrange WINDOWPLACEMENT.
- DISPLAY2 rects are byte-identical before and after.
- No minimized or maximized window is touched.
- Arrange p95 is 100 ms or less end to end; skew 33 ms or less.
- Kill tests with real placements leave 0 marked or misplaced windows.
- Panic works with nook-wm deliberately hung.
- The Wallpaper Engine GPU delta is measured, and the hint is shown if needed.
- Correct at 125% and 150% on a test monitor or VM.
### P3: workspaces via minimize
**Scope:**
- workspace.rs and hide.rs (Minimize): journaled hide_placement; unhide straight into the tile; maximized windows preserved; incoming shown before outgoing hidden;
- workspaces 1-9 per (virtual desktop, monitor) on DISPLAY1;
- send to workspace;
- follow with a 150 ms quiet window, and burst dissolve;
- tray detection and sticky defaults;
- state.json;
- resume after update;
- Workspaces pills in the bar, with the Pip dot;
- the bar popover window list;
- Auto mode for an allowlist the owner picks.
**Exit criteria:**
- 200 randomized kill runs during switches leave 0 windows minimized by Nook after recovery.
- A switch of 6 windows takes 300 ms or less p95 (honest minimize budget); first fresh frame 250 ms or less.
- A window maximized before hiding comes back maximized.
- Restoring one hidden window from the taskbar switches to its workspace; Win+Shift+M dissolves and pauses without follow thrash.
- 0 windows the user minimized are ever un-minimized.
- After logoff with workspaces hidden and logon, apps reopen visible.
- Explorer restart and sleep/resume settle without wrong placements.
- An update over a running app resumes the arrangement.
### P4: focus ring
**Scope:**
- ring.rs System mode: DWMWA_BORDER_COLOR accent on the focused tile, COLOR_NONE on other managed tiles, DEFAULT on release; only windows Nook coloured are journaled and reset.
- Nook 2px mode adapted from PowerToys AlwaysOnTop (MIT): D2D layered window placed directly behind the target, the gap-drag accent line, an optional 140 ms ghost outline.
- Hide rules, and the theme focus colour from the bar.
**Exit criteria:**
- After kill tests no window keeps an accent colour or COLOR_NONE.
- Cross-process DWMWA_BORDER_COLOR works on build 26300.
- The Nook ring repositions within 16 ms p95 of FOREGROUND, is hidden during drag, minimize, switch and game guard, uses 0% CPU idle, and never sits above a window that overlaps the target.
### P5: opt-in keymap
**Scope:**
- keys.rs full keymap: probe against other apps, Hearth's bindings and the deny list; rebinding in the panel (ShortcutBinding shape); game-guard unregistering;
- focus.rs with the SendInput unlock and timer-based verification;
- Kbd tooltips everywhere showing the real chords.
**Exit criteria:**
- Zero hotkeys while disabled; only Pause and Panic while keys are off (probe-verified).
- Alt+Space, Alt+digit, Win+Space and Win+digit are never registered.
- Conflicts show on the binding and are never silent.
- Focus commands land at least 99% of the time, with refusals logged.
- Games keep every chord during a match.
### P6: optional extras
**Scope:**
- nook_palette (CommandPalette: Views via hearth://open, Windows, Actions, Ask Pip) on the chord the owner picks;
- per-app rules editor in the panel;
- DISPLAY2 management (Columns) and a bar on DISPLAY2;
- appbar.rs Reserve mode (subclassing, ABN_FULLSCREENAPP, TaskbarCreated, ABM_REMOVE on every path including the installer hooks);
- cloak hiding behind a verified-build IID table from AltTabAccessor/VirtualDesktopAccessor (MIT);
- an in-process adapter to tile the Hearth window, if the owner wants it.
**Exit criteria:**
- After kill tests rcWork is restored (GetMonitorInfo, SPI_GETWORKAREA), or the Explorer-restart prompt is shown.
- Cloak kill tests leave 0 stranded windows; unknown builds refuse cloak and fall back to minimize.
- DISPLAY2 tiles only when turned on, and turning it off puts the originals back.
- The palette opens within 100 ms (pre-warmed) and closes on Esc.

## What we reuse, and under which license

ADAPT (ported to Rust with a file header naming the origin and commit, plus a NOTICE.md row in its existing table format [V NOTICE.md])

- PowerToys (MIT, Microsoft Corporation [S license API]):
  - src/modules/alwaysontop/AlwaysOnTop/WindowBorder.cpp: border window styles L98-110; DwmEnableBlurBehindWindow per-pixel-alpha trick L116-132; z-order directly behind the target L136-140, L176, L193 [S].
  - FrameDrawer.cpp: D2D HwndRenderTarget with premultiplied alpha and rounded-rect border geometry, L55-81 and L235+ [S].
  - src/modules/fancyzones/FancyZonesLib/FancyZonesWindowProperties.cpp: SetProp stamping and removal, L14-94 [S].
  - FancyZonesWindowProcessing.cpp: tool-window and caption filters, L25-44 [S].
  - WindowUtils.cpp: IsWindowMaximized, HasVisibleOwner, IsRoot, IsExcluded, L109-170 [S].
  - src/runner/hotkey_conflict_detector.cpp: located [S]; Nook ports the probe idea.
  - The WM_NCACTIVATE backdrop trick [S*: location to be pinned when porting].
- Whim (MIT [S license API]), src/Whim/Native/CoreNativeManager.cs [S]: IsSplashScreen L101, IsStandardWindow L145-190, IsSystemWindow L194, HasNoVisibleOwner L213, IsCloakedWindow L240, and its system-class list.
- workspacer (MIT [S license API]): default ignored classes and exes [S*].
- LGUG2Z/komorebi-application-specific-configuration (MIT [S license API], copyright line kept): a subset of applications.json translated into rules/default.json. This is a separate repository from komorebi.
- Ciantic/AltTabAccessor and Ciantic/VirtualDesktopAccessor (MIT, LICENSE.txt [S license API]): IApplicationView and IApplicationViewCollection vtable layouts and per-build IIDs. P6 cloaking only.
- Chromium (BSD-3-Clause [S license API]): the foreground-rights idea only. Nook writes its own zero-move SendInput version and attributes it only if code is ported.

FRAMEWORK FACTS RELIED ON (read, not copied)
- tauri-v2.11.5 crates/tauri/src/webview/mod.rs L1698-1740 (is_local_url) and L1785-1850 (local pages may call app commands without an app ACL manifest; remote pages may not) [S].
- tauri-bundler crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh L22-62: CheckIfAppIsRunning uses FindProcessCurrentUser and KillProcessCurrentUser by exe name, and kills without asking when silent [S].
- Hearth's own installer.nsi already calls the NSIS_HOOK_* macros before that check (L728-732, L880-884) and includes installer_hooks when configured (L35-37) [V].

ALREADY IN THE TREE, USED AS IS [V Cargo.toml / Cargo.lock]
- windows 0.61.3 (MIT OR Apache-2.0), with features added;
- tauri 2.11.5 (Apache-2.0 OR MIT);
- tao (Apache-2.0 OR MIT), patched to cjpais rev c3bee28 [V Cargo.toml L201];
- window-vibrancy 0.6.0 (Apache-2.0 OR MIT; transitive, Cargo.lock L8200; used through Tauri's window effects);
- global-hotkey 0.8.0 (Apache-2.0 OR MIT; transitive, Cargo.lock L2393), for chord parsing;
- tauri-plugin-global-shortcut 2.3.1;
- webview2-com 0.38 (MIT), for GetProcessInfos, TrySuspend and MemoryUsageTargetLevel;
- winreg 0.55 (MIT);
- regex 1 (MIT OR Apache-2.0) [V L70];
- serde and serde_json;
- handy-keys 0.3.4 (MIT), not used by Nook.
No new third-party crates.

Hearth's own code reused:
- the overlay.rs builder and its WebviewUrl::App local page, in physical units;
- the apps/desktop multi-entry Vite config;
- hearth/foreground.rs process query;
- sight.rs registry reads;
- links.rs and window.rs navigation handling;
- toast.rs; status.rs; client.rs notify_feed;
- the settings store; the ShortcutBinding shape;
- scripts/nook-themes.ts and the tokens test;
- design/nook tokens.json and components/bundle.css (Hearth's own, MIT [V NOTICE.md]).
The desktop crate is MIT, derived from Handy (cjpais/Handy, MIT [S license API]).

LEARN ONLY (ideas only: no code, data or translated snippets; listed on NOTICE.md's ideas-only line)
- komorebi and komorebi-bar (Komorebi License 2.0.0, LICENSE.md; source-available, not OSI open source [S license file]): hiding and cloaking strategies, border implementations, the work-area offset model, the DPI double set, failure modes.
- GlazeWM and Zebar (GPL-3.0 [S license API]): event handling, the cloak-recovery bug #1358, bar window setup.
- Seelen UI (AGPL-3.0 [S license API]): minimize-based workspaces, AppBar handling.
- AltSnap (GPL-3.0, License.txt [S license API]).
- AutoHotkey (GPL-2.0 [S license API]).
- Rainmeter (GPL-2.0 [S license API]).
- ReactOS: mixed, mainly GPL-2.0 (COPYING) with LGPL-2.1 (COPYING.LIB) and GPL-3.0/LGPL-3.0 parts (COPYING3, COPYING3.LIB); each file's header decides [S].
- FancyWM: PolyForm Perimeter 1.0.1 [S license file]. The draft said 1.0.0, which was wrong.
- Learn-only by choice, though MIT or BSD:
  - YASB (MIT);
  - Windows Terminal (MIT);
  - AeroSpace (MIT);
  - Amethyst (MIT);
  - Rectangle (MIT, includes Spectacle MIT);
  - yabai (MIT);
  - sway (MIT);
  - i3 (BSD-3-Clause);
  - Hyprland (BSD-3-Clause);
  - win-hotkeys (MIT, iholston) [all S license API].

VERIFICATION LEVELS
- License identities above come from GitHub's license API or the license file, read this pass. Each one is re-checked at the exact commit before porting.
- Upstream line numbers are from the default branch read this pass and will be pinned to a commit in each file header.

## Decisions for the owner

- Focus ring: is the system border enough (1px accent on the focused window, other tiles' borders removed, no extra window, can't lag)? Or do you want the design's 2px ring, which needs a small window behind the focused app and some GPU memory?
- Menu bar space: should maximized windows stop below the bar ('Reserve', a real AppBar; after a crash the space comes back only through recovery or an Explorer restart)? Or should the bar sit behind maximized windows like a desktop widget ('Overlay', the safe default)?
- DISPLAY2, the 2560x1080 ultrawide: leave it untouched, or tile it in columns once you turn it on? And should it get its own bar?
- Which apps should tile automatically when they open? Proposed: Chrome, Edge, VS Code, Notion, Claude, Terminal, Explorer. The alternative is only when you press Arrange. Discord, Steam, Epic, EA, Overwolf, Spotify and Docker Desktop stay sticky by default, because they hide to the tray.
- Workspace keys: Windows owns Win+1..9 and Win+Space. Are Ctrl+Win+Alt+1..9 OK, with Ctrl+Win+Alt+Space proposed for the launcher? Or do you want Win+1..9 taken over through a keyboard hook, which Nook otherwise refuses because of games and anti-cheat?
- Hidden workspaces: is it fine that their windows still show in the taskbar (minimized, the safe default)? Or do you want them gone from the taskbar (cloaking: faster, relies on undocumented Windows internals, opt-in only)?
- Switching speed: if Windows won't let Nook skip the minimize animation for other apps' windows, each switch takes about a quarter second with the system animation. Accept that, or turn off Windows' 'Animation effects' yourself? Nook won't change that setting.
- When you turn arranging off normally (not Panic), should windows go back to where they were before Nook, or stay where they are tiled? Panic, 'Put all windows back' and uninstall always return the originals; updates always keep positions.
- After Hearth crashes or is killed, should Nook put windows back to their pre-Nook positions (proposed), or only un-hide them and leave them where they are tiled? And should it stay off until you turn it back on (proposed), or come back on at the next start if the restore went cleanly?
- Should the main Nook window be tiled like other apps (it needs a small in-process adapter), or always float? Ask, quick capture and Nook's bar and popovers never tile.
- In the bar, idle Pip holds still, so the bar costs nothing when nothing happens; it moves only while it works. OK, or do you want an occasional blink?
- The design's Dock: skip it and keep the Windows taskbar (proposed), or build it later?
- Your Vanguard check: when P1 to P4 are ready, can we run one League match with Nook on (bar and ring on) as the acceptance test?

## Risks

- Undocumented cloak COM: the IIDs change between Windows builds, and 26300 is an Insider build. Mitigation: a verified-build table, opt-in only, minimize fallback, and recovery always uncloaks.
- Minimize hiding:
- the system animation plays if DWMWA_TRANSITIONS_FORCEDISABLED doesn't apply to foreign windows (P1 finds out);
- Chromium and Electron may show stale content for a few frames after restore;
- apps that pause while minimized;
- a crowded taskbar.
The 300 ms budget is honest, but slower than tiling WMs that cloak.
- A tray app hiding itself right after Nook's minimize makes it blink once before it becomes sticky. Known tray apps are pre-marked to avoid this; unknown ones learn after one occurrence.
- Apps that fight placement (Electron minimum sizes, apps that restore their own saved bounds, launchers). Mitigated by learned minimum sizes, one retry, fight detection, and Busy for hung apps so slow apps such as Teams aren't mistaken for fights.
- WinEvent volume: per-pid hooks may still deliver caret or cursor LOCATIONCHANGE from the foreground managed app while typing. WinEvent hooks may also make Chromium do accessibility work [I]. P1 measures both; the fallbacks are dropping F1 and relying on MOVESIZE plus the sweep.
- Guard sidecar build: externalBin needs the guard built before `tauri build`, with a second Cargo.lock to keep in step (both pin windows 0.61.3). A missing guard binary must fail the build, never ship silently without a guard.
- Detaching from Task Manager: whether End task on the Nook group also kills a double-spawned, breakaway guard is not documented [I]. P0 tests it. If it does, the next-start recovery and the minimize invariant still hold.
- Installer tests: tauri-bundler kills every hearth.exe of the current user. CI installer tests must never run under the owner's account on the live PC; they run in Sandbox, a VM or under a different-SID runner.
- Local pages can call any app command: Tauri 2.11.5 allows this for local origins without an app ACL manifest, as recording_overlay can today. Mitigation: CSP, textContent only, no titles, and one label-checked command. Rejected for now: adding an app ACL manifest, because it would gate every existing command and needs a capability audit of the main window. Recorded as a hardening follow-up.
- WebView2 clicks in a WS_EX_NOACTIVATE window may still activate the bar through its child input window [I]. Mitigation: focus.rs hands foreground back; P1 verifies.
- Acrylic on a never-activated window may fall back to solid. The WM_NCACTIVATE(TRUE) trick is reported, not verified on 26300 [S*]; the fallback is the opaque surface-2 bar.
- AppBar after a hard crash: Explorer may keep the reserved space for a dead HWND until ABM_REMOVE or an Explorer restart. Reserve is opt-in and is removed by the guard, next start and the installer hooks.
- Anti-cheat: Vanguard's tolerance of window managers is undocumented. Mitigations: no injection, no low-level hooks from Nook, no writes or process opens for game windows, chrome hidden in games. hearth.exe already carries handy-keys' low-level hooks today. Only a real match proves it.
- Monitor loss: a DisplayPort monitor that wakes more than 30 s late gets its windows restored and Nook turned off for it. Safe but mildly annoying; the window is tunable.
- RDP and Tailscale remote sessions: Nook un-hides everything and pauses. A remote user sees an un-arranged desktop until they resume.
- Journal writes blocked (an antivirus lock on rename, a full disk) pause Nook by design. Repeated pauses would look like 'Nook doesn't work'; the panel shows the reason.
- Hotkeys can collide with less common apps that use Ctrl+Win+Alt. The Office Hyper key's behaviour with digits and arrows is uncertain; the probe covers what RegisterHotKey can see.
- WebView2 memory: the bar renderer plus the suspended popover come to about 60-90 MB on a PC that also runs the server. Mitigated by one bar by default, suspension, and no web app in Nook's chrome.
- Wallpaper Engine: tiled windows may keep an animated wallpaper rendering where maximized windows would pause it. Measured in P2; the owner gets a hint and Nook never changes Wallpaper Engine.
- Patched tao (cjpais rev c3bee28): style changes and P6 subclassing may interact with tao's window procedure. PMv2 is set by this rev [V], but could change with a tao bump; nook threads assert it.
- Theme sync depends on the web app sending hearth://theme from Hearth's windows. A squatter on 4400 could only change the bar's theme, from an enum.
- Design-system gaps are recorded, and each README gets a note so design and implementation agree:
- other apps' corners stay 8px, not radius-win 12px;
- the system ring is 1px unless the 2px ring is chosen;
- gray traffic lights and per-tile labels can't be drawn on other apps;
- Win+Space and Win+1..9 are Windows' own;
- DWM's acrylic radius is fixed;
- dur-slow window moves aren't animated;
- idle Pip is still in the bar.
- Rejected review suggestions:
- DirectComposition nine-slice ring: PowerToys' D2D layered window is MIT and proven; the memory difference only matters on an opt-in path.
- Explicit PMv2 manifest: tao sets PMv2 at runtime [V], and replacing tauri-build's manifest risks its other entries.
- Cancelling pushState in on_navigation: WebView2 doesn't raise NavigationStarting for same-document navigations [D]; superseded by local bundled pages.
- A per-boot URL token echoed by the server: superseded by local pages.
- A Run key for the guard: unnecessary, since the guard lives only while Hearth runs or until it finishes a restore.
- steps() timing as the main fix for the bar: it is only an experiment, because the real fix is no idle animation.
