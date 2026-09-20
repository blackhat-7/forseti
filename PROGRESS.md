# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-21

## State

- Nineteen tasks. Across the whole record the suite separates the bottom of the table by ~36 points (Haiku 59%, Sonnet 80%, Opus 95% at n=19). **`due-dates` is the first task the report calls a separation between Opus and Sonnet**: pooled over two runs Opus 6/6, Sonnet 1/5 (one stall), Haiku 0/2. `retry-rollup` (2/3 vs 3/3) and `iso-weeks` (2/3 vs 3/3) lean the same way but stay inside the noise.
- **Do not trust a one-repeat run.** Twelve tasks at one repetition once read 90/91/93; the full record reads 59/80/95.
- Four tasks carry a design rubric: `duplicate-rule`, `event-ledger`, `regression-boundary`, `reconcile-plan`. The reviewer reproduces the recorded standard **104/104**.
- **Models on your own machine now run.** Provider `local` is any OpenAI-compatible server (llama-server, Ollama, LM Studio). Address on Settings (`5`, Address row) or `npm start -- local URL`; the picker lists what it serves under `local/`; no credential; billing `local`; trials go through the Pi adapter and pool with other API models. Code: `src/local.ts`, plus `local.url` in `forseti.json`.
- `claude-code/opus`, `sonnet` and `haiku` are enabled. Codex OAuth is still rejected server-side; Kimi quota is still exhausted. Public at **https://github.com/blackhat-7/forseti**, tracking `origin/main`.
- Battery this session: `npm run check` clean · `npm test` **58/58** · `npm run test:suite`, `test:terminal` and `test:judge` were not re-run: no suite, PTY-visible-key or reviewer change.

## Done this session

- **Added the `local` provider.** `src/local.ts` builds a keyless pi `Models` with `createProvider` and the openai-completions API, pinned to the plain dialect every local server speaks: `max_tokens`, `system` role, no `store`, no `reasoning_effort`, thinking `off`. `GET /v1/models` is the only request made outside a run, and only when the address is saved or the model picker opens with an unlisted address. Never on startup.
- **One real trial on a llama-server (Qwen3 27B Q4): `shared-count` passed 10/10 checks in 5 turns and 52s**, billing `local`, server recorded in `environment.catalog`. Not a measurement, a smoke test.
- Two new tests: a fake OpenAI-compatible server driven from `localUrl` through `App.run` and the report (framework), and the Settings → picker → add → preflight flow (UI).
- `harnessHash` changed (`auth.ts`, `config.ts`, `runner.ts`, `adapter`-adjacent files), so runs before this commit sit in their own comparison group.

## Next

The open PLAN line is still the top one and needs one more task like `due-dates`. What discriminated is behaviour the engine offers no spelling for: Postgres and MySQL clamp `+1 month`, SQLite does not, and the fix is an expression nobody has memorised. A rule the prompt states (`all-green`) or a format code the docs name (`iso-weeks`, `%G-W%V`) gets found by Sonnet. **Do not start another full-suite run.** A local model is a cheap way to measure the bottom of the table; expect a 27B Q4 model at ~1 minute per trial.

## Gotchas

- **`forseti.json` holds the local server address and the user's reviewer tweaks; never commit it.** It is tracked but stays modified in the working tree on purpose. A report exported from a local run names the server and the model's file path; do not commit those either.
- **llama-server names a model by its file path** unless started with `--alias`. Forseti shortens it to the file name for the config ID and label; the API `model` field keeps the full path, so the config `model` limit is 500 characters.
- **The Claude plan rate limit stops the whole run for that provider**, and the remaining trials of every Claude model are skipped. Budget a measurement below the limit or expect `not-run` rows.
- **Running `python3` against a fixture directory writes `__pycache__` into it**, and `fixture()` then dies with `EISDIR`. Always `python3 -B`, and check `ls -a` on the fixture afterwards.
- **A calibration case is Python inside a JS template literal.** Indentation must match where the fragment lands, and a `\d` needs doubling. `npm run test:suite` catches both.
- **`quality` is a substring of `equality`.** A blind `sed s/quality/hygiene/` corrupts `regression-boundary`'s title and prompt.
- **`npm run test:terminal` and `npm run test:judge` spend Claude plan quota.** The PTY test copies `forseti.json` with the reviewer enabled and restores it afterwards.
- **The UI test fixture is a 24-row window.** A scorecard longer than 13 lines is paged, so a test asserting on the lower sections must pass `fixture('subscription', 60)`.
- **A reviewer's thinking level is part of its identity.** Re-run `npm run test:judge` after any reviewer change.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`. `CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`.
