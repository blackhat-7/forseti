# Forseti — agent guide

**Every session, read these four files first, in order. They are short on purpose.**
`AGENTS.md` (this file) · `PROGRESS.md` (where things stand) · `PLAN.md` (what to do next) · `DECISIONS.md` (why things are the way they are).

## What this is

An evidence-first LLM benchmark with a terminal UI. It runs small tasks against real models under your own subscription logins, grades them with private deterministic verifiers, and refuses to present weak evidence as a ranking.

Two independent parts:
- `src/` — runner, CLI, TUI, sandbox, accounting, reports.
- `suites/personal/` — tasks, public fixtures, private verifiers. Imports nothing from `src/`.

TypeScript on Node 24+, Python 3 for sandboxed grading, macOS only. Deeper detail lives in `README.md` and `docs/`.

## Commands

Run all of these from the workspace root. The CLI refuses any other directory.

```sh
TMPDIR="$PWD/.tmp" npm ci          # install
npm run check                      # typecheck
npm test                           # framework + UI tests
npm run test:suite                 # verifiers vs references and flawed baselines
npm run test:judge                 # reviewer agreement (needs a live credential)
TMPDIR="$PWD/.tmp" npm run test:terminal   # real PTY run of the TUI
npm start                          # the TUI
npm run demo                       # 36 synthetic trials, no provider needed
```

## Session routine

1. **Orient.** Read the four files. Run `git log --oneline -5`, then `npm run check && npm test`. Confirm reality matches `PROGRESS.md`. Say so if it does not.
2. **Pick one task** — the top unchecked line in `PLAN.md`. Mark it `[~]`.
3. **Do only that task.** Read the code before changing it.
4. **Verify** with the task's own done-check plus `npm run check && npm test`.
5. **Leave the trail.** Tick `[x]` in `PLAN.md`. Rewrite `PROGRESS.md`. Append to `DECISIONS.md` if you chose something a later reader might undo. Commit saying what and why, then `git push`.
6. **Stop.** Tests green, nothing half-done.

**A task is not finished until step 5 is finished.** Report honestly at step 4: a failing check gets written down, never worked around.

## Project rules

- **Never make a model look wrong for a harness failure.** Auth, quota, timeout and crash are `not-run`, excluded from scores.
- **Never present controls, single tasks or small samples as model rankings.**
- **Never expose hidden answers, verifiers, credentials or transcripts to a benchmark agent.**
- **This repository is public.** Nothing you commit may contain a credential, a real transcript excerpt, an employer or product name, or a production path. Suite fixtures are invented data. A `gitleaks` pre-commit hook is the backstop, not the check.
- **Never read, copy, refresh or rotate a credential.** No metered API key without an explicit `--auth env`.
- **Do not broaden the sandbox.** Its denials are the security boundary and are covered by tests.
- Anything that changes comparability goes in `comparisonKey`, so unlike runs never pool.
- The suite must not import from `src/`. Expected values stay in trusted JavaScript.
- Never weaken a test, type or check to get green. Changing an assertion needs a stated reason in the commit.
- All work stays inside this workspace. External projects and transcripts are read-only.

## Writing rules

These keep the four files usable by a fresh reader with no memory of this session.

- **Write for someone who knows nothing.** No "as discussed", no "the usual approach". Name files, flags and commands.
- **Plain words, short sentences, one idea each.** State the fact, not the story around it.
- **Rewrite `PROGRESS.md`, never append to it.** It is a handoff note, not a log. Delete what is no longer true.
- **Size caps, enforced:** `AGENTS.md` ≤ 80 lines · `PROGRESS.md` ≤ 40 lines · `PLAN.md` one line per task · `DECISIONS.md` ≤ 3 lines per entry.
- Past this cap, cut, do not continue. Detail belongs in `docs/`, code comments or the commit message.
- **Record gotchas, not narrative.** If you hit a trap, the next agent will too. One line, in `PROGRESS.md`.
- Code comments say **why**, never what.
- The finished history of this project is `docs/history.md`. Read it only when you need the reason behind something the four files do not explain. Never add to it.
