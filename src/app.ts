import { existsSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { authInfo, catalogModels, defaultAuth } from './auth.ts';
import { CLAUDE_CODE_MODELS } from './claudecode.ts';
import { loadConfig, loadSuite, saveConfig } from './config.ts';
import { atomicJson, inside, localDir, put, slug } from './files.ts';
import { listLocalModels, LOCAL, localUrl, shortName } from './local.ts';
import { comparisonReport } from './report.ts';
import { listRuns, readRun, runBenchmark } from './runner.ts';
import type { AuthInfo, Config, ModelConfig, Progress, Run, RunOptions, Suite } from './types.ts';

export type CatalogEntry = { provider: string; id: string; name: string; auth: AuthInfo };
export class App {
  root: string;
  config!: Config;
  suite!: Suite;
  runs: Run[] = [];
  catalog: CatalogEntry[] = [];
  /** Models the local server listed. Undefined until it has been asked, which never happens on startup. */
  localModels?: CatalogEntry[];
  constructor(root: string) { this.root = root; }
  async refresh(): Promise<void> {
    this.config = loadConfig(this.root);
    this.suite = loadSuite(this.root, this.config.suite).suite;
    this.runs = listRuns(this.root);
    const auth = new Map<string, AuthInfo>();
    this.catalog = catalogModels.getModels().map(m => {
      if (!auth.has(m.provider)) auth.set(m.provider, authInfo({ provider: m.provider, auth: defaultAuth(m.provider) }));
      return { provider: m.provider, id: m.id, name: m.name, auth: auth.get(m.provider)! };
    }).sort((a, b) => Number(b.auth.ready) - Number(a.auth.ready) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    this.catalog.unshift(
      ...(this.localModels ?? []),
      ...CLAUDE_CODE_MODELS.map(id => ({ provider: 'claude-code', id, name: `Claude ${id} · via Claude Code`, auth: authInfo({ provider: 'claude-code', auth: 'cli' as const }) })),
      ...['reference', 'baseline'].map(id => ({ provider: 'control', id, name: `${id} · synthetic control`, auth: authInfo({ provider: 'control', auth: 'none' as const }) })),
    );
  }
  authFor(model: ModelConfig): AuthInfo { return authInfo(model, this.config.local.url); }
  /** Saves the server address and forgets the last listing, which belonged to the old address. */
  setLocalUrl(url: string): void {
    const value = localUrl(url);
    const before = this.config.local.url;
    this.config.local.url = value;
    try { this.persist(); } catch (e) { this.config.local.url = before; throw e; }
    this.localModels = undefined;
    this.catalog = this.catalog.filter(c => c.provider !== LOCAL);
  }
  /** Asks the configured server what it serves. The one request made outside a run. */
  async probeLocal(): Promise<CatalogEntry[]> {
    const url = this.config.local.url;
    if (!url) throw new Error('No local server address. Set one on Settings.');
    const auth = authInfo({ provider: LOCAL, auth: 'none' }, url);
    this.localModels = (await listLocalModels(url)).map(m => ({ provider: LOCAL, id: m.id, name: `${m.name} · local`, auth }));
    this.catalog = [...this.localModels, ...this.catalog.filter(c => c.provider !== LOCAL)];
    return this.localModels;
  }
  persist(): void { saveConfig(this.root, this.config); }
  async run(options: RunOptions, progress: (p: Progress) => void, signal: AbortSignal): Promise<Run> {
    // The run appears in the list as soon as it has a manifest, and is kept current as trials
    // land, so cancelling or crashing leaves visible evidence instead of nothing.
    let seen = -1;
    try {
      return await runBenchmark(this.root, this.config, options, p => {
        if (p.completed !== seen) { seen = p.completed; this.track(p.runId); }
        progress(p);
      }, signal);
    } finally { this.runs = listRuns(this.root); }
  }
  private track(id: string): void {
    const run = readRun(this.root, id);
    if (!run) return;
    const index = this.runs.findIndex(r => r.id === id);
    if (index < 0) this.runs.unshift(run); else this.runs[index] = run;
  }
  compare(ids: string[]): string {
    const selected = ids.map(id => {
      const run = this.runs.find(r => r.id === id);
      if (!run) throw new Error(`Unknown run: ${id}`);
      return run;
    });
    return comparisonReport(selected);
  }
  exportReport(ids: string[]): string {
    const dir = localDir(this.root, 'reports');
    const name = `comparison-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    writeFileSync(inside(dir, name), this.compare(ids), { flag: 'wx', mode: 0o600 });
    return relative(this.root, inside(dir, name));
  }
  addModel(provider: string, model: string, auth: ModelConfig['auth']): void {
    const item = this.catalog.find(m => m.provider === provider && m.id === model);
    if (!item) throw new Error('Unknown provider/model. Select one from the pinned Pi catalog.');
    const id = slug(`${provider}-${provider === LOCAL ? shortName(model) : model}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80).replace(/-$/, ''));
    if (this.config.models.some(m => m.id === id)) throw new Error('Model already added');
    const native = catalogModels.getModel(provider, model);
    const levels = native ? getSupportedThinkingLevels(native) : ['off' as const];
    this.config.models.push({ id, label: item.name, provider, model, auth: provider === 'control' || provider === LOCAL ? 'none' : auth, enabled: true, thinking: levels.includes('off') ? 'off' : levels[0] });
    try { this.persist(); } catch (e) { this.config.models.pop(); throw e; }
  }
  addTest(id: string, prompt: string, expectedJson: string): void {
    slug(id);
    if (!prompt.trim() || prompt.length > 32_000) throw new Error('Provide a nonempty prompt (max 32,000 characters)');
    if (this.suite.tasks.some(t => t.id === id)) throw new Error('Test already exists (restore it if removed)');
    const expected = JSON.parse(expectedJson);
    const { dir } = loadSuite(this.root, this.config.suite);
    const fixture = `fixtures/${id}`, grader = `private/${id}.mjs`;
    if (existsSync(inside(dir, fixture)) || existsSync(inside(dir, grader))) throw new Error('Test paths already exist; refusing to overwrite');
    localDir(dir, fixture);
    put(dir, `${fixture}/context.txt`, 'Answer the task prompt. No file edits are required.\n');
    put(dir, grader, `// Trusted, hidden exact-JSON verifier. No framework dependency.\nconst expected = ${JSON.stringify(expected)};\nexport const reference = { answer: JSON.stringify(expected) };\nexport const baseline = { answer: ${JSON.stringify(expected === null ? '{}' : 'null')} };\nexport async function grade({answer}) {\n let actual, valid = true;\n try { actual = JSON.parse(answer); } catch { valid = false; }\n const same = (a,b) => {\n  if (a === b) return true;\n  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;\n  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b,k) && same(a[k],b[k]));\n };\n return [\n  { id:'exact-answer', dimension:'correctness', passed:valid && same(actual,expected), evidence:valid ? 'Compared parsed JSON against hidden expected value.' : 'Response was not JSON.' },\n  { id:'json-only', dimension:'instructions', passed:valid, evidence:'Response must be only valid JSON.' }\n ];\n}\n`);
    const updated = structuredClone(this.suite);
    updated.tasks.push({ id, title: id.replaceAll('-', ' '), tags: ['custom', 'json'], dimensions: ['correctness', 'instructions'], capabilities: ['exactness'], prompt: `${prompt}\nReturn only JSON.`, fixture, grader });
    atomicJson(this.root, this.config.suite, updated);
    this.suite = updated;
  }
}
