# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-11-10

## State

- **32 tasks, 22 active.** `hard` 7 · `standard` 10 · `basic` 5. The other 10 every model solved; they are retired in `removedTests` (`forseti.json`), so runs skip them and the board leaves them out (`src/app.ts`). A task may set its own `turns`/`timeout`; the effective budget is the larger of the run's and the task's.
- **Scoring:** correctness is the headline; speed and effort are shown apart (`Typical solve`, `Time per correct result`, `Tokens per correct result`), never ranked. Default caps 40 turns / 900 s stop stuck tries; running out still counts as unsolved. Raising a cap reruns only tries it cut short (`fitsBudget`).
- **The rebuilt hard tier separates, on one try each.** `lock-refresh` and `sheet-eval`: Haiku ✗, Sonnet ✗, Opus ✓. `crew-schedule` and `log-query`: Haiku ✗, Sonnet ✓. Detail in `docs/transcript-research.md`. Not yet a measurement.
- **The leaderboard keeps today's conditions only.** A finished try counts under any limits at least its own, so older tries came back after the 40-turn/900 s change. A Pi model's card names its output-token limit. Claude reruns spend plan quota: ask first.
- **A run only makes missing tries.** Same model + same task and harness submission fingerprints + same settings = already done; `--fresh` forces a rerun. A grading-only change is regraded from saved files (`npm start -- regrade`, also run before every run).
- **Four production-ops tasks on a simulated estate** (`checkout-hotfix`, `subscription-repair`, `bucket-residency`, `service-web`). Each try gets a variant (seed = try − 1) and reports its harm. A task's `world` module answers gcloud/kubectl/psql/gsutil in-process; nothing real is reachable, and the model is not told. Engine: `suites/personal/private/ops/`. Contract: `docs/suite-contract.md#world-tasks`. Pilots are stale after the scenario rework; the last Qwen run (before it) showed 0 simulation tells, down from 96.
- Battery on Linux: `npm run check` clean · `npm test` **100/100** · `test:terminal` **fails before and after 2026-10-03's UI work**: "TUI did not mount" (its 1 s wait is likely too short with 300+ saved tries) · `test:judge` not run.

## Done this session

- **Harness versions.** `fingerprint.lock` numbers each harness (`npm start -- versions`); `npm run fingerprint` starts a new one when how tries run changes, and a grading change updates the current one. `npm start -- leaderboard --version N` and `V` on Home read an older version's board. v1 is every try before 2026-11-10 (8 models); **v2 is empty until rerun**.
- **v2: Claude Code may start subagents** (same tools and sandbox), a Claude Code model may run through a wrapper (`command` in forseti.json, e.g. `["claude-local", "--offline"]`), keyed apart from the plain model (`modelKey`), and each Claude Code try records `estimatedCost` at API prices from the CLI's per-model costs (Claude models only); the report shows `$ per solved try`.

## Next

Measure the claude-local modes on `lock-refresh` and `sheet-eval` (local alone fails both, Opus solves both): does a local main agent ask Opus, and what does a solve cost? Then `PLAN.md`. Ask the owner before spending Claude quota.

## Gotchas
- **subscription-repair holds ~370 MB of SQLite per world.** Several ops tries at once need memory.
- **A world's outputs must read like the real tool, byte for byte.** Unknown commands get the real tool's error, never an invented success. `ONLY=<task> npm run test:suite` checks one task's controls.
- **`render(w, 'body')` reuses the last frame drawn at that width.** A test that changes state must render the header (or `'all'`) first.
- **`parallel` in forseti.json sets tries at once (default 1).** Local-server models still run one at a time.
- **Run local thinking models with `--tokens 32768`.** At the default 4096, Qwen at xhigh fills a turn with thinking and stops at turn 2.
- **If `npm test` fails on `fingerprint.lock`, you changed how tries run.** Only `src/trial.ts` and its imports count, without comments or layout. Record it with `npm run fingerprint -- "why"` only if intended. A Claude Code update also resets Claude tries.
- **Parallel Opus subagents drain the plan's 5-hour window fast.** Four here plus four in another project's session took it from 70% to 100% in about 30 minutes; the benchmark trials were ~2% of that. Run agents one at a time, or on Sonnet. Pilot with Haiku and Sonnet first; run Opus only where both fail.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess fails with `PermissionError`.
- **`--safe-mode` disables every MCP server.** The Claude Code lane uses `--restricted`. Do not switch back.
- **`forseti.json` is committed (models, retired tasks); its local server address is a private tailnet IP.** Model `local-local` follows whatever the aliased server loaded (`src/runner.ts` `loadedFile`); no renaming needed.
- **Running `python3` against a fixture writes `__pycache__` into it.** Always `python3 -B`.
- **The sandbox needs Python from `/usr`.** With `~/.nix-profile` first in `PATH`, 16 tests fail and the CLI refuses to start. Run with `PATH="/usr/bin:$PATH"`.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
