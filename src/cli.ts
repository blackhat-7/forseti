#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { App } from './app.ts';
import { authInfo, defaultAuth, ENV_KEYS } from './auth.ts';
import { DEFAULT_OPTIONS } from './config.ts';
import { clean } from './files.ts';
import { LOCAL } from './local.ts';
import { checkSandbox, pythonExecutable } from './sandbox.ts';
import type { ModelConfig, RunOptions } from './types.ts';

const help = `FORSETI  ·  evidence-first LLM benchmarks

  npm start                          Open the TUI (no provider calls on startup)
  npm run demo                       Run synthetic reference + flawed controls
  npm run doctor                     Check isolation and authentication metadata

  npm start -- models list
  npm start -- models catalog [search]
  npm start -- models add provider/model --auth pi|env|cli
  npm start -- models add claude-code/sonnet     Your Claude plan, via Claude Code
  npm start -- local http://127.0.0.1:8080       Point at llama-server, Ollama, LM Studio…
  npm start -- models add local/MODEL_ID         …then add one of the models it lists
  npm start -- models enable|disable|remove ID
  npm start -- tests list
  npm start -- tests add ID --prompt 'Task' --expect '{"answer":42}'
  npm start -- tests enable|disable|remove|restore ID
  npm start -- run [--models ID,ID] [--tests ID,ID] [--repeat 2] [--seed 42]
                  [--lane tools|prompt] [--timeout 180] [--turns 12] [--tokens 4096]
                  [--allow-metered] [--no-cache]
  npm start -- runs
  npm start -- compare RUN_ID [RUN_ID ...]

All paths are relative to this workspace. Secrets never go in forseti.json.
An API key is never chosen for you: --auth env is required to use one. Candidates
and the design reviewer are listed with their credential before anything runs.
Models/tests default to enabled selections. Run preflight refuses metered or
unknown billing unless explicitly allowed. Controls are synthetic, not LLMs.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, models: { type: 'string' }, tests: { type: 'string' }, repeat: { type: 'string' }, seed: { type: 'string' },
    lane: { type: 'string' }, timeout: { type: 'string' }, turns: { type: 'string' }, tokens: { type: 'string' },
    'allow-metered': { type: 'boolean' }, 'no-cache': { type: 'boolean' }, auth: { type: 'string' }, prompt: { type: 'string' }, expect: { type: 'string' },
  } });
  if (values.help) { console.log(help); return; }
  const root = realpathSync(process.cwd());
  if (root !== realpathSync(fileURLToPath(new URL('..', import.meta.url)))) throw new Error('Run Forseti from its workspace root. No files written.');
  const app = new App(root);
  await app.refresh();
  const [command, action, id] = positionals;
  if (!command || command === 'tui') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log(help); return; }
    // Prevent Pi TUI diagnostic logs from being redirected outside this workspace.
    delete process.env.PI_TUI_WRITE_LOG;
    const { launchTui } = await import('./tui.ts');
    await launchTui(app); return;
  }
  if (command === 'doctor') {
    await checkSandbox(root);
    console.log(`✓ Sandbox enforced: trial-only writes/reads, no network or child processes\n✓ Python: ${pythonExecutable()}\n✓ ${app.suite.tasks.length} independent tasks; manifest + fixtures validated\n✓ Pi 0.85.1 libraries; no personal extensions or contexts loaded`);
    for (const model of app.config.models) {
      const a = authInfo(model, app.config.local.url);
      console.log(clean(`${a.ready ? '✓' : '!'} ${model.id}: ${a.mode} · ${a.billing} · ${a.note}`));
    }
    return;
  }
  if (command === 'models') {
    if (!action || action === 'list') for (const m of app.config.models) { const a = authInfo(m, app.config.local.url); console.log(clean(`${m.enabled ? '●' : '○'} ${m.id}  ${m.provider}/${m.model}  ${m.auth} · ${a.billing} · ${a.ready ? 'ready' : a.note}`)); }
    else if (action === 'catalog') {
      // The local server is asked here, and only here, what it serves.
      if (app.config.local.url) { try { await app.probeLocal(); } catch (e) { console.log(clean(`! local: ${(e as Error).message}`)); } }
      for (const m of app.catalog.filter(m => !id || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(id.toLowerCase()))) console.log(clean(`${m.provider}/${m.id}  ${m.auth.ready ? 'ready' : 'not configured'} · ${m.auth.billing}`));
    } else if (action === 'add') {
      if (!id?.includes('/')) throw new Error('Use provider/model');
      const provider = id.slice(0, id.indexOf('/')), model = id.slice(id.indexOf('/') + 1);
      const auth = values.auth ?? defaultAuth(provider);
      if (!['pi', 'env', 'none', 'cli'].includes(auth)) throw new Error('auth must be pi, env or cli');
      // An API key is never selected for you. If nothing else is configured, say so explicitly.
      if (auth === 'env' && !values.auth) throw new Error(`No subscription credential for ${provider}. Log in with Pi, or pass --auth env to use ${ENV_KEYS[provider] ?? 'a provider API key'} and be billed per token.`);
      if (provider === LOCAL) await app.probeLocal();
      app.addModel(provider, model, auth as ModelConfig['auth']); console.log(`Added ${app.config.models.at(-1)!.id}`);
    } else {
      const model = app.config.models.find(m => m.id === id);
      if (!model) throw new Error('Unknown model ID');
      if (action === 'remove') app.config.models = app.config.models.filter(m => m.id !== id);
      else if (action === 'enable' || action === 'disable') model.enabled = action === 'enable';
      else throw new Error('Unknown models action');
      app.persist(); console.log(`${action}: ${id}. Saved results are unchanged.`);
    }
    return;
  }
  if (command === 'tests') {
    if (!action || action === 'list') for (const t of app.suite.tasks) console.log(clean(`${app.config.removedTests.includes(t.id) ? '−' : app.config.disabledTests.includes(t.id) ? '○' : '●'} ${t.id}  ${t.title}`));
    else if (action === 'add') {
      if (!id || !values.prompt || values.expect === undefined) throw new Error('tests add ID --prompt ... --expect JSON');
      app.addTest(id, values.prompt, values.expect); console.log(`Added ${id}. Hidden verifier written; suite remains independent.`);
    } else {
      if (!app.suite.tasks.some(t => t.id === id)) throw new Error('Unknown test ID');
      if (action === 'remove') app.config.removedTests = [...new Set([...app.config.removedTests, id])];
      else if (action === 'restore') app.config.removedTests = app.config.removedTests.filter(t => t !== id);
      else if (action === 'disable') app.config.disabledTests = [...new Set([...app.config.disabledTests, id])];
      else if (action === 'enable') { app.config.disabledTests = app.config.disabledTests.filter(t => t !== id); app.config.removedTests = app.config.removedTests.filter(t => t !== id); }
      else throw new Error('Unknown tests action');
      app.persist(); console.log(`${action}: ${id}. Fixtures/results retained; restore is reversible.`);
    }
    return;
  }
  if (command === 'local') {
    if (action) app.setLocalUrl(action);
    if (!app.config.local.url) { console.log('No local server set. Usage: npm start -- local http://host:port'); return; }
    const found = await app.probeLocal();
    console.log(`${app.config.local.url}: ${found.length} model${found.length === 1 ? '' : 's'}`);
    for (const m of found) console.log(clean(`  local/${m.id}  ${m.name}`));
    return;
  }
  if (command === 'runs') { for (const r of app.runs) console.log(`${r.id}  ${r.status}  ${r.trials.length}/${r.planned}  ${r.options.lane}`); return; }
  if (command === 'compare') {
    const ids = positionals.slice(1);
    if (!ids.length) throw new Error('Select run IDs from `npm start -- runs`');
    console.log(app.compare(ids)); console.log(`Saved ${app.exportReport(ids)}`); return;
  }
  if (command === 'run') {
    const options: RunOptions = { ...DEFAULT_OPTIONS, models: values.models?.split(','), tests: values.tests?.split(','),
      repeat: values.repeat === undefined ? DEFAULT_OPTIONS.repeat : Number(values.repeat), seed: values.seed === undefined ? DEFAULT_OPTIONS.seed : Number(values.seed),
      lane: (values.lane ?? DEFAULT_OPTIONS.lane) as RunOptions['lane'], timeout: values.timeout === undefined ? DEFAULT_OPTIONS.timeout : Number(values.timeout),
      maxTurns: values.turns === undefined ? DEFAULT_OPTIONS.maxTurns : Number(values.turns), maxTokens: values.tokens === undefined ? DEFAULT_OPTIONS.maxTokens : Number(values.tokens), allowMetered: values['allow-metered'] ?? false, cache: !values['no-cache'] };
    const controller = new AbortController();
    const cancel = () => { if (!controller.signal.aborted) console.error('Cancelling; saving partial results…'); controller.abort(); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await app.run(options, p => console.log(clean(`[${p.completed}/${p.total}] ${p.model} · ${p.task} · ${p.phase}`)), controller.signal);
      console.log(`\nSaved runs/${result.id}/run.json\nReport: ${app.exportReport([result.id])}`);
      if (result.trials.some(t => ['harness_error', 'provider_error', 'auth_error', 'rate_limited', 'timeout', 'budget'].includes(t.status))) process.exitCode = 2;
      if (result.status === 'cancelled') process.exitCode = 130;
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    return;
  }
  throw new Error(`Unknown command: ${command}\n${help}`);
}
main().catch(error => { console.error(`Forseti: ${clean(error.message)}`); process.exitCode = 1; });
