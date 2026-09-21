# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-21

## State

- Nineteen tasks. Two lanes: `src/adapter.ts` (Pi, for API and local models) and `src/claudecode.ts` (the Claude Code CLI, under your own plan login). **Both lanes now hold the identical four tools**, so a cross-lane number is a model number.
- **Do not trust a one-repeat run.** Twelve tasks at one repetition once read 90/91/93; the full record reads 59/80/95.
- Four tasks carry a design rubric: `duplicate-rule`, `event-ledger`, `regression-boundary`, `reconcile-plan`. The reviewer reproduces the recorded standard **104/104**.
- **Models on your own machine run.** Provider `local` is any OpenAI-compatible server (llama-server, Ollama, LM Studio). Address on Settings (`5`, Address row) or `npm start -- local URL`. No credential, billing `local`, Pi lane.
- `claude-code/opus`, `sonnet`, `haiku` and one local Qwen are enabled. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**.
- Battery this session: `npm run check` clean · `npm test` **59/59** · `npm run test:suite` passes. `test:terminal` and `test:judge` not re-run: no UI or reviewer change.

## Done this session

- **Added the `local` provider** (`src/local.ts`) and measured Qwen3 27B Q4 at 19 tasks × 2: 88% on 30 graded trials, 8 stalls, median 25s. Haiku × 1 the same day: 71% on 17 graded, 1 timeout.
- **Diagnosed the stalls.** Qwen writes its answer early then loops on self-written Python tests to the turn cap. Seven of eight stalls were that; four were tasks it solved on the other repeat.
- **Found the comparison was invalid** and fixed it. Haiku stalled less because the Claude Code lane had no execution tool at all, not because it stops better. Forseti now serves its four tools to the CLI over MCP and denies the CLI's own, so both lanes read, write and run code identically.
- Verified with a real Haiku trial: four reads, one write, and it ran `check_public.py` through the Seatbelt sandbox. Tool checks now grade that lane.

## Next

**Every number above predates the uniform lane and cannot be compared across lanes.** Re-measure Qwen and Haiku under the current harness before quoting either. The open PLAN line still wants one more task like `due-dates`.

## Gotchas

- **The harness hash changed twice this session.** Every run before this commit sits in its own comparison group. That is correct, not a bug.
- **`--safe-mode` disables every MCP server**, so the Claude Code lane cannot be given tools under it. It uses `--restricted`. Do not switch back.
- **`forseti.json` holds the local server address; never commit it.** It is tracked but stays modified on purpose. Exported reports name the server and the model's file path.
- **A hybrid local model thinks unless told not to.** Thinking `off` is sent as `enable_thinking: false`. With thinking `high`, raise `--tokens` well past 4096 or turns get censored as `budget`.
- **llama-server names a model by its file path** unless started with `--alias`. The config `model` limit is 500 characters for that reason.
- **The Claude plan rate limit stops the whole run for that provider.** Budget a measurement below the limit or expect `not-run` rows.
- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.**
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
