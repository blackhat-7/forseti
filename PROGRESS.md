# Progress

Handoff note. Rewritten at the end of every session, never appended to. Cap 40 lines.
Finished history: `docs/history.md`. Next task: `PLAN.md`. Rules: `AGENTS.md`.

**Last session:** 2026-09-18

## State

- All deliverables are built, documented and verified offline. Remaining work is blocked on credentials, not on code.
- Verified this session: `npm run check` clean, `npm test` **47/47**, `npm run test:suite` **12 tasks / 24 controls, exit 0**. `test:terminal` and `test:judge` not run this session.
- **Not a git repository yet.** The session routine's commit step cannot run until the first task in `PLAN.md` is done.

## Done this session

- Replaced a 293-line work log with the four-file system: `AGENTS.md`, `PROGRESS.md`, `PLAN.md`, `DECISIONS.md`. The old log moved to `docs/history.md` unchanged.
- Extracted the durable "why" from 21 milestones into `DECISIONS.md` so it survives without the log.

## Next

First unchecked line in `PLAN.md`: put the workspace under git.

## Gotchas

- **Only the Claude Code login works right now.** Codex OAuth is rejected server-side (`Provided authentication token is expired`) even though the stored token is unchanged and its recorded expiry is days away; a read-only preflight cannot see server-side revocation. Kimi's monthly quota is exhausted until the next billing cycle. Forseti will not rotate a token or buy quota.
- Auto mode's gatekeeper classifier fails closed intermittently and blocks all tool calls. Refresh the Codex login in Pi and retry. Do not change auto-mode configuration.
- lean-ctx resolves a different active project root, so some reads outside this workspace are denied. Use plain read-only commands for those. Do not reconfigure it.
- Runs before `19-09-01` predate the suite-hardening and rubric changes, so their hashes differ. Keep them; reports split them into separate groups rather than pooling.
- `TMPDIR="$PWD/.tmp"` is required for `npm ci` and `npm run test:terminal`.
