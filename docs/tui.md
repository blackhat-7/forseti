# Forseti terminal dashboard

The dashboard uses the pinned Pi TUI package, not the global Pi runtime. It opens in the alternate screen with a near-black base, one indigo accent for anything interactive, and colour used only where it carries meaning: green for enabled and passing, amber for warnings and metered billing, rose for not-ready credentials, teal for subscription billing. Navigation sits in a fixed header; the footer carries the status line and, on its last line, the keys that work where you are. The center panel scrolls with Page Up/Page Down or the mouse wheel. Layout and text work at 40, 80, and 120 columns. Above ~80 columns the list views and Home split into two panes; below that they stack.

Every table in the UI has one shape: a left-aligned name column, then right-aligned figures. Runs are listed by when they ran, how each model did and their shape (tests × repeats), with the selected run's headline table under the list, so a run is found by what it showed rather than by its hash.

## Keys

- **Tab / Shift+Tab, 1–5, ←→:** Home, Models, Tests, Runs, Settings.
- **↑↓ / j/k:** select a row. **Space:** toggle a model/test or select a run.
- **a:** add a model or test. Model search accepts provider, ID, or name; use arrows and Enter to choose, then explicitly choose existing authentication. Test creation asks for a lowercase ID, one-line prompt, and valid expected JSON.
- **d:** remove a model/test from configuration. Only **y** confirms. Test files and saved evidence remain intact.
- **− / +:** repetitions, from 1 to 20. **l:** tools/prompt lane. **p:** prompt caching on/off.
- **r:** preflight. Review enabled models/tests, authentication, billing, and limits before Enter. Metered/unknown billing then requires typing **PAY** and Enter. Consent applies to one run only; there is no dollar spending cap.
- **Esc / Ctrl+C during a run:** cancel and retain partial results. Wait for cancellation to finish before quitting.
- **Runs → c:** compare selected runs, or the highlighted run when none are selected. The scorecard is one table per candidate (headline bar, ± for how far it would move on a rerun, partial credit, the other dimensions, graded count), then **What this run can tell apart**: one line per pair and kind of task whose gap beats two standard errors of the difference, stated as "X over Y +N pts · k tasks"; pairs tied overall are named so the order is never read as a ranking. Below it, correctness by kind of task and the tasks where candidates differ. **a** shows every task; **m** toggles the full markdown report. **Enter:** inspect individual trials and check-level evidence; **←→** changes trials; **↑↓** scrolls a line, **space/b** a page, **gg/G** jump to top/bottom. **e:** export selected/highlighted runs through the app to workspace reports.
- **Settings → space on Address:** point at a local OpenAI-compatible server (llama-server, Ollama, LM Studio). Enter saves it and lists its models; the picker lists them under `local/` and asks for no credential. Opening the picker asks the server once if it has not been asked yet. Nothing is asked at startup.
- **R:** refresh local metadata without sending prompts. **?:** help. **q / Ctrl+C:** quit when idle. **Esc:** close a form/dialog without saving.

Synthetic controls are explicitly labeled. Unavailable authentication is visible, not silently replaced with a different credential source. Preflight uses `App.authFor(model)` for the explicitly selected authentication mode, not catalog defaults. The runner independently validates effective authentication and enforces billing consent.

All external text is stripped of terminal commands, control characters, and bidi overrides before rendering. Native Input/SelectList handle editing and selection. Inherited terminal-stream logging is disabled when creating ProcessTerminal; renderer diagnostic paths stay under the app workspace.

`Dashboard(app, repaint?, exit?)` accepts the UI-facing fields/methods of `App`, making keyboard and render tests independent of live providers. `.handleInput(rawKey)` drives interaction; `.render(width)` returns styled terminal lines. Optional render regions (`header`, `body`, `footer`) support fixed-pane composition. `launchTui(app)` owns terminal start/stop, not backend initialization.

Run `node --test tests/ui.test.ts` from the workspace. To capture mock-only screens without a terminal or provider calls, run `FORSETI_UI_ARTIFACTS=1 node --test tests/ui.test.ts`. It writes ANSI and plain-text snapshots for ten screens at 40/80/120 columns under `.cache/ui-artifacts/`. `npm run screenshot [home|models|tests|runs]` renders the same component over real workspace state to an SVG in `docs/`.
