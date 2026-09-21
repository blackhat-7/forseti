/**
 * Forseti's four task tools, served to the Claude Code CLI over stdio MCP.
 *
 * The Pi lane hands a model `list_files`, `read_file`, `write_file` and `python` directly. The
 * Claude Code CLI brings its own file tools and no way to run code, so the two lanes measured
 * different capabilities: a local model could run `check_public.py` and iterate, a Claude model
 * could not. Supplying the identical tools here is what makes a cross-lane score comparable.
 *
 * Run as a script by the CLI itself: `node src/mcpserver.ts <workDir> <traceFile>`. Every call is
 * appended to the trace file so the runner can recover it, because the CLI reports no tool detail.
 */
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { clean, files, put, readText } from './files.ts';
import { runPython } from './sandbox.ts';
import type { ToolEvent } from './types.ts';

/** Identical names, descriptions and schemas to `taskTools` in adapter.ts, so neither lane is told more. */
export const MCP_TOOLS = [
  { name: 'list_files', description: 'List all public workspace files.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'read_file', description: 'Read a UTF-8 file relative to the task workspace (max 32,000 returned characters).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write complete UTF-8 contents to a relative file (128 KiB max).', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'python', description: 'Run Python source in the task directory with stdlib only. Network, child processes and access outside the task are denied. Max 5 seconds.', inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
] as const;
/** What the CLI must be told to allow: MCP tools are addressed by server-qualified name. */
export const MCP_SERVER = 'forseti';
export const MCP_ALLOWED = MCP_TOOLS.map(t => `mcp__${MCP_SERVER}__${t.name}`).join(',');

export async function callTool(work: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'list_files') return Object.keys(files(work)).join('\n');
  if (name === 'read_file') return readText(work, String(args.path));
  if (name === 'write_file') { put(work, String(args.path), String(args.content)); files(work); return 'Written'; }
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
