import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { plain } from './kit.ts';

/** One line of a try's conversation: something the model said, or a tool it called and how that went. */
export type Line = { say?: string; tool?: string; target?: string; failed?: boolean };
/** The file, command or pattern a tool call was about, in a few words. */
export function target(input: Record<string, unknown> = {}): string {
  const value = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.code ?? input.source ?? '';
  const text = plain(String(value)).trim();
  return /^[\w./-]+$/.test(text) && text.includes('/') ? text.split('/').at(-1)! : text.split('\n')[0]!;
}
/** The Pi agent logs each reply and each tool call to the trial's events.jsonl as they happen. */
export function piChat(events: { type?: string; text?: string; event?: { tool?: string; args?: Record<string, unknown>; ok?: boolean } }[]): Line[] {
  return events.flatMap((e): Line[] => e.type === 'assistant' && e.text?.trim() ? [{ say: e.text.trim() }]
    : e.type === 'tool' && e.event?.tool ? [{ tool: e.event.tool, target: target(e.event.args), failed: e.event.ok === false }] : []);
}
/**
 * Claude Code writes its own session transcript, keyed by the working folder, while it works; the
 * trial's own log has only its start and end. Read-only, and only to show the owner their run.
 */
export function claudeChat(work: string): Line[] {
  const folder = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude'), 'projects', work.replace(/[^A-Za-z0-9]/g, '-'));
  try {
    const file = readdirSync(folder).filter(f => f.endsWith('.jsonl')).map(f => join(folder, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!file) return [];
    const lines: Line[] = [];
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      let entry: { type?: string; message?: { content?: unknown } };
      try { entry = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content as { type: string; text?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean }[]) {
        if (entry.type === 'assistant' && block.type === 'text' && block.text?.trim()) lines.push({ say: block.text.trim() });
        else if (entry.type === 'assistant' && block.type === 'tool_use') lines.push({ tool: (block.name ?? '').replace(/^mcp__\w+__/, ''), target: target(block.input) });
        else if (block.type === 'tool_result' && block.is_error) { const last = lines.findLast(l => l.tool); if (last) last.failed = true; }
      }
    }
    return lines;
  } catch { return []; }
}
