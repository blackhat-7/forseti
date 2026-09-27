import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { claudeCodeBinary } from './claudecode.ts';
import { LOCAL, localModels } from './local.ts';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import type { AuthInfo, ModelConfig } from './types.ts';

export const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', 'kimi-coding': 'KIMI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY',
  nvidia: 'NVIDIA_API_KEY', together: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY',
  minimax: 'MINIMAX_API_KEY', zai: 'ZAI_API_KEY', opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY', 'github-copilot': 'COPILOT_GITHUB_TOKEN',
};
export const catalogModels = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });

function piCredential(provider: string): Credential | undefined {
  let data: Record<string, Credential>;
  try { data = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Cannot read Pi auth.json; fix the file in Pi. No credentials were copied.');
  }
  return data[provider];
}
export function validateCredential(c: Credential | undefined): void {
  if (!c || !['oauth', 'api_key'].includes(c.type)) throw new Error('No supported Pi credential. Log in with Pi or choose environment authentication.');
  if (c.type === 'oauth' && (!c.access || !Number.isFinite(c.expires) || c.expires <= Date.now() + 5 * 60_000)) {
    throw new Error('Pi OAuth is expired or near expiry. Refresh/login in Pi, then rerun. External token rotation is disabled.');
  }
  if (c.type === 'api_key' && (!c.key || c.key.startsWith('!') || Object.values(c.env ?? {}).some(v => typeof v === 'string' && v.startsWith('!')))) {
    throw new Error('Command-based or missing credentials are not supported. Use a literal/environment API key.');
  }
}
/** `local` is the configured server address; it only matters for the local provider. */
export function authInfo(config: Pick<ModelConfig, 'provider' | 'auth'>, local = ''): AuthInfo {
  if (config.provider === 'control') return { mode: 'synthetic control', billing: 'control', ready: true, note: 'Scripted fixture validation; not a model result.' };
  if (config.provider === LOCAL) {
    return local
      ? { mode: 'local server', billing: 'local', ready: true, note: `OpenAI-compatible server at ${local}. No credential is sent and nothing is billed.` }
      : { mode: 'local server', billing: 'local', ready: false, note: 'No local server address. Set one on Settings.' };
  }
  if (config.provider === 'claude-code') {
    // The first-party client authenticates itself. Forseti reads no Claude credential and
    // strips API-key variables from the child, so this lane cannot fall back to metered billing.
    try { claudeCodeBinary(); } catch (e) { return { mode: 'Claude Code CLI', billing: 'subscription', ready: false, note: (e as Error).message }; }
    return { mode: 'Claude Code CLI (your login)', billing: 'subscription', ready: true, note: 'Runs the first-party client under your Claude plan. Draws on plan usage limits; no API key is used.' };
  }
  try {
    const c = config.auth === 'pi' ? piCredential(config.provider) : undefined;
    if (config.auth === 'pi') validateCredential(c);
    else if (config.auth !== 'env' || !ENV_KEYS[config.provider] || !process.env[ENV_KEYS[config.provider]]) {
      return { mode: 'environment API key', billing: 'metered', ready: false, note: `Set ${ENV_KEYS[config.provider] ?? 'a supported provider key'} or select Pi authentication.` };
    }
    const oauth = c?.type === 'oauth';
    const subscription = (oauth && ['openai-codex', 'github-copilot', 'xai'].includes(config.provider)) || ['kimi-coding', 'opencode-go'].includes(config.provider);
    const billing = subscription ? 'subscription' : oauth && !['anthropic', 'openrouter'].includes(config.provider) ? 'unknown' : 'metered';
    return {
      mode: config.auth === 'pi' ? `Pi ${oauth ? 'OAuth' : 'API key'} (read-only)` : 'environment API key',
      billing, ready: true,
      note: config.provider === 'anthropic' && oauth ? 'Claude OAuth in third-party harnesses uses metered extra usage, not plan quota.'
        : subscription ? 'Consumes plan quota. No per-token charge inferred; provider limits still apply.'
          : billing === 'unknown' ? 'Billing is unknown. Explicit metered consent required.' : 'API/credit usage. Displayed USD is a catalog estimate, not an invoice.',
    };
  } catch (e) {
    return { mode: config.auth === 'pi' ? 'Pi credentials (read-only)' : 'environment API key', billing: 'unknown', ready: false, note: (e as Error).message };
  }
}
export function modelsFor(config: ModelConfig, local = '') {
  if (config.provider === LOCAL) return localModels(local, [config.model]);
  // No refresh callback is ever invoked: token rotation would mutate the external login
  // even if the refreshed token were kept in memory rather than written to auth.json.
  const credentials: CredentialStore = {
    async read(provider) {
      if (config.auth !== 'pi' || provider !== config.provider) return undefined;
      const credential = piCredential(provider);
      validateCredential(credential);
      return credential;
    },
    async list() { return []; },
    async modify() { throw new Error('External OAuth refresh is disabled. Refresh/login in Pi and rerun.'); },
    async delete() { throw new Error('External credentials are read-only.'); },
  };
  return builtinModels({
    credentials,
    authContext: {
      env: async name => process.env[name],
      fileExists: async () => false,
    },
  });
}
export function defaultAuth(provider: string): ModelConfig['auth'] {
  if (provider === 'control') return 'none';
  if (provider === 'claude-code') return 'cli';
  if (provider === LOCAL) return 'none';
  try { if (piCredential(provider)) return 'pi'; } catch { /* Show a diagnostic when selected. */ }
  return 'env';
}
