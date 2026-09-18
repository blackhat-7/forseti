# Tooling decision

Inspected before implementation (2026-09-15):

- Existing personal `benchmark_llms`: Python stdlib wrapper around interactive OpenCode, repository clone and manual judge/CSV. Read its README, config, CLI and parser. Retain its independent suite + durable artifact idea. Do not reuse execution: prompts were manually submitted, latest-session lookup was not bound to the launched run, exit statuses were ignored, and cwd was not confinement. It had no automated verifier or TUI.
- [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai): mature Python model/tool/scorer infrastructure, over 200 evals, web log viewer. Strong alternative for research breadth; a custom Pi-auth bridge, terminal UI and confinement boundary would still be needed here.
- [Promptfoo](https://github.com/promptfoo/promptfoo): established CLI/library for assertions and web comparisons. Excellent prompt regression tool; not the minimal path to this bounded Pi coding harness and terminal-first workflow.
- [Harbor](https://github.com/harbor-framework/harbor): mature arbitrary coding-agent evaluation and container environments; appropriate for full CLI/Terminal-Bench evaluations. Docker/cloud execution and multi-agent adapters exceed this workspace-contained first version's requirements.
- Pi 0.85.1: read SDK, provider/auth, agent-core and TUI documentation plus SDK/tool-selector examples. Use **pi-ai + pi-agent-core + pi-tui**, not full CLI/SDK resource discovery. This reuses the real provider/auth/stream/tool loop and terminal renderer while excluding personal extensions, skills, contexts and shell tools.

This is a focused local benchmark application, not a replacement for those frameworks. No new OAuth implementation, model judge service, web server, database or container orchestrator. Plain JSON manifests/results and independent JavaScript graders suffice.

## Safety and accounting decisions

- Models access only fresh public fixtures through path-checked tools. Python execution requires macOS Seatbelt (`sandbox-exec`); unsupported hosts fail closed rather than running untrusted code without confinement. General shell and full external CLI agents are intentionally not supported.
- Existing Pi credentials are read-only references. Resolve them in memory, refuse command-based credentials, and refuse refreshing an external OAuth token (rotation could break the original session). Expired auth asks for supported Pi re-login; no silent fallback to API keys. API keys can be read from environment explicitly.
- Authentication is not billing. [Pi provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) explicitly describes Claude third-party OAuth as **metered extra usage**, OpenAI Codex as subscription, and OpenRouter OAuth as credits. Unknown billing remains unknown and requires metered opt-in. Rate limits stop later trials for that provider; no account switching or automatic paid fallback.
- Controls exercise grading and reporting but are labeled synthetic. Live results are separate. Deterministic checks explain observed differences; they cannot prove a model's internal reasoning or measure all code quality.
- Fixed harness model comparisons and prompt-only/tool-enabled ablations are separate. Record hashes, settings, deadlines, per-stage latency, token/cache counts and estimates; report missingness and infrastructure failures, never convert them silently into model failures.
