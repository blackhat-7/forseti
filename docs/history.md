# Forseti — implementation progress

## Contract
- Two independent parts: a reusable LLM benchmark framework/TUI and a sanitized personal suite.
- All edits, caches, temporary files, execution directories and generated reports remain under `/Users/illusion/projects/forseti`.
- External projects, Pi installation and transcripts are read-only references. Never expose transcripts, credentials or hidden answers to benchmark agents.
- After compaction: reread this file, inspect the actual workspace, rerun relevant checks, then continue.

## Milestone 0 — orientation
- Workspace initially empty. Host: macOS, Node 26, Python 3.14, Pi installed; `sandbox-exec` available.
- Existing personal benchmark project found at `/Users/illusion/Documents/projects/benchmark_llms` (read-only).
- Pi transcripts occupy ~1.3 GB; broad stratified inspection is needed, not just latest messages.
- Plan: inspect existing tools and Pi docs/auth; settle a small, enforceable runner boundary; build TUI plus independent verifiers; run offline controls and live provider smoke checks where credentials permit.
- No implementation decisions finalized yet.

## Checks
- Verified cwd and available runtimes without modifying external files.

## Milestone 1 — design settled
- Inspected the existing personal OpenCode wrapper and upstream Inspect AI, Promptfoo, Harbor READMEs before building. Decision and source links: `docs/tooling-decision.md`.
- Reuse Pi's pinned 0.85.1 `pi-ai`, `pi-agent-core`, `pi-tui`; do not load full CLI contexts/extensions/settings. Dependencies installed with scripts disabled and workspace-local npm cache/TMPDIR.
- Independent suite contract: `docs/suite-contract.md`. Typed run/result contract: `src/types.ts`. TUI integration: `docs/ui-contract.md`.
- Agent tools limited to fresh public trial fixtures. Python execution must use a tested OS sandbox; hidden graders/reference data remain inaccessible. No host shell tool.
- External Pi credentials are read only, without external token refresh/rotation. Explicit API-key mode supported; billing and authentication are separate. Claude OAuth is metered extra usage per current Pi docs.
- Seeded repeat scheduling; per-stage timing and check evidence; prompt-only lane for explicit harness ablation. Synthetic controls are never presented as live model rankings.
- Parallel work: transcript researcher owns personal suite/coverage; UI worker owns `src/tui.ts` and UI tests. Parent owns framework, CLI, verification and this file.

## Milestone 2 — framework, TUI and suite integrated
- Implemented framework in `src/`: confined file tools, Pi agent adapter, read-only external auth, seeded schedules, saved snapshots/results/events, metrics and matched-check comparison reports, CLI and TUI.
- macOS sandbox successfully denies sibling hidden-file reads, writes outside the trial, sockets and child processes. Python's Homebrew launcher needed direct invocation of the framework interpreter; exact root-directory read is needed by the loader. Do not broaden the sandbox. A broad diagnostic probe was denied by auto mode; instead kernel diagnostics identified the narrow loader issue. No permission/auto-mode configuration changed.
- TUI: native Pi renderer/input/selection, four views, run/billing confirmations, cancel, add/remove/toggle, evidence and export; 15 mock UI tests passed. Actual PTY workflow still to verify. Corrected UI repetition limit to match backend 20.
- Transcript work complete: 1,509 files inventoried; 153 stratified sessions sampled; 51 semantically reviewed in bounded excerpts across 23 buckets/all five months. Limitations and pseudonymous source coverage in `docs/transcript-research.md` / `docs/transcript-coverage.json`.
- Independent nine-task suite has five Python tasks, one SQL task and three structured-answer tasks, hidden references/negative controls and observable quality checks. Suite-only validation: 49 reference checks pass, all nine negative controls rejected.
- First real runner control batch exercised all 36 scheduled trials; it exposed an overly restrictive framework rule requiring a correctness dimension even on instruction-only tasks. Removed that requirement: missing dimensions must be N/A, not harness errors. Full rerun pending. Failed initial run is retained as diagnostic history.
- `npm run check` and `npm run doctor` passed before the latest small integration edits. No live providers invoked yet.

## Milestone 3 — verification, live runs and hardening

### Automated checks (all currently passing)
- `npm run check` (TypeScript, no emit) and `npm test`: **28 checks** in `tests/framework.test.ts` and `tests/ui.test.ts`.
- `npm run test:suite`: **9/9 references pass, 9/9 flawed baselines rejected**, 56 reference checks, 43 baseline checks, 11 tool-trace checks, 10 quality-probe cases, 9 observation regressions.
- `npm run test:terminal`: real PTY run of the TUI through navigation → preflight → 36 isolated control trials → comparison → export → evidence → clean exit, restoring configuration afterwards.
- Backend checks cover actual sandbox denials (sibling hidden reads, escape writes, sockets, fork, hard/symlink, host credential env), path/link/size/depth limits, seeded schedule determinism, cancellation, stale-manifest detection, verifier crashes, auth cohort stop, metered consent, tool confinement, read-only grading, invalid-submission accounting, instruction-only comparisons and OAuth validity alignment.

