# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-27

## State

- **Runs on macOS and Linux.** On Linux, `src/sandbox-linux.py` confines the interpreter with Landlock + seccomp before candidate code. Needs kernel 6.12+, x86_64 or arm64; anything else fails closed.
- **22 tasks in three difficulty tiers** (`tier` in `suite.json`, recorded on every run). `hard` 2: `retry-rollup`, `due-dates` — the only tasks with a recorded Sonnet/Opus split. `standard` 9: separate Haiku from Sonnet/Opus. `basic` 11: every Claude model passes; there for small local models.
- **Two lanes, both can run sandboxed Python.** Pi (`src/adapter.ts`, API and local models) and Claude Code (`src/claudecode.ts`, plan login, Python over MCP from `src/mcpserver.ts`). Provider `local` is any OpenAI-compatible server; address on Settings.
- **Results are one page.** Ranked models (a tie shares a rank), verdict sentences, then by difficulty and by skill with a place per cell judged on those tasks alone, then a per-task grid hardest first. Plain words throughout; the markdown report opens with the same page. Kanagawa Dragon palette.
- Battery on Linux: `npm run check` clean · `npm test` **62/62** · `npm run test:suite` passes, 22 tasks. `test:terminal` and `test:judge` **not run**: both spend plan quota.

## Done this session

- Linux sandbox, with a Linux-only test for exec, raw fork, signals, sockets and namespaces.
- One-page comparison, merged with the 2026-09-21 TUI rebuild: kept its Runs and Tests tabs, footer keys, `table()` helper, local-server Settings row and strict per-kind verdicts (now `sliceCard`, shown as places). Dropped its per-candidate tables and "X over Y" lines, which said the same thing as the rank list.
- Plain names for skills ("Edge cases right" for `exactness`, etc.) and signals ("Tasks fully solved", "tries"). Ids in data are unchanged.
- Added `invoice-rounding`, `league-table`, `ticket-sla` (Python traps). **Tier `basic`, never run**: the same kind of task (`zip-manifest`, `double-delivery`) went Opus 6/6, Sonnet 6/6, Haiku 5/6.

## Next

`PLAN.md`: one more task that separates Opus from Sonnet, built like `due-dates` (engine behaviour with no spelling for the rule), not a Python trap. **Do not benchmark local models while another session is tuning them.**

## Gotchas

- **Any edit to `suite.json` changes the suite hash**, re-tiering included, so later runs form a new comparison group. Rendering edits to `report.ts`/`tui.ts` do not.
- **The Linux sandbox denies `exec` of anything, even Python.** A grader that needs a subprocess fails there with `PermissionError`, by design.
- **A copied `node_modules` has no `.bin`, so `tsc` is missing.** Run `TMPDIR="$PWD/.tmp" npm ci` after moving machines.
- **`--safe-mode` disables every MCP server.** The Claude Code lane uses `--restricted`. Do not switch back.
- **`forseti.json` holds the local server address; never commit it.**
- **A hybrid local model thinks unless told not to.** Thinking `off` is sent as `enable_thinking: false`.
- **The Claude plan rate limit stops the whole run for that provider.** Budget below it or expect `not-run` rows.
- **Running `python3` against a fixture writes `__pycache__` into it**, and `fixture()` dies with `EISDIR`. Always `python3 -B`.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.**
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
