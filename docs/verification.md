# Verification record

What was actually executed, what it proves, and where the evidence is. Every command runs from the workspace root and writes only inside it.

Last full pass: 2026-09-16, Darwin 25.0.0 arm64, Node 26.0.0 (`engines` requires 24+), Python 3.14.5 (Homebrew), Pi libraries pinned at 0.85.1.

## Automated checks

| Command | Result | What it covers |
|---|---|---|
| `npm run check` | clean | TypeScript strict, no emit, over `src/`, `tests/`, `tools/`. |
| `npm test` | **48/48 pass** | Framework checks + TUI checks. See below. |
| `npm run test:suite` | **12/12 references pass, 12/12 flawed baselines rejected** | Suite-only validation with no framework import. |
| `TMPDIR="$PWD/.tmp" npm run test:terminal` | PASS | The real TUI in a real PTY, end to end. |

Reproduce all four:

```sh
npm run check && npm test && npm run test:suite && TMPDIR="$PWD/.tmp" npm run test:terminal
```

### Framework checks (`tests/framework.test.ts`)

Isolation and safety
- paths, links, special files and oversized outputs fail closed
- real OS sandbox denies hidden reads, escapes, network, fork, links and host secrets
- model tools cannot reach private paths and prompt-lane traversal is a model output failure
- grading is read-only even for import-time effects; saved artifacts stay truthful

Accounting honesty
- strict settings, explicit billing, instruction-only rubrics and seeded schedules
- missing auth stops the provider cohort without fallback; metered consent precedes calls
- read-only OAuth preflight agrees with Pi five-minute validity window
- invalid submissions cannot inflate correctness or overwrite censored outcomes
- cancelled plans, stale/incomplete manifests and verifier crashes remain distinguishable

Runner and reporting
- real Pi agent loop records tools, usage, schema errors and budgets using an offline provider
- all independent controls run through real sandbox, persist and compare with evidence
- instruction-only comparisons retain differences and selected task sets do not mix
- add model/test and reversible lifecycle work without touching external references
- prompt caching is on by default, reaches the provider, and never pools with uncached runs

### TUI checks (`tests/ui.test.ts`)

Layout at 40/80/120 columns; terminal-escape sanitising (OSC/DCS/ANSI/C1/bidi); navigation, toggles, confirmed removal and empty states; the filtered native catalogue picker; the test wizard; **payment consent for metered and unknown billing**; preflight using the effective selected auth; cancel-from-every-form; persistence rollback on save failure; run rejection clearing busy state; settings bounds.

### Suite checks (`npm run test:suite`)

Runs each task's hidden verifier against a correct reference and a deliberately flawed baseline, without loading any framework code.

- 12 tasks × 2 controls = 24 control gradings
- 89 checks per control set: the reference passes 89/89; the flawed baseline passes 56/89 and is rejected on **all 12 tasks**
- 13 tool-trace checks, 9 empty-trace grader checks, 10 hygiene-probe cases, 9 observation regressions, 4 diagnostic assertions
- Every reference passes every check; every baseline is rejected on at least one check

A verifier that passed both controls would be silently useless, so this is the gate for adding a task.

### PTY check (`npm run test:terminal`)

Drives the real binary through a pseudo-terminal at 110×36: mount → model view → test view → home → preflight → confirm → **36 isolated control trials** → comparison → export → evidence → `q` → exit code 0. It temporarily selects only the synthetic controls and restores `forseti.json` byte-for-byte afterwards. The raw terminal output is kept at `.cache/tui-pty.ansi`.

## Sandbox evidence

`npm run doctor` exercises the real macOS `sandbox-exec` profile rather than asserting a policy string. The framework test additionally confirms denials for: reading a sibling hidden file, writing outside the trial directory, opening a socket, `fork`, hard links and symlinks out of the trial, and reading host credential environment variables. Grading Python is mounted read-only, so a candidate cannot mutate its own artifacts at import time to make the saved snapshot lie.

Boundaries and known limits: [security.md](security.md).

## Credential evidence