### Live provider verification
- Codex subscription (`openai-codex/gpt-5.5`) passed `pause-correction`, then a 2-model × 2-task × 2-repeat run recorded real tool traces (`read_file`, `write_file`, `python`), per-stage timing and token counts. Billing correctly shown as subscription with cost N/A.
- `kimi-coding/kimi-for-coding` returned a monthly quota error; the run stopped that provider's remaining trials as `skipped` with no retry, account switching or paid fallback.
- Older `gpt-5.4`/`gpt-5.4-mini` aliases exist in the pinned catalog but are rejected for ChatGPT-account Codex use. Added per-model stop on generic provider errors so the remaining trials skip instead of repeating a known-bad request. Those two models are disabled in `forseti.json`.
- Confirmed catalog presence and auth readiness do not imply account entitlement; reports must keep provider failures visible and separate from model quality.

### Security and correctness fixes after ruthless review
- Grading Python is now **read-only**, so candidate import-time writes cannot make the saved artifact snapshot stale. Regression test asserts `PermissionError` and matching on-disk/recorded files.
- Suite now uses **public immutable `observe.py` drivers** per code task: they execute explicit hidden case inputs and return raw outputs/state/errors only. All expected values and verdicts stay in trusted JavaScript; candidate assertions or pass banners never decide a grade. `observe`/`pythonQuality` propagate callback rejection as a harness error, while nonzero exits and invalid JSON remain candidate failures.
- Added required `Task.dimensions` rubric declarations. Rejected/invalid submissions now fail every applicable declared dimension instead of vanishing from the correctness denominator; `tools` is omitted for prompt lane and controls. `validateChecks` enforces the declared set.
- Reports: comparison key includes selected task hashes; matched check differences survive when correctness is N/A; added a failed-check evidence section; clarified that model wait includes auth/SDK/transport.
- Runs now snapshot harness source, `package.json` and the real lockfile plus the resolved schedule, so old runs stay reproducible without git.
- Preflight OAuth validity aligned to Pi's five-minute window; narrowed sandbox read roots to `/opt/homebrew/Cellar` and rejected trial directories inside runtime read roots; recorded sandboxed Python version and proxy presence in run environment.
- TUI: repetition cap aligned to backend (20), added `u` to restore the last removed test, and markdown tables are reflowed for narrow terminals.
- CLI refuses to run from any directory other than the workspace root.

### Documentation written
- `README.md` (setup, usage, extension, auth/billing semantics), `docs/security.md` (execution/grading boundary, trust model, limits), `docs/tooling-decision.md`, `docs/suite-contract.md`, `docs/ui-contract.md`, `docs/tui.md`, `docs/transcript-research.md`, `docs/transcript-coverage.json`.

## Milestone 4 — deliverables published and re-verified

- **Fresh control run** `2026-09-15T19-16-45-535Z-a33f3dbd` under the final suite hash `d660d88d677d` and harness `0d2e0211713f`: all 36 trials evaluated; reference 16/16 correct, flawed baseline 0/16. Published as `reports/example-comparison.md`.
- **Live verification** published as `reports/live-smoke.md`. It carries the successful Codex batch (4/4 correct, real `read_file`/`write_file`/`python` traces, 8594 in / 1300 out tokens, subscription · USD n/a) *and* today's two live failures, in separate report groups because the suite/harness hashes differ. Both quota exhaustion and server-side auth rejection were handled with no retry, account switching or paid fallback.
- **`docs/verification.md`** written: command table, what each check group proves, sandbox evidence, credential evidence, live caveats and current blockers.
- **Screenshot** `docs/tui-home.svg` now generated by `npm run screenshot [home|models|tests|runs]` (`tools/screenshot.ts`), which renders the real `Dashboard` over the real config/runs and converts its own ANSI output to SVG. A grid check confirmed all 23 rows reproduce character-for-character within 110 columns, so the README picture cannot drift from the code. `tsconfig.json` now includes `tools/`.
- **Credential proof**: `~/.pi/agent/auth.json` is byte-identical (same SHA-256, size and mtime) to the fingerprint taken before the first live run, across every run, `doctor` and preflight since.
- **Simplification fix**: `checkSandbox` leaked one `.state/probes/<uuid>` directory per invocation (14 had accumulated). It now removes the probe in a `finally`. Verified: `doctor` passes and the directory count returns to zero.
- **Final battery re-run on the published tree**: `npm run check` clean · `npm test` 28/28 · `npm run test:suite` 9/9 references pass (56/56 checks), 9/9 baselines rejected (43/56) · `npm run test:terminal` PASS. `forseti.json` restored byte-for-byte by the PTY check.

## Milestone 5 — prompt caching (root cause of 2x+ usage)

- User reported a Pi-based Claude bridge burning 2x+ the usage of the vendor client. Root cause was **ours**: `adapter.ts` sent `cacheRetention: 'none'`, overriding Pi's `'short'` default. Confirmed in saved evidence — all four successful Codex trials recorded `cacheRead: 0, cacheWrite: 0`, so system prompt + tool schemas + transcript were re-sent uncached on every turn.
- Caching is now **on by default**. `RunOptions.cache`, `--no-cache`, and `p` in the TUI (shown in RUN SETTINGS and preflight).
- Caching reuses the prefix KV state and does not change sampling, so correctness/quality are unaffected. It does change repeated input cost and first-delta latency, so `cache` is in `comparisonKey` and the Budgets line; cached and uncached runs never pool.
- New test `prompt caching is on by default, reaches the provider, and never pools with uncached runs` asserts the default, that `'short'`/`'none'` actually reach `streamSimple` (prototype-preserving spy), and that the comparison keys differ. **29/29 tests pass.**
- Not changed: the shuffled schedule interleaves models, so cache entries rarely survive to a model's next trial. Sorting by model would warm the cache further but reintroduces ordering bias. Caching helps within a trial's turns, which is where the multiplier was.
- Re-verified after the change: `check` clean · `test` 29/29 · `test:suite` 9/9 + 9/9 · `test:terminal` PASS. Screenshot and `reports/example-comparison.md` regenerated.
- Added `anthropic/claude-opus-5` and `anthropic/claude-sonnet-5` to `forseti.json` on request. Both show `not ready`: the Pi Anthropic OAuth expired 2026-08-11. Anthropic OAuth in a third-party harness is metered extra usage, not plan quota, so it needs PAY / `--allow-metered` regardless.

