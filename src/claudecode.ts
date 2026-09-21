import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { safeError } from './adapter.ts';
import { files, inside } from './files.ts';
import { MCP_ALLOWED, MCP_SERVER } from './mcpserver.ts';
import type { ModelConfig, RunOptions, Task, ToolEvent, Trial } from './types.ts';

/** Model aliases the CLI accepts. Full IDs also work; these are what we offer in the catalog. */
export const CLAUDE_CODE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/**
 * The only tools this lane gets, and they are Forseti's own, served over MCP. The CLI's native
 * file tools are denied below so both lanes hold the identical four: a Claude model and a local
 * model now read, write and run code through the same implementations, under the same sandbox
 * and the same 64-call budget. Before this, the Pi lane could run `check_public.py` and this one
 * could not, so a cross-lane score compared capabilities rather than models.
 */
export const CLAUDE_CODE_ALLOWED = MCP_ALLOWED;
/**
 * Actually removes tools. `--allowedTools` only pre-approves; without this the session still
 * carries Bash, web access and subagents, which this lane must not have: it runs outside the
 * Seatbelt sandbox, and network/subagent access would also make it a different benchmark.
 */
export const CLAUDE_CODE_DENIED = 'Read,Write,Edit,Glob,Grep,Bash,Task,WebFetch,WebSearch,NotebookEdit,Workflow,SendMessage,RemoteTrigger,CronCreate,CronDelete,CronList,ScheduleWakeup,EnterWorktree,ExitWorktree';

/**
 * A reviewer only reads the prompt and answers, so it gets no tools at all — not even Read.
 * `--allowedTools` alone would only pre-approve; the tools have to be denied to be absent.
 */
export const CLAUDE_CODE_JUDGE_DENIED = `${CLAUDE_CODE_DENIED},TodoWrite,BashOutput,KillShell`;

let binary: string | undefined;
export function claudeCodeBinary(): string {
  if (binary) return binary;
  const found = spawnSync('/usr/bin/which', ['claude'], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error('Claude Code CLI not found on PATH. Install it with `npm install -g @anthropic-ai/claude-code` and run `claude` once to log in.');
  return (binary = realpathSync(found.stdout.trim()));
}

/** The flags are part of the result: they are recorded per run so an old run stays reproducible. */
export function claudeCodeArgs(model: string, maxTurns: number, mcpConfig = 'MCP_CONFIG'): string[] {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    // `--restricted`, not `--safe-mode`: safe mode disables every customization including MCP
    // servers, so Forseti could not hand this lane its own tools. Restricted mode ignores the
    // host's settings files, removes the built-in code runners and confines file tools to the
    // working directory, and a check confirms it does not pull in this repo's CLAUDE.md.
    // Unlike `--bare` it keeps the subscription login.
    '--restricted',
    // Only the server named on the next flag; the host's MCP configuration is ignored.
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
    '--disable-slash-commands',
    // Locked-down: anything that would prompt is denied rather than waiting for a human.
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--allowedTools', CLAUDE_CODE_ALLOWED,
    '--disallowedTools', CLAUDE_CODE_DENIED,
    '--max-turns', String(maxTurns),
  ];
}

/**
 * `--max-turns 1` looked right — a reviewer reads and answers — but denying a tool does not stop
 * the model reaching for one. A single rejected tool call then consumed the only turn and the CLI
 * exited with no result, so the reviewer scored nothing. Three turns lets a stray attempt bounce
 * off the denial and still leave room to answer; it cannot loop, because there is no tool to use.
 */
export function claudeCodeJudgeArgs(model: string): string[] {
  return [
    '-p', '--model', model, '--output-format', 'json',
    '--safe-mode', '--disable-slash-commands',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--disallowedTools', CLAUDE_CODE_JUDGE_DENIED,
    '--max-turns', '3',
  ];
}

/** The MCP server's append-only log of every tool call, in the same shape the Pi lane records. */
export function readTrace(path: string): ToolEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as ToolEvent]; } catch { return []; }
  });
}
/** Shared child-process plumbing: bounded output, killed on abort or deadline. */
function runCli(args: string[], prompt: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE']) delete env[key];
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(claudeCodeBinary(), [...args, prompt], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', size = 0;
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const consume = (data: Buffer, isError: boolean) => {
      size += data.length;
      if (size > 4 * 1024 * 1024) { stop(); return; }
      if (isError) err += data.toString(); else out += data.toString();
    };
    child.stdout.on('data', (d: Buffer) => consume(d, false));
    child.stderr.on('data', (d: Buffer) => consume(d, true));
    child.on('error', reject);
    child.on('close', c => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve({ stdout: out, stderr: err, code: c }); });
  });
}

/**
 * One reviewer call through the user's own Claude Code login, for people whose only working
 * model access is their Claude plan. It is a different client from the Pi adapter, which is why
 * the reviewer's provider is part of the comparison key.
 *
 * Every failure throws: the caller turns that into a note on the trial, never a model failure.
 */
export async function reviewWithClaudeCode(model: string, prompt: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const { stdout, stderr, code } = await runCli(claudeCodeJudgeArgs(model), prompt, cwd, timeoutMs, signal);
  const parsed = resultMessage(stdout);
  const detail = [parsed?.result, stderr.trim()].find(t => t) ?? '';
  if (!parsed || typeof parsed.result !== 'string' || parsed.is_error || code !== 0) {
    throw new Error(safeError(detail || `Claude Code reviewer exited ${code} with no result. stdout started: ${stdout.slice(0, 300) || '(empty)'}`));
  }
  return parsed.result;
}

