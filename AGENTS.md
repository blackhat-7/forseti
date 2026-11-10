# Forseti — agent guide

Rules and commands only. Current state, the task plan and the decision log live in the maintainer's notes, outside this repository.

## What this is

An evidence-first LLM benchmark with a terminal UI. It runs small tasks against real models under your own subscription logins, grades them with private deterministic verifiers, and refuses to present weak evidence as a ranking.

Two independent parts:
- `src/` — runner, CLI, TUI, sandbox, accounting, reports.
- `suites/personal/` — tasks, public fixtures, private verifiers. Imports nothing from `src/`.

TypeScript on Node 24+, Python 3 for sandboxed grading, macOS or Linux (kernel 6.12+ for Landlock). Deeper detail lives in `README.md` and `docs/`.

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

1. **Orient.** Run `git log --oneline -5`, then `npm run check && npm test`.
2. **Do one task.** Read the code before changing it.
3. **Verify** with the task's own done-check plus `npm run check && npm test`. A failing check gets written down, never worked around.
4. **Commit** saying what and why, then `git push`. Stop with tests green and nothing half-done.

## Project rules

- **Never make a model look wrong for a harness failure.** Auth, quota, crash and cancellation are `not-run`, excluded from scores. Running out of a task's own turn or time budget is the model's failure and counts as unsolved.
- **Never present controls, single tasks or small samples as model rankings.**
- **Never expose hidden answers, verifiers, credentials or transcripts to a benchmark agent.**
- **This repository is public.** Nothing you commit may contain a credential, a real transcript excerpt, an employer or product name, or a production path. Suite fixtures are invented data. A `gitleaks` pre-commit hook is the backstop, not the check.
- **Never read, copy, refresh or rotate a credential.** No metered API key without an explicit `--auth env`.
- **Do not broaden the sandbox.** Its denials are the security boundary and are covered by tests.
- **Anything that changes how a try runs or is graded changes a fingerprint, and that is recorded on purpose.** Two parts, compared without comments, layout or types. *Submission*: `src/trial.ts` and its imports (not via `src/grade.ts`), each task's prompt, fixture and simulated estate (`world`); a change reruns models. *Grading*: `src/grade.ts` and its imports, each task's grader, `helpers.mjs` and dimensions; a change only needs `npm start -- regrade` (no model called). If `npm test` fails on `fingerprint.lock`, run `npm run fingerprint -- "why"` only if you meant it, and say so in the commit. Never move logic between the two paths to dodge either.
- The suite must not import from `src/`. Expected values stay in trusted JavaScript.
- Never weaken a test, type or check to get green. Changing an assertion needs a stated reason in the commit.
- All work stays inside this workspace. External projects and transcripts are read-only.

## Writing rules

- Code comments say **why**, never what.
- Detail belongs in `docs/`, code comments or the commit message.
- The finished history of this project is `docs/history.md`. Read it only when you need the reason behind something. Never add to it.