## Milestone 6 — TUI redesign

- User feedback: cluttered, unreadable, dated, bad colours. All four were fair.
- **Palette rebuilt.** Was electric cyan + amber + grey-blue on navy, with cyan reused for brand, tabs, numbers, selection and dialog titles — colour carried no meaning. Now: near-black base `rgb(13,15,22)`, one indigo accent `rgb(129,161,255)` for anything interactive, and semantic colour elsewhere — green enabled/passing, amber warning/metered, rose not-ready, teal subscription, two grey tiers for secondary and hint text.
- **Removed the two full-width `─` rules.** The only remaining rule is a short accent underline under the active tab. Structure now comes from spacing and weight.
- **Aligned columns.** New `field(label, value, hint)` helper puts settings in fixed label/value/hint columns instead of ad-hoc double spaces.
- **Cut the prose walls.** Lane and cache explanations and the multi-line safety paragraph moved out of the dashboard; home keeps one dim line. `?` help is now a two-column key table instead of a 15-line paragraph.
- **Footer 4 lines → 2**: one blank, then message plus a context-aware hint (`? keys   q quit` / `esc back` / `esc cancel`).
- **Selection** is a single accent `▌` bar; the `●`/`○` dot now means enabled/selected and is colour-coded. Previously `›` and `●` competed.
- Sentence-case headings (`Models`, `Preflight`, `Billing`, `Comparison`, `Evidence`) instead of `MODEL LINEUP` / `RUN PREFLIGHT` shouting. `READY` / `NOT READY` stay capitalised as status pills.
- Run IDs shortened in lists to `19-26-56 · af54f7a0`. Counts pluralise correctly. Progress bar uses `█`/`░`.
- **Tests updated deliberately, not weakened.** `terminal.py` previously asserted `MODEL LINEUP` / `TEST SUITE`; the new sentence-case names appear in the tab bar on *every* screen, so those assertions would have passed without the view opening. They now assert view-unique content (`control/reference`, `shared-count`).
- Verified: `check` clean · `test` 29/29 · `test:suite` 9/9 + 9/9 · `test:terminal` PASS · layout clean at 40/80/120 columns · screenshot regenerated and grid-checked (19/19 rows match within 110 columns).

## Milestone 7 — the dashboard now fills the window

- User showed a wide terminal with content occupying only the top-left. Width was actually being used; the real problems were that **Home had almost nothing in it** and detail panels sat *below* lists instead of beside them, so a tall wide window was mostly empty.
- **Home is a dashboard now**: run settings beside a live "Will run" pane listing every enabled model with its billing colour, then the `r` call to action, then a "Recent runs" table with pass counts. You can see exactly what `r` will execute without changing tabs.
- **Models / Tests / Runs are two-pane**: list on the left (44 columns), detail on the right. Runs detail gained passed/failed/other counts, recorded-vs-planned, lane/repeats/cache and the suite/harness hashes.
- `twoColumn()` falls back to stacked layout below ~76 columns, and `detailWidth` follows the layout so prose does not wrap into a 24-column ribbon when stacked.
- List windows grew from 8 to 12 rows and now centre the cursor.
- `MAX_TEXT = 94` caps prose so paragraphs stay readable instead of running 180 characters on an ultrawide terminal; tables and lists still use the full width.
- Fixed a real display bug: control models printed "synthetic control" twice, because `auth.mode` and `billingInk(billing)` both render it. `authLine()` now prints the billing chip only when it adds information.
- Screenshot widened to 132 columns. Verified: `check` clean · `test` 29/29 · `test:suite` 9/9 + 9/9 · `test:terminal` PASS · side-by-side at 170/120, stacked at 76/40 · screenshot grid-checked 30/30 rows.

## Milestone 8 — Claude plan support via Claude Code

