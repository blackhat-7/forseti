# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- All deliverables are built, documented and verified offline. Remaining work is blocked on credentials, not on code.
- Verified this session: `npm run check` clean, `npm test` **47/47**, `npm run test:suite` **12 tasks / 24 controls, exit 0**. `test:terminal` and `test:judge` not run this session.
- Published at **https://github.com/blackhat-7/forseti**, public, tracking `origin/main`. Working tree clean. A `gitleaks` pre-commit hook runs on every commit and has passed on all of them.

## Done this session

- Replaced a 293-line work log with the four-file system: `AGENTS.md`, `PROGRESS.md`, `PLAN.md`, `DECISIONS.md`. The old log moved to `docs/history.md` unchanged, and `README.md` now points at all five.
- Extracted the durable "why" from 21 milestones into `DECISIONS.md` so it survives without the log.
- Put the workspace under git. It had never been a repository, which left the routine's commit step impossible.
- Created the public GitHub repo and pushed. Checked first: `gitleaks detect` over full history found nothing, no employer or personal names are tracked, fixtures hold invented data, and `docs/transcript-coverage.json` stores SHA-256 hashes rather than filenames.

## Next

First unchecked line in `PLAN.md`: after a fresh Pi Codex login, run `npm run test:judge`. Until that agreement number exists the reviewer is unvalidated and its design scores must not be read.

## Gotchas

- **Only the Claude Code login works right now.** Codex OAuth is rejected server-side (`Provided authentication token is expired`) even though the stored token is unchanged and its recorded expiry is days away; a read-only preflight cannot see server-side revocation. Kimi's monthly quota is exhausted until the next billing cycle. Forseti will not rotate a token or buy quota.
- Auto mode's gatekeeper classifier fails closed intermittently and blocks all tool calls. Refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some reads outside this workspace are denied, including files under `/private/tmp`. Use plain read-only commands or the native reader for those. Do not reconfigure it.
- Runs before `19-09-01` predate the suite-hardening and rubric changes, so their hashes differ. Keep them; reports split them into separate groups rather than pooling.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.