`.state/auth-before-live.json` fingerprints `~/.pi/agent/auth.json` (SHA-256, size, mtime) as it stood before the first live run. Re-fingerprinting after every live run, `doctor` call and preflight since gives a **byte-identical hash and an unchanged mtime**. Forseti reads existing Pi credentials and never writes, refreshes or rotates them; the credential store's `modify` and `delete` hooks throw by design.

Re-check it yourself at any time — the recorded `sha256` must still match:

```sh
shasum -a 256 ~/.pi/agent/auth.json && cat .state/auth-before-live.json
```

That is also why the later Codex `auth_error` is not a Forseti bug: the stored token never changed, and the provider stopped accepting it.

## Screenshot

`npm run screenshot` renders the live dashboard — real config, real saved runs — to `docs/tui-home.svg`. The generator parses the dashboard's own ANSI output, so the picture cannot drift from the code. A grid check confirmed every row reproduces character-for-character within 132 columns.

## Live provider verification

Full record with the generated tables: [reports/live-smoke.md](../reports/live-smoke.md).

Verified working end to end against a real subscription provider:
- `openai-codex/gpt-5.5`, two tasks × two repetitions, **4/4 correct**, with recorded `read_file` / `write_file` / `python` tool traces, per-stage timing, first-delta latency and reported token counts (8594 in / 1300 out).
- Billing displayed as **subscription · USD n/a** — never "$0".

Verified failure handling against real provider errors:
- `kimi-coding/kimi-for-coding` → monthly-quota 403. Remaining trials `skipped`; no retry, no account switching, no paid fallback.
- `openai-codex/gpt-5.5` on the later attempt → `Provided authentication token is expired`, despite a locally stored expiry still three days in the future. The run stopped that model and recorded the provider's message verbatim.
- `openai-codex/gpt-5.4` and `gpt-5.4-mini` exist in the pinned catalogue but a ChatGPT-account Codex login is not entitled to them. They are disabled in `forseti.json`. **Catalogue presence and auth readiness do not imply account access.**

### Live caveats

- A read-only preflight can only see the credential file. Server-side revocation is invisible until the first request, so `ready` means "locally usable", not "the provider will accept it".
- Four correct trials on two tasks are evidence that the live path works, **not** a model ranking.
- Provider-side sampling, caching and model aliases are not controlled. Repeat *scheduling* is deterministic; model *responses* are not.
- Saved runs from before the suite-hardening pass carry a different suite hash. Forseti splits them into separate report groups rather than pooling them; that split is visible in `reports/live-smoke.md`.

## Current blockers

1. **Codex OAuth is rejected server-side.** Log in again in your own Pi session, then rerun the live smoke. Forseti will not refresh or rotate external tokens.
2. **Kimi monthly quota is exhausted.** It refreshes next billing cycle. Forseti will not purchase extra usage.

Neither is a workspace defect; both are recorded in the run manifests and the report.

## Prompt caching (2026-09-16)

Forseti originally sent `cacheRetention: 'none'`, overriding Pi's `'short'` default. Every saved live trial confirms the effect — `cacheRead: 0, cacheWrite: 0` on all four Codex trials, so the system prompt, tool schemas and growing transcript were re-sent **uncached on every turn**. In a 4-turn trial that is most of the input bill paid two to four times over.

Caching is now on by default (`--no-cache` or `p` in the TUI to disable). Prompt caching reuses the prefix KV state; it does not change sampling, so correctness and hygiene measurements are unaffected. It does change repeated input cost and first-delta latency, so `cache` is part of the comparison key and cached and uncached runs land in separate report groups.

Covered by `prompt caching is on by default, reaches the provider, and never pools with uncached runs`, which asserts the default, that `'short'`/`'none'` actually reach `streamSimple`, and that the two comparison keys differ.

**Caveat:** the shuffled schedule interleaves models, so a cache entry rarely survives to the same model's next trial. Caching helps *within* a trial's turns, which is where the multiplier came from. Sorting the schedule by model would warm the cache further but would reintroduce ordering bias, so it was not changed.