- Goal: benchmark Claude models on the user's Max subscription, within terms. The Pi `anthropic` provider is the wrong path — it drives the Messages API from a third-party harness, which Pi's own docs bill as metered extra usage, and the stored OAuth expired 2026-08-11 anyway.
- Chosen path: spawn the user's **own Claude Code CLI** (`claude -p`), the documented non-interactive Agent SDK surface. Verified against the live docs before building.
- **Decisive doc finding:** `--bare` explicitly *does not* use the subscription login ("never reads OAuth credentials or the system keychain"; demands `ANTHROPIC_API_KEY`). Used `--safe-mode --disable-slash-commands` instead, which disables host customizations without touching auth.
- `src/claudecode.ts`: binary lookup, flag construction, JSON parsing (`result`, `num_turns`, `usage`, `total_cost_usd`), and `classify()` mapping plan-limit / login messages to `rate_limited` / `auth_error`.
- **Never bills a key:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_PROFILE` are deleted from the child env. No Claude credential is read, copied or refreshed by Forseti.
- **Harness separation enforced, not just labelled:** `agentOf()` throws if a run mixes `claude-code` with Pi-adapter providers; `agent` + `agentFlags` are in `comparisonKey` and the run manifest; the report prints a banner explaining what the numbers do and don't mean.
- **Tool dimension is N/A** for this agent: the suite's tool rubric hard-codes `read_file`/`write_file`/python attempts, which Claude Code's Read/Edit/Glob trace cannot satisfy. Mapping them would have manufactured a false equivalence.
- Runs outside the Seatbelt sandbox (the CLI needs network), so `--permission-mode dontAsk --permission-prompts none` with `--allowedTools Read,Write,Edit,Glob,Grep` — no `Bash`. Documented as a capability difference vs the Pi lane's sandboxed Python.
- `forseti.json` now carries `claude-code-sonnet` and `claude-code-haiku`; the metered `anthropic/*` entries were removed. `doctor` reports both **ready · subscription**.
- New test asserts billing, the stripped env vars, absent `--bare`/`Bash`, the mixing refusal, the tools-dimension exclusion, limit/auth classification and comparison-key separation. **30/30 tests pass**; `check`, `test:suite`, `test:terminal` all pass.
- **Unverified:** whether `--safe-mode` preserves the subscription login is inferred from the docs attaching that caveat only to `--bare`. If the first trial returns an auth error, drop `--safe-mode` from `claudeCodeArgs` (at the cost of host-config contamination). No live Claude Code trial has been run yet.

## Milestone 9 — first live Claude Code run exposed four bugs

The first real run failed all 18 trials with an empty error. Root causes, in order of severity:

1. **False model failures.** An unparseable CLI result was routed through `rejectArtifacts`, recording `invalid-submission-*` failures — i.e. 0% correctness for work the model never got to submit. Now a missing result message is `harness_error`, which is excluded from correctness instead of counted against the model. This was the worst bug: the exact false signal the project exists to prevent.
2. **Empty diagnostics.** `parsed?.result ?? stderr ?? stdout` stops at an empty string, so an empty `stderr` short-circuited the chain and stdout was never read. Replaced with a first-non-empty scan; raw stdout/stderr are now recorded per trial.
3. **Wrong output shape.** `--output-format json` emits the whole session as a JSON *array*; the answer is the last `result` entry. The code assumed a single object, so `parsed.result` was always undefined. `resultMessage()` now accepts both.
4. **Fake `rate_limited`.** `classify()` ran its limit/auth regexes over the entire session transcript, so any mention of a limit inside the model's own reasoning read as a provider limit. It now classifies only the result text and stderr.

Corrections to earlier claims in Milestone 8, both proved wrong by the live `system/init` event:
- **`--allowedTools` does not restrict tools; it only pre-approves them.** The session still carried Bash, WebFetch, WebSearch, Task and more. Added `--disallowedTools` with an explicit deny list. The earlier "no shell" claim was wrong.
- **`--safe-mode` does not disable plugins** (gopls-lsp and pyright-lsp still loaded), though it did clear skills and slash commands. It *does* preserve the subscription login — `apiKeySource: "none"`, so the auth question from Milestone 8 is resolved.

Also: the suite's tool rubric is now explicitly scoped with an `agent` field on `GradeContext`, so `toolChecks` returns `[]` for any non-Pi harness. Without it every Claude Code trial died on "Grader output does not match the declared task dimensions".

End to end now works: Sonnet read the fixture, resisted the embedded prompt injection, and produced the correct values. It still fails `incident-facts` because it wrapped the JSON in prose and a code fence while the prompt says "Return only JSON" — a real instruction-following failure, but plausibly a Claude Code harness effect rather than a model one. Grading was left strict; loosening it would silently change every existing result.

Verified: `check` clean · `test` 30/30 · `test:suite` 9/9 + 9/9 (plus a new assertion that another harness cannot satisfy the Pi tool rubric) · `test:terminal` PASS.

## Milestone 10 — correctness no longer depends on packaging

- A grading bug, not a Claude Code one: `equal('incident-facts', parseAnswer(answer), ...)` fed a strict `JSON.parse` straight into the correctness check. A model that produced perfect facts wrapped in prose or a code fence scored `actual=null` — **0% correctness for a right answer**. One dimension was silently eating another.
- `answerJson()` now recovers the JSON (direct parse → last fenced block → widest balanced `{...}`) and feeds **correctness**; the new `jsonOnly()` check grades the packaging under **instructions**. Applied to `incident-window` and `source-map`; `pause-correction` already had `concise-json` for the format and now uses `answerJson` for the content.
- Verified live: Haiku on `incident-window` now scores `incident-facts` **PASS** (exact match) with `json-only` FAIL — instead of a blanket correctness failure. That is a real instruction-following miss worth reporting, and plausibly a Claude Code harness effect, but it no longer destroys the correctness signal.
- Loosening can only turn a former null into a parsed value, so no previously passing check can flip; existing Pi-lane runs returned bare JSON and are unaffected in verdict.
- Verified: `check` clean · `test` 30/30 · `test:suite` 9/9 references, 9/9 baselines rejected · `test:terminal` PASS.

## Milestone 11 — panels fill the window

- The comparison and evidence panels were hardcoded to `wrapped.slice(offset, offset + 12)`, so on a tall terminal they used 12 rows and left the rest of the screen black. A 119-line report took ten screens of one-line scrolling.
- `Dashboard` now takes a `rows: () => number` supplied by `launchTui` from `ProcessTerminal.rows`, with `bodyRows()` = window minus the 3-line header and 2-line footer. Page size and the list window both derive from it; the default of 24 keeps tests deterministic.
- Measured: at 24/45/60 rows the dashboard renders exactly 24/45/60 lines and the report page grows 14 → 35 → 50.
- Added `space` / `b` for page down/up, since a full-window page is a lot of ground to cross one line at a time.
- Verified: `check` clean · `test` 30/30 · `test:terminal` PASS.

## Milestone 12 — glanceable results, and "failed" no longer means "did not run"

**Why trials were failing** — tallied across all 35 Claude Code trials, then split by run:
- `20-11-21`: 18 × `invalid-submission-*` with an empty reason. **My bug**, fixed in Milestone 9. Pure noise.
- `20-38-42`, `20-33-57`: `incident-facts actual=null`. **My bug**, fixed in Milestone 10.
- **`20-52-54` (current code): 4 passed, 2 scored, and the only failing check is `json-only`.**
- Verdict: the models are not bad. Both Sonnet and Haiku score **100% correctness**; they lose only on wrapping the answer in a code fence — an instruction-format miss, very likely a Claude Code system-prompt effect. Old runs were dominating the impression.

**Vocabulary fix.** `failed` read as "the test never ran". Added `outcome(status)` with three kinds: `pass` (all checks passed), `scored` (ran and was graded — shown as **SCORED**, never "failed"), and `not-run` (auth/limit/timeout/harness — shown as **NOT RUN**, with the line "excluded from scores, not counted against the model"). A UI test asserts the word "failed" never appears in the evidence view.

**Scorecard.** New `scorecard()` / `scorecards()` in `report.ts`, shared by the markdown report and the TUI so both show identical numbers. Headline is **correctness, weighted equally per task**, so a task with many checks cannot dominate; instructions/quality/tools stay separate columns so a formatting miss never reads as a wrong answer.

**Visual comparison.** `c` now opens a scorecard first — per-model `██████████ 100%` bars coloured by rate, plus a per-task grid (● all correct · ◐ some · ○ none · · not graded). `m` toggles the full markdown report. The markdown export gained the same Scorecard section above the old detail tables.

**Evidence redesign.** Outcome chip, per-dimension bars with counts, one timing/token line, then "Why it did not pass" (failed checks first), then passed checks, answer and trace — instead of an undifferentiated wall.

**Grouped charts.** The first scorecard cut gave each model its own 10-character strip, which is a table with decoration, not a chart. Replaced with one full-width chart per dimension carrying every candidate, so models are read against each other: bar width scales to the panel, bars are coloured by rate, and the run suffix is dropped from labels when model names alone are unambiguous. Dimensions that are N/A for every candidate are skipped rather than printed empty.

Verified: `check` clean · `test` 30/30 · `test:suite` 9/9 + 9/9 · `test:terminal` PASS (assertion updated to the summary view).

## Milestone 13 — vim jumps in the scrollable panels

- `G` jumps to the end, `gg` to the top, in both the full report and the evidence panel. `pendingG` arms on a lone `g` and any other key disarms it, so `g j g` never jumps.
- The end position needs the wrapped line count, which only exists at render time, so render records `reportLength`/`reportPage` and the key handler reads them. Never rendered → both are 0 and `G` is a safe no-op; toggling report mode resets them.
- The UI fixture now takes a viewport height so a scroll test can use a page shorter than the content; the mock comparison text was lengthened to make scrolling observable at all.
- Test asserts all four behaviours: `G` moves, a lone `g` does not, `gg` returns to the top, and an interrupted sequence does not jump.
- Verified: `check` clean · `test` 30/30 · `test:terminal` PASS.

## Milestone 14 — suite saturated, two audit tasks added

- Sonnet and Haiku both hit 100% correctness on the first nine tasks, so the suite had stopped measuring. Limit 8 of the research doc had prescribed holdout variants at exactly this point.
- Re-scanned **600 sessions** (read-only, counts only, nothing persisted). Scope restriction appears in **51%** of sessions and pairs most with concurrency (65), performance (44), simplification (41) and migration (32). Bounded excerpts from that intersection showed one dominant hard shape: **exhaustive read-only audit with a strict verdict** — every branch or rule enumerated, each mapped to the exact covering case by name, gaps and duplicates listed, schema-impossible states excluded, nothing edited.
- Added `coverage-audit` (branch→case map with two `weight_kg == 30.0` boundary traps against `> 30` tests, plus a branch `CHECK (weight_kg > 0)` makes unreachable) and `migration-safety` (six rules, three genuinely broken, three decoys reviewers habitually over-flag).
- **Two answer keys were wrong and the models caught both.** `R4`/`R5` both described the swallowed exception, so one defect matched two rules — `R4` was rescoped to what the backup stores, and no model reported it again. `R3` was scored as satisfied, but five of six answers flagged it; they were right, because the discarded row count lets a stale guard update zero rows while `touched.append` still reports success. A rule capable models consistently flag is an ambiguous rule, not a model error. Both keys were corrected before any score was recorded as a result.
- Measured discrimination: `migration-safety` Sonnet 2/2, Haiku 1/2, with answers varying across repeats for both. `coverage-audit` still 2/2 for both — retained to separate weaker models, not these two.
- Two framework tests hardcoded 9 tasks / 18 trials; both now derive the count from the suite so adding a task cannot break them.
- Verified: `check` clean · `test` 30/30 · `test:suite` 11/11 references pass, 11/11 baselines rejected · `test:terminal` PASS.

## Milestone 15 — capabilities, so results say what a model is good at

- Tags like `audit, read-only, exhaustive` described the task's shape, not the skill it measures, so they could not answer "which model is better at X".
- Rejected a `difficulty` field. Difficulty is a prediction about models, and it rots: `coverage-audit` was predicted to be the harder of the two new tasks and saturated, while `migration-safety` discriminated. A wrong label would have sat in the manifest uncorrected. A rejected follow-up — a derived task-health view — was dropped for a stronger reason: it would have to pool runs across different suite hashes, harnesses and lanes, which is exactly what `comparisonKey` exists to prevent.
- Added `capabilities`, a validated non-empty set per task from a fixed five-word list. Orthogonal to `dimensions`: a dimension is what kind of check runs, a capability is what skill the task demands.
- The vocabulary was derived from the failure modes that actually separated the models, not from a generic list. `evidence` and `restraint` are deliberately split — they are false negatives and false positives on claims, and Haiku's only real weakness was the second one. Merging them would have hidden it.
- Plain words on request: `evidence`, `restraint`, `exactness`, `scope`, `safety`. Dropped "architecture", "planning" and "reasoning" — nothing here tests architecture, planning has one task, and reasoning is in all eleven so it labels nothing. The gaps are stated in the suite contract rather than papered over with labels.
- Coverage: evidence 6 · scope 6 · restraint 5 · exactness 5 · safety 3.
- Runs record the capabilities of the tasks they ran, so an old run stays readable after the suite changes. Both renderers show `Nt`, the number of tasks behind each number, so a thin capability cannot look confident.
- Verified: `check` clean · `test` 30/30 · `test:suite` 11/11 references pass, 11/11 baselines rejected · `test:terminal` PASS · capability rollup renders 100%/0% for reference vs flawed baseline across all five.

## Milestone 16 — a design reviewer that is itself testable

- The `quality` dimension was three AST floor checks that had never once failed. Nothing measured whether an abstraction earns its place, whether a comment carries intent, or whether the result reads like something worth maintaining. Static analysis cannot reach any of it: a node count rewards dense unreadable code.
- Mined **1,231 Pi sessions / 11,920 real user messages** (read-only, counts plus bounded excerpts, nothing persisted). Complexity pushback is the dominant correction: unnecessary **185 sessions**, verbosity **181**, simplify **133**, readability **127**, duplication **84**, "can't we just" **61**, footguns **50**. 185 of those messages are the user's own reviewer briefs.
- **The rubric was not invented.** It is condensed from the user's own `ruthless-code-review` and `code-simplify` skills — smallest clear behaviour-preserving implementation, delete the unnecessary, unearned abstractions go, *fewer lines is not the goal*, removing error handling to look cleaner is a defect, no speculative nits. One brief states it almost verbatim: "solely for shortness, simplicity, readability, dead code, duplicated logic, speculative abstractions, unnecessary helpers/files/config, and overengineering".
- Added the `design` dimension and `src/judge.ts`. Five rules make a judged verdict mean something: correctness gates the reviewer; design never touches correctness; binary questions instead of a 1–10 score; **every defect must cite a line that mechanically verifies against the submission**, or it is discarded and scored clean with the discard left visible; the reference solution ships in the prompt as the scale anchor.
- Same-scale mechanisms: authorship stripped (comments deliberately kept — they are being judged), no pairwise ordering to bias, majority over N rounds with the agreement count shown, and the reviewer's provider/model/thinking/rounds/rubric all folded into `comparisonKey` so a changed reviewer starts a new experiment.
- Self-preference is **measured, not asserted**: `test:judge --run <id> --alt <provider>/<model>` reviews the same real submissions with two reviewers from different families and prints the defect rate split by the family that wrote the code. Default reviewer is deliberately non-Anthropic, and the Settings tab warns on a same-family choice.
- New task `duplicate-rule`, taken almost verbatim from a transcript ("why do we have duplicate logic implemented in `<handler>`. cant we just change the last part once"): three drifted copies of a retry rule, graded deterministically on 14 named boundary cases and judged on duplication, unearned abstraction, dead code and explanatory noise.
- Calibration set of 8 labelled cases / 32 judgments, each label citing the recorded rule behind it. Four cases contain no defect, two of them traps: `longer-but-plain` catches length bias, `why-comment-kept` catches a reviewer that treats any comment or any unfamiliar shape as noise. `test:suite` validates the whole set offline — fully labelled, labelled only for questions that exist, and behaviourally correct — so `test:judge` adds nothing but the reviewer's opinion.
- Settings tab (`5`), reviewer **off by default**: it spends quota and its scores are the only ones here that do not replay from the artifacts.
- Every reviewer failure path is tested: unparseable reply, thrown error, absent paths, uncitable defect, correctness-failed submission, reviewer disabled. None of them can fail a candidate. This is the same class of bug that once turned Claude Code harness errors into 0% correctness.
- `test:terminal` had a hardcoded 9-second run budget that the 12-task suite outgrew; it now waits on the outcome, not a tick count. The first failure also left a stale `.state/run.lock` that made every later attempt fail instantly — the real fault was the budget, the lock was collateral.
- Live calibration was blocked at first: Codex OAuth is rejected server-side and Kimi quota is exhausted, so no reviewer could be reached. The failure surfaced exactly as designed — a clear message, nothing scored, no false model failures. Measured in Milestone 18 once the Claude Code reviewer existed.
- Verified: `check` clean · `test` 42/42 · `test:suite` 12/12 references pass, 12/12 baselines rejected, 8/8 calibration cases valid · `test:terminal` PASS.

## Milestone 17 — a run is visible while it runs

- Reported symptom: a run was started, cancelled, and then could not be found in the Runs list. Three separate causes, all real.
- **The list was a snapshot.** `App.runs` was only reloaded after a run finished, so an in-progress run was on disk but never in the UI. Now each completed trial splices that one manifest back into the list via `readRun`, instead of re-parsing all 48 histories per update.
- **You could not reach the list.** Every key except escape was dead while a run worked, and the progress panel replaced the whole body. Navigation and `↑↓` now work during a run; only edits, `r` and `q` wait. The progress panel belongs to Home, and the header carries `running · 12/48` from every tab.
- **Escape was overloaded.** With a dialog open during a run, escape cancelled the run instead of closing the dialog. Innermost thing closes first now, so "close this panel" can never mean "throw away the run".
- **A run that never started left nothing at all.** Preflight failures — stale lock, unready auth, metered without consent, unreachable reviewer — happen before any manifest exists, so the Runs tab genuinely has nothing to show. That reason is now held on Home until the next attempt, rather than flashing once in the footer. This is the most likely explanation for the original report.
- Unfinished runs list as `interrupted 23/48` or `cancelled 36/36` so partial evidence reads as partial, not missing. Confirmed against the two real ones already on disk.
- `q` during a run now says why it is refused instead of doing nothing.
- Verified: `check` clean · `test` 44/44 · `test:suite` 12/12 · `test:terminal` PASS.

## Milestone 18 — the reviewer can use the one login that works

- Picking a Claude Code model as the reviewer was refused: the judge drove models through Pi's API adapter only, and Claude Code is a spawned CLI with a different interface. Controls were refused for a better reason — a synthetic control has no model behind it at all.
- That restriction made the whole feature unusable here, because Codex OAuth is rejected server-side and Kimi quota is exhausted. The Claude plan is the only working credential.
- Added a Claude Code reviewer path: `claude -p` with **every tool denied, including Read**, one turn, `--safe-mode`, and API-key env vars stripped. It shares the child-process plumbing with the trial runner rather than duplicating it.
- The picker no longer offers what it will refuse, and a Claude Code reviewer skips the auth question because the CLI authenticates itself.
- This makes same-family judging easy to reach, so the existing Settings warning matters more, not less: reviewing Claude submissions with a Claude reviewer is precisely the self-preference case, and the probe is the answer to it.
- **First live calibration exposed a bug in my own citation check, not in the models.** Sonnet correctly flagged the three-copies case and quoted the real block, citing `retries.py:13-18`. `verifyCitation` parsed only a single line number and compared the quote against one line at a time, so a range or a multi-line quote could never verify. The mechanism built to discard *invented* defects was silently discarding *correct* ones — the worse direction to fail, because it makes a model look like it missed what it actually caught.
- Two process errors of mine are worth recording. I blamed the question wording and rewrote it without evidence; the rewrite changed nothing and was reverted. Dumping one raw reviewer reply found the real cause in a minute, after two full calibration runs of guessing had found nothing. **Look at the instrument's actual output before changing the thing it measures.**
- The calibration report now prints the check's evidence on every disagreement, so "said clean" can never again conceal "said defect, proof rejected". That ambiguity is exactly what cost the two wasted runs.
- Measured agreement, after the fix: **claude-code/sonnet 32/32, claude-code/haiku 32/32**, both with zero invented and zero missed defects, and both traps passed — no length bias, no comment bias.
- Two cautions on those numbers. First, they do not separate the two reviewers at all, so this set cannot yet be used to *choose* one; it only shows neither contradicts the standard on these eight cases. Second, Haiku's earlier run also reported an invented defect on `leftover-helper` that is gone now, and the citation fix does not explain that direction — single-round judging is simply unstable. That is what `repeat` and majority settling exist for, and it is an argument for running the reviewer at 3 rounds rather than 1.
- Read a perfect score as "no disagreement found yet", not as "this reviewer is right". Eight cases is small by design; the set earns its value by growing from real disagreements.
- Verified: `check` clean · `test` 44/44 · `test:suite` 12/12 · `test:terminal` PASS.

## Milestone 19 — releasing the lock must not discard the run

- A completed 48/48 run reported `Run stopped: ENOENT … .state/run.lock`. The run itself was fine: every trial and the manifest were already saved, and it was listed correctly. Only the final status was wrong.
- Cause: the cleanup was `finally { closeSync(lock); rmSync(lockPath); }`. `rmSync` without `force` throws when the file is already gone, and a throw from `finally` replaced the returned run with an error. Triggered here because the lock had been cleared by hand mid-run during verification — a stale-lock cleanup is a realistic thing to do, so the code has to tolerate it.
- Cleanup is now idempotent and cannot mask a result: `closeSync` is guarded and `rmSync` uses `force`. Covered by a test that deletes the lock from the progress callback and asserts the run still completes and lists.
- Same runs exposed a second gap: the reviewer was enabled with the default Codex model, whose token is rejected server-side, so it produced **zero** design checks and only per-trial notes. A read-only preflight cannot see server-side revocation, so the reviewer looked READY. An enabled-but-silent reviewer is now visible without opening a trial: the post-run message appends "Reviewer scored nothing", and the Runs detail pane carries the reviewer's defect count or, when it scored nothing, the reason.
- My first attempt at that put the reviewer warning *before* the run outcome, which the truncating footer then cut off — so a completed run stopped saying it had completed. `test:terminal` caught it, because it asserts on what the real terminal actually shows. The primary fact stays first; the detail pane, which does not truncate, carries the reason.

## Milestone 20 — the trial time limit was unreachable and set too low

- A Haiku trial was censored at the 90s deadline. The censoring is correct — a `timeout` is `not-run`, excluded from correctness, never counted against the model — but it costs an outcome, and nothing in the TUI could change the budget. Only the CLI could.
- Timing from the real 24-trial Claude Code run: median 27.5s, p90 73.2s, slowest completed 85.9s, one censored at 90s. The default was sitting right on the distribution's tail for this harness.
- Default raised to 180s. A fast trial never spends the headroom, so the only cost is that a genuinely hung trial takes longer to give up; a censored outcome costs evidence, which is worse.
- Added `t` on Home, cycling 30/60/90/120/180/300/600. A ladder rather than free numeric entry, matching the existing single-key cycles for lane and cache.
- A censored trial now says what to do about it: "The model was still working at Ns. Raise the limit with t on Home and rerun to get a real outcome."
- The TUI's run options now derive from `DEFAULT_OPTIONS` instead of a second hardcoded copy that had already drifted out of sync.
- Note: the timeout is in the comparison key, so runs at 90s and 180s will not pool. That is intended.
- **Measured the censored task instead of guessing.** Haiku × `event-ledger` × 3 at a 300s limit: 89.0s, 106.8s, and one that ended on the turn cap. The task genuinely needs 89–107s, so 90s was a coin flip — it timed out in three separate runs and squeaked through at 84.1s, 85.9s, 81.3s and 80.2s in others. 180s is ~1.7x the slowest observed, so this specific failure should not recur.
- That measurement exposed a second censoring budget. Hitting `--max-turns` mid-tool-use makes Claude Code exit 1 with `stop_reason: "tool_use"` and no result message, which Forseti recorded as `harness_error` — it looked like the framework broke when the turn budget had simply run out. Now classified as `budget`, the same censored-not-wrong status the Pi path already used.
- 12 turns is also tight: one of three trials hit it. Added `T` on Home cycling 6/12/20/30/50. The default is left at 12 on purpose — unlike the time limit, raising it lets slow trials do *more* work and spend more plan quota, so it is the user's call, not a silent change.
- Verified: `check` clean · `test` 47/47 · `test:suite` 12/12 · `test:terminal` PASS.

## Milestone 21 — say which credential, every time

- Audited every recorded trial. **No API key has ever been used, and no metered cost was ever incurred.** 1285 synthetic controls, 211 `Claude Code CLI (your login)`, 18 `Pi OAuth (read-only)`, 8 `Pi API key (read-only)` — all subscription. Zero trials with `environment API key` mode, total estimated cost $0.00.
- The risk was real though: `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY` are set in this shell, and `defaultAuth` falls back to `env` when a provider has no Pi credential. `models add` would therefore have silently picked an API key. It now refuses and names what it would have used, so `--auth env` is the only way to reach one.
- **The reviewer was missing from preflight entirely.** A metered reviewer skipped the billing prompt and only failed after the run was confirmed. It is now listed and gated with the candidates, since it spends the same kind of credential.
- Home and preflight both carry one line naming the credential for every call site: "Subscription logins only (3 call sites). No API key will be used." or, in amber, which call sites would use a metered key and which they are. The quiet case is stated too, rather than left to be assumed.
- Preflight now says plainly that subscription calls draw on plan usage limits, not money.
- Verified: `check` clean · `test` 47/47 · `test:suite` 12/12 · `test:terminal` PASS.

## Blockers / cautions
- Auto mode's gatekeeper classifier (`openai-codex/gpt-5.6-sol`) intermittently fails closed with an expired token or invalid classifier JSON, blocking all tool calls. Not a workspace defect; refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some explicit external reads are denied. Use read-only native reads for those references; do not reconfigure it.
- Runs before `19-09-01` predate the suite-hardening and rubric-dimension changes, so their suite hashes differ. Keep them as history; the report splits them into separate groups rather than pooling them.
- Never present synthetic controls, single-task passes or small samples as general model rankings.
- **Codex OAuth is rejected server-side** (`Provided authentication token is expired`) even though the stored token is unchanged and its recorded expiry is days away. A read-only preflight cannot see server-side revocation. Log in again in your own Pi session to refresh the live smoke; Forseti will not rotate the token.
- **Kimi monthly quota is exhausted** until the next billing cycle. Forseti will not purchase extra usage.

## Next
All deliverables are produced and verified offline. Remaining work is blocked on credentials, not on code:
1. After a fresh Pi Codex login, run `npm run test:judge`. Until that agreement number exists, the reviewer is unvalidated and its design scores should not be read. Everything around it is tested; only the model's opinion is unmeasured.
2. Then rerun `npm start -- run --models openai-codex-gpt-5-5 --tests shared-count,incident-window --repeat 2` and regenerate `reports/live-smoke.md` so both groups share the current suite/harness hash.
3. With the reviewer validated, run Sonnet vs Haiku on `duplicate-rule` with the reviewer on, then `npm run test:judge -- --run <id> --alt <provider>/<model>` for the self-preference number on real submissions.
4. Add a second entitled live model when quota allows, for a genuinely matched two-model comparison rather than one model plus recorded failures.
