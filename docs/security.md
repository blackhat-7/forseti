# Execution and grading boundary

## What is enforced

- The CLI refuses a working directory other than its own workspace before creating files. Application files, caches, snapshots, execution directories and reports stay in that workspace.
- A benchmark model receives only the task prompt and public fixtures. No transcript archive, global Pi context, extension, skill, hidden reference, grader or credential is loaded into its conversation.
- File tools resolve against the **individual trial's public directory**, reject traversal, symlinks, hard links and special files, and bound file size/tree size/depth. No general shell, MCP, browser, package installer or external CLI tool is exposed.
- Python starts with an allowlisted environment and a macOS Seatbelt deny-default profile. It can read the public trial and specified system runtime directories. It cannot read sibling grading/results/credential files, use the network or create child processes. It can write only inside its trial while the model is working.
- **Grading Python is read-only.** Import-time candidate code cannot alter protected fixtures or make the saved artifact snapshot stale. Python execution is bounded by a deadline, CPU hard limit, per-file size limit, file-descriptor limit and output cap. Descendant process groups are killed on exit/cancellation.
- Every run first performs actual negative sandbox probes. If isolation or the supported interpreter is unavailable, execution stops. Unsupported operating systems have no permissive fallback.

The allowlisted runtime read directories are `/System`, `/usr/lib`, `/usr/share`, `/Library/Frameworks`, `/Library/Developer` and Homebrew's `/opt/homebrew/Cellar`, plus a few exact runtime/device paths. These must contain trusted runtime material, not secrets. Trial workspaces inside these roots are rejected. Metadata-only filesystem access permits loader/stat operations; it does not expose hidden file contents.

## Trusted and untrusted code

The application, installed Pi packages and suite JavaScript graders are **trusted local code**. Review a third-party suite as code before installing it. The framework does not sandbox malicious JavaScript graders, nor claim protection from a hostile host administrator.

Model-written Python is untrusted and never imported by Node or an unsandboxed grading process. Public observation drivers execute explicit hidden case inputs after model completion and return raw candidate outputs/state. **Expected outputs and verdicts stay in private JavaScript.** Candidate assertions, claimed test passes, stdout banners and generated tests do not determine correctness.

Captured serialization and read-only grading defend practical tampering paths. A finite black-box test is not a proof that a program is correct on every input, nor immune to a deliberately adversarial implementation that recognizes its evaluation protocol. The benchmark measures observable outcomes on its disclosed contract. See the suite's observation-protocol notes and regression tests.

`test:suite` executes only trusted, newly authored reference/baseline controls; it is not an alternative runner for arbitrary model output. Actual model trials always use the framework sandbox.

## Authentication and money

Existing Pi credentials are read directly and never modified or copied. Command-based credential resolution is refused. External OAuth rotation is refused even in memory: rotating a refresh token can invalidate the original login. Preflight matches Pi's five-minute minimum validity window. Use the provider's supported Pi login separately when credentials expire.

API keys may be supplied through supported environment variables or existing Pi key entries. Auth mode and billing are recorded separately. OAuth does not imply unmetered usage. No retries, account rotation, purchase, upgrade, paid fallback or quota bypass occurs. Limits stop the provider's remaining jobs; other provider failures stop the model's remaining jobs. A metered opt-in is not a financial spending cap.

No secrets are intentionally logged. Provider errors are bounded and obvious credential patterns redacted. Untrusted terminal output is stripped of control sequences. Do not put secrets in prompts or fixtures: legitimate model requests transmit those to the selected provider.

## Limits and recovery

- Seatbelt is platform-specific and is not a full VM. Memory use and aggregate disk consumption are not hard-quotad; CPU/time/output/per-file limits reduce but do not eliminate denial-of-service risk. Do not run hostile contest submissions on a sensitive host.
- System libraries/interpreter are not vendored. Their versions/paths and host details are recorded, not claimed hermetically reproducible. OS/harness-owned diagnostic logging is outside application-managed artifact storage.
- A run holds `.state/run.lock`. After a crash, inspect its PID before removing that **local** lock. Existing results remain; unclosed manifests display as interrupted. Rerun into a fresh directory rather than silently retrying or double-counting attempts.
- Each completed trial and manifest is replaced atomically; event records are appended during execution. Abrupt power loss is not claimed transactionally fsync-durable. Saved counts distinguish planned, recorded, evaluated and censored trials.
- Controls, hidden references and detailed evidence can reveal answers to a human reading the workspace. They are hidden from tested agents, not encrypted from the workspace owner. Sharing full run snapshots can contaminate future evaluations; review/redact before sharing.
