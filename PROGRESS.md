# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-30

## State

- **31 tasks.** `hard` 6 (`due-dates`, `sheet-eval`, `lock-refresh`, and three ops tasks) · `standard` 14 · `basic` 11. A task may set its own `turns`/`timeout`; the effective budget is the larger of the run's and the task's.
- **Scoring:** running out of a task's turn or time budget counts as unsolved (auth, quota, crash, cancel stay `not-run`). Each difficulty level weighs equally.
- **The rebuilt hard tier separates, on one try each.** `lock-refresh` and `sheet-eval`: Haiku ✗, Sonnet ✗, Opus ✓. `crew-schedule` and `log-query`: Haiku ✗, Sonnet ✓. Detail in `docs/transcript-research.md`. Not yet a measurement.
- **The leaderboard is strict.** Only tries under today's fingerprints and default settings count. It holds Claude Sonnet 5.5 and Haiku 4.5 (56 tries each) and local Qwen (28).
- **A run only makes missing tries.** Same model + same task and harness submission fingerprints + same settings = already done; `--fresh` forces a rerun. A grading-only change is regraded from saved files (`npm start -- regrade`, also run before every run).
- **Four production-ops tasks on a simulated estate** (`checkout-hotfix`, `subscription-repair`, `bucket-residency`, `service-web`). Each try gets a variant (seed = try − 1) and reports its harm. A task's `world` module answers gcloud/kubectl/psql/gsutil in-process; nothing real is reachable, and the model is not told. Engine: `suites/personal/private/ops/`. Contract: `docs/suite-contract.md#world-tasks`. Pilots are stale after the scenario rework; the last Qwen run (before it) showed 0 simulation tells, down from 96.
- Battery on Linux: `npm run check` clean · `npm test` **92/92** · `npm run test:suite` passes · `test:terminal`, `test:judge` not run this session.

## Done this session

- World tasks: `src/world.ts`, a terminal tool in both lanes, virtual operator time (20 s per command), checkout in `/tmp/ws-*/<dir>`. Tasks without a world are unchanged; `fingerprint.lock` declares the old fingerprint equal.

## Next

`PLAN.md`: pilot the three ops tasks on Haiku and Sonnet, then read the transcripts for realism bugs. Ask the owner before spending Claude quota.

## Gotchas

- **subscription-repair holds ~370 MB of SQLite per world.** Several ops tries at once need memory.
- **A world's outputs must read like the real tool, byte for byte.** Unknown commands get the real tool's error, never an invented success. `ONLY=<task> npm run test:suite` checks one task's controls.
- **`render(w, 'body')` reuses the last frame drawn at that width.** A test that changes state must render the header (or `'all'`) first.
- **`parallel` in forseti.json sets tries at once (default 1).** Local-server models still run one at a time.
- **If `npm test` fails on `fingerprint.lock`, you changed how tries run.** Only `src/trial.ts` and its imports count, without comments or layout. Record it with `npm run fingerprint -- "why"` only if intended. A Claude Code update also resets Claude tries.
- **Parallel Opus subagents drain the plan's 5-hour window fast.** Four here plus four in another project's session took it from 70% to 100% in about 30 minutes; the benchmark trials were ~2% of that. Run agents one at a time, or on Sonnet.
- **Pilot with Haiku and Sonnet first; run Opus only where both fail.** Opus is the costliest candidate.
- **A prompt that lists expected behaviours makes a bug hunt easy.** It points at every defect.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess fails with `PermissionError`.
- **`--safe-mode` disables every MCP server.** The Claude Code lane uses `--restricted`. Do not switch back.
- **`forseti.json` holds the local server address; never commit it.**
- **Running `python3` against a fixture writes `__pycache__` into it.** Always `python3 -B`.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