/**
 * `--output-format json` emits the whole session as a JSON array whose last `result` entry
 * carries the answer; older/simple runs emit that object on its own. Accept both.
 */
export function resultMessage(stdout: string): CliResult | undefined {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return undefined; }
  if (Array.isArray(data)) return data.findLast(m => (m as { type?: string })?.type === 'result') as CliResult | undefined;
  return data && typeof data === 'object' ? (data as CliResult) : undefined;
}

type CliResult = {
  result?: string; is_error?: boolean; subtype?: string; num_turns?: number; stop_reason?: string;
  total_cost_usd?: number; duration_ms?: number; duration_api_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};
const LIMIT = /usage limit|session limit|weekly limit|rate.?limit|hit your (opus|sonnet|haiku|fable) limit|spend limit/i;
const AUTH = /not logged in|\/login|authentication|unauthori[sz]ed|oauth|invalid api key|credential/i;

export function classify(text: string, exitCode: number | null): Trial['status'] {
  if (LIMIT.test(text)) return 'rate_limited';
  if (AUTH.test(text)) return 'auth_error';
  return exitCode === 0 ? 'failed' : 'provider_error';
}

/**
 * Runs one trial through the user's own Claude Code CLI, under their subscription login.
 * No credential file is read, copied or refreshed here; the first-party client authenticates
 * itself. API-key variables are stripped so this lane can never silently bill a metered key.
 */
export async function runClaudeCode(
  work: string, scratch: string, model: ModelConfig, task: Task, options: RunOptions, trial: Trial,
  signal: AbortSignal, notify: (phase: string) => void, record: (event: unknown) => void,
): Promise<void> {
  const root = realpathSync(work);
  // Both files live beside the workspace, never inside it: anything under `work` is part of the
  // submission, would be graded as an added file and would be readable by the model.
  const tracePath = inside(scratch, 'tools.jsonl');
  const configPath = inside(scratch, 'mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_SERVER]: {
    command: process.execPath,
    args: [fileURLToPath(new URL('mcpserver.ts', import.meta.url)), root, tracePath],
  } } }), { mode: 0o600 });
  const prompt = `${task.prompt}\n\nWork only inside this directory. Public files:\n${Object.keys(files(root)).join('\n') || '(empty)'}`;
  const args = claudeCodeArgs(model.model, options.maxTurns, configPath);
  record({ type: 'claude-code', binary: claudeCodeBinary(), args });
  notify(`claude code · ${model.model}`);

  const start = performance.now();
  const { stdout, stderr, code } = await runCli(args, prompt, root, options.timeout * 1000, signal);
  trial.modelMs = performance.now() - start;
  // Recovered whatever the outcome: the trace is the only record of what the model did, and a
  // censored or failed trial is exactly when it is worth having.
  trial.trace = readTrace(tracePath);
  trial.toolMs = trial.trace.reduce((sum, e) => sum + e.ms, 0);
  trial.modelMs = Math.max(0, trial.modelMs - trial.toolMs);
  if (signal.aborted) return;

  const parsed = resultMessage(stdout);
  // Keep the raw streams: a silent or malformed exit is only diagnosable if they are recorded.
  record({ type: 'claude-code-result', code, subtype: parsed?.subtype, turns: parsed?.num_turns, usage: parsed?.usage, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) });
  // `??` would stop at an empty string, which is exactly what a silent CLI failure produces.
  // Only the result text and stderr are classified: matching over the whole session transcript
  // turns any mention of a limit inside the model's own reasoning into a fake rate_limited.
  const detail = [parsed?.result, stderr.trim()].find(t => t) ?? '';

  trial.turns = parsed?.num_turns ?? 0;
  if (parsed?.usage) {
    const u = parsed.usage;
    trial.tokens = {
      input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
    };
  }
  if (!parsed || typeof parsed.result !== 'string') {
    // Hitting --max-turns mid-tool-use exits 1 with no result message. That is the turn budget
    // running out, which censors the outcome exactly like a deadline; calling it a harness error
    // makes a tight budget look like Forseti broke.
    if (parsed && (parsed.stop_reason === 'tool_use' || (parsed.num_turns ?? 0) >= options.maxTurns)) {
      trial.status = 'budget';
      trial.error = `Turn budget of ${options.maxTurns} exhausted after ${parsed.num_turns ?? 0} turns while still calling tools; outcome is censored, not a correctness failure.`;
      return;
    }
    // No parseable result is a harness failure, not a wrong answer. Counting it as a model
    // failure would report 0% correctness for something the model never got to attempt.
    trial.status = detail ? classify(detail, code) : 'harness_error';
    trial.error = safeError(detail || `Claude Code exited ${code} with no result message. stdout started: ${stdout.slice(0, 300) || '(empty)'}`);
    return;
  }
  if (parsed.is_error || code !== 0) {
    trial.error = safeError(detail);
    trial.status = classify(`${detail} ${parsed.subtype ?? ''}`, code);
    return;
  }
  trial.answer = parsed.result;
}
