import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { CLAUDE_CODE_MODELS } from './claudecode.ts';
import { atomicJson, files, inside, readText, slug } from './files.ts';
import type { Capability, Config, Dimension, JudgeConfig, ModelConfig, RunOptions, Suite } from './types.ts';

export const CAPABILITIES: Capability[] = ['evidence', 'restraint', 'exactness', 'scope', 'safety'];
export const DIMENSIONS: Dimension[] = ['correctness', 'instructions', 'quality', 'tools', 'design'];

// 180s, not 90s: on the Claude Code harness a real 24-trial run had two trials finish at 84-86s
// and one censored at the 90s deadline. A budget that censors outcomes buys nothing, and a fast
// trial never spends the headroom.
export const DEFAULT_OPTIONS: RunOptions = { repeat: 2, seed: 42, lane: 'tools', timeout: 180, maxTurns: 12, maxTokens: 4096, allowMetered: false, cache: true };
/**
 * Off by default: the reviewer spends real quota, and a judged score is not reproducible the way
 * the rest of the suite is. The default reviewer is deliberately not an Anthropic model, because
 * the Claude Code candidates would otherwise be graded by their own family.
 */
export const DEFAULT_JUDGE: JudgeConfig = { enabled: false, provider: 'openai-codex', model: 'gpt-5.5', auth: 'pi', thinking: 'off', repeat: 1 };
export const DEFAULT_CONFIG: Config = {
  schema: 1, suite: 'suites/personal/suite.json', disabledTests: [], removedTests: [], judge: DEFAULT_JUDGE,
  models: [
    { id: 'control-reference', label: 'Reference · synthetic', provider: 'control', model: 'reference', auth: 'none', enabled: true, thinking: 'off' },
    { id: 'control-baseline', label: 'Flawed baseline · synthetic', provider: 'control', model: 'baseline', auth: 'none', enabled: true, thinking: 'off' },
  ],
};
function text(value: unknown, name: string, max = 32_000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
}
function unique(ids: string[], name: string) {
  ids.forEach(slug);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${name}`);
}
export function validateConfig(root: string, value: Config): Config {
  if (!value || value.schema !== 1 || !Array.isArray(value.models) || !Array.isArray(value.disabledTests) || !Array.isArray(value.removedTests)) throw new Error('Invalid forseti.json schema');
  text(value.suite, 'suite path'); inside(root, value.suite);
  for (const m of value.models) {
    slug(m.id); text(m.label, 'model label', 200); text(m.provider, 'provider', 100); text(m.model, 'model ID', 200);
    if (!['pi', 'env', 'none', 'cli'].includes(m.auth) || typeof m.enabled !== 'boolean' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(m.thinking)) throw new Error(`Invalid model settings: ${m.id}`);
    if (m.provider === 'control' && (!['reference', 'baseline'].includes(m.model) || m.auth !== 'none')) throw new Error('Unknown control');
    if (m.provider === 'claude-code' && (m.auth !== 'cli' || !CLAUDE_CODE_MODELS.includes(m.model as never))) throw new Error(`Claude Code models use auth "cli" and one of: ${CLAUDE_CODE_MODELS.join(', ')}`);
    if ((m.auth === 'cli') !== (m.provider === 'claude-code')) throw new Error('auth "cli" is only for the claude-code provider');
    if (m.provider !== 'control' && m.auth === 'none') throw new Error('Live providers require explicit Pi or environment auth');
  }
  unique(value.models.map(m => m.id), 'model IDs'); unique(value.disabledTests, 'disabled tests'); unique(value.removedTests, 'removed tests');
  validateJudge(value.judge);
  return value;
}
export function validateJudge(j: JudgeConfig): void {
  if (!j || typeof j.enabled !== 'boolean' || !['pi', 'env', 'cli'].includes(j.auth)) throw new Error('Invalid judge settings');
  text(j.provider, 'judge provider', 100); text(j.model, 'judge model', 200);
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(j.thinking)) throw new Error('Invalid judge thinking level');
  if (!Number.isInteger(j.repeat) || j.repeat < 1 || j.repeat > 5) throw new Error('Judge repeat must be 1–5');
  // A synthetic control has no model behind it, so it cannot review anything.
  if (j.provider === 'control') throw new Error('The reviewer must be a real model, not a synthetic control');
  if (j.provider === 'claude-code' && (j.auth !== 'cli' || !CLAUDE_CODE_MODELS.includes(j.model as never))) throw new Error(`A Claude Code reviewer uses auth "cli" and one of: ${CLAUDE_CODE_MODELS.join(', ')}`);
  if ((j.auth === 'cli') !== (j.provider === 'claude-code')) throw new Error('Reviewer auth "cli" is only for the claude-code provider');
}
export function loadConfig(root: string): Config {
  const path = inside(root, 'forseti.json');
  if (!existsSync(path)) atomicJson(root, 'forseti.json', DEFAULT_CONFIG);
  const stored = JSON.parse(readText(root, 'forseti.json')) as Config;
  stored.judge ??= DEFAULT_JUDGE;
  return validateConfig(root, stored);
}
export function saveConfig(root: string, config: Config): void {
  atomicJson(root, 'forseti.json', validateConfig(root, config));
}
export function loadSuite(root: string, path: string): { suite: Suite; dir: string; contents: Record<string, string> } {
  const file = inside(root, path);
  const dir = dirname(file);
  const suite: Suite = JSON.parse(readText(root, relative(root, file)));
  if (suite?.schema !== 1 || !Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error('Suite must contain at least one task');
  slug(suite.id); text(suite.title, 'suite title', 200);
  unique(suite.tasks.map(t => t.id), 'task IDs');
  for (const task of suite.tasks) {
    text(task.title, 'task title', 200); text(task.prompt, 'task prompt');
    if (!Array.isArray(task.tags) || task.tags.some(t => typeof t !== 'string')) throw new Error(`Invalid tags: ${task.id}`);
    if (!Array.isArray(task.capabilities) || !task.capabilities.length || new Set(task.capabilities).size !== task.capabilities.length || task.capabilities.some(c => !CAPABILITIES.includes(c))) throw new Error(`Declare unique capabilities for ${task.id} from: ${CAPABILITIES.join(', ')}`);
    if (!Array.isArray(task.dimensions) || !task.dimensions.length || new Set(task.dimensions).size !== task.dimensions.length || task.dimensions.some(d => !DIMENSIONS.includes(d))) throw new Error(`Declare unique rubric dimensions for ${task.id}`);
    if (typeof task.fixture !== 'string' || !task.fixture.startsWith('fixtures/') || typeof task.grader !== 'string' || !task.grader.startsWith('private/') || !task.grader.endsWith('.mjs')) throw new Error('Use fixtures/ public paths and private/*.mjs graders');
    files(inside(dir, task.fixture));
    readText(dir, task.grader);
  }
  return { suite, dir, contents: files(dir) };
}
export function validateOptions(o: RunOptions): void {
  const inRange = (v: number, low: number, high: number) => Number.isInteger(v) && v >= low && v <= high;
  if (!inRange(o.repeat, 1, 20) || !inRange(o.seed, 0, 0xffffffff) || !inRange(o.timeout, 1, 1800) || !inRange(o.maxTurns, 1, 100) || !inRange(o.maxTokens, 128, 65536) || !['tools', 'prompt'].includes(o.lane) || typeof o.allowMetered !== 'boolean' || typeof o.cache !== 'boolean') throw new Error('Invalid run options: repeat 1–20, timeout 1–1800s, turns 1–100, tokens 128–65536, seed uint32');
  if (o.models) unique(o.models, 'selected models');
  if (o.tests) unique(o.tests, 'selected tests');
}
export function selectedModels(config: Config, ids?: string[]): ModelConfig[] {
  if (ids?.some(id => !config.models.some(m => m.id === id))) throw new Error('Unknown model selection');
  const selected = config.models.filter(m => ids ? ids.includes(m.id) : m.enabled);
  if (!selected.length) throw new Error('Enable at least one model');
  return selected;
}
