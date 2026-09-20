import { createModels, createProvider, type Model, type Models } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { clean } from './files.ts';

/** Provider ID for the user's own OpenAI-compatible server, such as llama-server. */
export const LOCAL = 'local';
export type LocalModel = { id: string; name: string };

/** Normalises a base address: `http://host:port`, with a trailing slash or `/v1` dropped. */
export function localUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!trimmed) return '';
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('Use a full address such as http://127.0.0.1:8080'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || trimmed.length > 200) {
    throw new Error('The local server address is http(s)://host[:port], with no credentials, query or fragment');
  }
  return trimmed;
}
/** llama-server reports a model by its file path; the file name is what a person recognises. */
export function shortName(id: string): string {
  let text = id;
  try { text = decodeURIComponent(id); } catch { /* Not percent-encoded. */ }
  return text.split('/').pop()!.replace(/\.gguf$/i, '') || id;
}
/** The one request made outside a run: `GET /v1/models`, with nothing sent but the URL. */
export async function listLocalModels(url: string): Promise<LocalModel[]> {
  let response: Response;
  try { response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) }); }
  catch (e) {
    const cause = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
    throw new Error(`No answer from ${url}: ${clean(String(cause)).slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} to /v1/models`);
  const body = await response.json().catch(() => undefined) as { data?: { id?: unknown }[] } | undefined;
  const ids = [...new Set((body?.data ?? []).map(m => m?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500))];
  if (!ids.length) throw new Error(`${url} lists no models`);
  return ids.map(id => ({ id, name: shortName(id) }));
}
/**
 * A pi Models collection holding just this server. Keyless by design: the server is the user's
 * own, so `resolve` reports it configured and hands the OpenAI client a placeholder key, which
 * llama-server ignores. The compat flags pin the plain chat-completions dialect llama.cpp speaks.
 *
 * Thinking is `off` or `high` and nothing in between: it becomes `chat_template_kwargs.enable_thinking`,
 * which llama.cpp, vLLM and SGLang honour and Ollama and LM Studio ignore. A hybrid model such as
 * Qwen3 thinks by default, and with the setting unsent it spent a whole 4096-token turn thinking
 * while the manifest said thinking was off.
 */
export function localModels(url: string, ids: string[]): Models {
  if (!url) throw new Error('No local server address. Set one on Settings.');
  const baseUrl = `${url}/v1`;
  const models = createModels();
  models.setProvider(createProvider<'openai-completions'>({
    id: LOCAL, name: 'Local server', baseUrl,
    auth: { apiKey: { name: 'Local server (no key)', resolve: async () => ({ auth: { apiKey: 'none' }, source: 'none' }) } },
    models: ids.map((id): Model<'openai-completions'> => ({
      id, name: shortName(id), api: 'openai-completions', provider: LOCAL, baseUrl, reasoning: true, input: ['text'],
      thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8192,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', thinkingFormat: 'qwen-chat-template' },
    })),
    api: openAICompletionsApi(),
  }));
  return models;
}
