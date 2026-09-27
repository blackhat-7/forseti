# Forseti terminal dashboard

The dashboard uses the pinned Pi TUI package, not the global Pi runtime. It opens in the alternate screen in the Kanagawa Dragon palette: a warm near-black base, one blue-grey accent for anything interactive, and colour used only where it carries meaning: green for enabled and passing, yellow for warnings and metered billing, red for not-ready credentials, aqua for subscription billing and a local server. Navigation sits in a fixed header; the footer carries the status line and, on its last line, the keys that work where you are. The center panel scrolls with Page Up/Page Down or the mouse wheel. Layout and text work at 40, 80, and 120 columns. Above ~80 columns the list views and Home split into two panes; below that they stack.

Tables have one shape: a left-aligned name column, then right-aligned figures. Runs are listed by when they ran, each model's score and the run's shape (tests × tries), with the selected run's scores under the list, so a run is found by what it showed rather than by its hash. Tests show their difficulty, the skills they test in plain words, what they are graded on and the start of the prompt.

## Keys

- **Tab / Shift+Tab, 1–5, ←→:** Home, Models, Tests, Runs, Settings.
- **↑↓ / j/k:** select a row. **Space:** toggle a model/test or select a run.
- **a:** add a model or test. Model search accepts provider, ID, or name; use arrows and Enter to choose, then explicitly choose existing authentication. Test creation asks for a lowercase ID, one-line prompt, and valid expected JSON.
- **d:** remove a model/test from configuration. Only **y** confirms. Test files and saved evidence remain intact.
- **− / +:** tries per test, from 1 to 20. **l:** tools/prompt lane. **p:** prompt caching on/off.
- **r:** preflight. Review enabled models/tests, authentication, billing, and limits before Enter. Metered/unknown billing then requires typing **PAY** and Enter. Consent applies to one run only; there is no dollar spending cap.
- **Esc / Ctrl+C during a run:** cancel and retain partial results. Wait for cancellation to finish before quitting.
- **Runs → c:** compare selected runs, or the highlighted run when none are selected. Opens one model-comparison page (below). **a** shows or folds the tasks every model solved; **m** toggles the full markdown report. **Enter:** inspect individual trials and check-level evidence; **←→** changes trials; **↑↓** scrolls a line, **space/b** a page, **gg/G** jump to top/bottom. **e:** export selected/highlighted runs through the app to workspace reports.
- **Settings → space on Address:** point at a local OpenAI-compatible server (llama-server, Ollama, LM Studio). Enter saves it and lists its models; the picker lists them under `local/` and asks for no credential. Opening the picker asks the server once if it has not been asked yet. Nothing is asked at startup.
- **R:** refresh local metadata without sending prompts. **?:** help. **q / Ctrl+C:** quit when idle. **Esc:** close a form/dialog without saving.

## The comparison page

One page, read top to bottom:

1. **How the models compare** — one chart. An **Overall** group has one bar per model, best first, with the score and **±**, then one group per difficulty (Basic, Standard, Hard) with the same bars and each model's place on those tasks alone. Each model keeps one colour in every group. In Overall, (how far a rerun could move it). Each difficulty level counts equally, and each task equally within its level, so many easy tasks cannot drown a few hard ones; a run without tiers weighs every task equally. A model whose score rests on fewer tasks than the run had says so on its line ("rests on 1 of 2 hard tasks"). A rank is 1 + how many models clearly beat it, so models this run cannot tell apart share a rank. "Clearly" means the gap beats two standard errors of the difference. A short verdict says which gaps are real and which are ties, and names any model that ran out of turns or time. Running out counts as an unsolved try, because each task's budget is sized for it; login, quota, crash and cancellation are `not run` and never count.
2. **By skill** — the same score split by skill, one column per model in rank order; difficulty places follow the same rules. Each cell also gives the model's place on those tasks alone, by the same rule as the rank, so "better on hard tasks" has to clear the same bar as "better overall" with only the hard tasks as evidence. The place is dropped when the columns are too narrow for it. A cell with tasks that login, quota or a crash kept from being graded is starred; a line under the table says how many were graded. A cell with half or more of its tasks ungraded gets no place (`–`) and does not affect anyone else's.
3. **Per task** — hardest first. Each cell is tries fully solved out of tries graded, stalls included; `ran out ×2` (`out×2` when narrow) says how many of the unsolved tries ran out of turns or time. A task every model solved folds into one line.
4. **Other signals** — checks passed, output format, tool use, reviewed design and the safe-code gate. None of them change the rank.

The same model from several selected runs pools into one column only when the runs share a comparison key. Models from different harnesses (Claude Code, Forseti's own agent) still share the page, each tagged with its harness, under one warning that the gap includes the harness. Synthetic controls are listed, never ranked. The markdown report opens with the same page and keeps the methodology and evidence under **Details**.

Synthetic controls are explicitly labeled. Unavailable authentication is visible, not silently replaced with a different credential source. Preflight uses `App.authFor(model)` for the explicitly selected authentication mode, not catalog defaults. The runner independently validates effective authentication and enforces billing consent.

All external text is stripped of terminal commands, control characters, and bidi overrides before rendering. Native Input/SelectList handle editing and selection. Inherited terminal-stream logging is disabled when creating ProcessTerminal; renderer diagnostic paths stay under the app workspace.

`Dashboard(app, repaint?, exit?)` accepts the UI-facing fields/methods of `App`, making keyboard and render tests independent of live providers. `.handleInput(rawKey)` drives interaction; `.render(width)` returns styled terminal lines. Optional render regions (`header`, `body`, `footer`) support fixed-pane composition. `launchTui(app)` owns terminal start/stop, not backend initialization.

Run `node --test tests/ui.test.ts` from the workspace. To capture mock-only screens without a terminal or provider calls, run `FORSETI_UI_ARTIFACTS=1 node --test tests/ui.test.ts`. It writes ANSI and plain-text snapshots for ten screens at 40/80/120 columns under `.cache/ui-artifacts/`. `npm run screenshot [home|models|tests|runs]` renders the same component over real workspace state to an SVG in `docs/`.
