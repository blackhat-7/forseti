/**
 * The sandboxed Python tool, served to the Claude Code CLI over stdio MCP.
 *
 * Each lane keeps its own way of reading and writing files: `Read`/`Write`/`Edit`/`Glob`/`Grep`
 * here, `read_file`/`write_file`/`list_files` in the Pi lane. Those are one capability in two
 * dialects, and swapping one for the other would only measure which tools a client is tuned for.
 *
 * Running code is not a dialect difference. The Pi lane can execute arbitrary Python and so
 * verify its own work against `check_public.py`; without this the CLI lane could not run anything,
 * and its scores and its stall count were not comparable. `Bash` is not the answer: it is
 * unsandboxed and networked. This is the Pi lane's exact interpreter, under the same sandbox.
 *
 * Run as a script by the CLI itself: `node src/mcpserver.ts <workDir> <traceFile>`. Every call is
 * appended to the trace file so the runner can recover it, because the CLI reports no tool detail.
 */
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { clean } from './files.ts';
import { runPython } from './sandbox.ts';
import type { ToolEvent } from './types.ts';

/** Name, description and schema copied from `taskTools` in adapter.ts, so neither lane is told more. */
export const MCP_TOOLS = [
  { name: 'python', description: 'Run Python source in the task directory with stdlib only. Network, child processes and access outside the task are denied. Max 5 seconds.', inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
] as const;
/** What the CLI must be told to allow: MCP tools are addressed by server-qualified name. */
export const MCP_SERVER = 'forseti';
export const MCP_ALLOWED = MCP_TOOLS.map(t => `mcp__${MCP_SERVER}__${t.name}`).join(',');

export async function callTool(work: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'python') return JSON.stringify(await runPython(work, String(args.source)));
  throw new Error(`Unknown tool: ${name}`);
}
/**
 * Serves one JSON-RPC line at a time. Returns the reply, or undefined for a notification.
 * The 64-call budget mirrors the Pi lane's, so neither lane can out-spend the other on tools.
 */
export function createHandler(work: string, onEvent: (event: ToolEvent) => void, limit = 64) {
  let calls = 0;
  return async (message: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) => {
    const reply = (result: unknown) => (message.id === undefined ? undefined : { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: MCP_SERVER, version: '1' } });
    if (message.method === 'tools/list') return reply({ tools: MCP_TOOLS });
    if (message.method !== 'tools/call') return reply({});
    const name = String(message.params?.name ?? '');
    const args = message.params?.arguments ?? {};
    const event: ToolEvent = { tool: name, args, ok: false, ms: 0, output: '' };
    const started = performance.now();
    try {
      if (++calls > limit) throw new Error(`Tool-call budget exhausted (${limit})`);
      event.output = (await callTool(work, name, args)).slice(0, 32_000);
      event.ok = true;
      return reply({ content: [{ type: 'text', text: event.output }] });
    } catch (e) {
      event.output = clean(e instanceof Error ? e.message : String(e)).replaceAll(work, '.').slice(0, 32_000);
      return reply({ content: [{ type: 'text', text: event.output }], isError: true });
    } finally {
      event.ms = performance.now() - started;
      onEvent(event);
    }
  };
}
/** Newline-delimited JSON-RPC on stdin/stdout, which is what `--mcp-config` spawns. */
export function serve(work: string, onEvent: (event: ToolEvent) => void, input = process.stdin, output = process.stdout): void {
  const handle = createHandler(work, onEvent);
  let buffer = '';
  let queue: Promise<unknown> = Promise.resolve();
  input.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { continue; }
      // Sequential: two concurrent python runs in one trial directory would race on files.
      queue = queue.then(async () => {
        const reply = await handle(message);
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      });
    }
  });
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [work, trace] = process.argv.slice(2);
  if (!work || !trace) throw new Error('Usage: mcpserver.ts <workDir> <traceFile>');
  serve(work, event => appendFileSync(trace, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
}
