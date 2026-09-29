// Renders the real dashboard to docs/tui-<view>.svg so the README screenshots stay truthful.
// Usage: npm run screenshot [view]   (view: home | live | models | tests | runs)
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import { Dashboard } from '../src/tui.ts';
import { inside, localDir } from '../src/files.ts';
import { COLUMNS, terminalSvg } from './terminal-svg.ts';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const app = new App(root);
await app.refresh();
const dashboard = new Dashboard(app);
const view = process.argv[2] ?? 'home';
const tab = { home: '1', live: '2', models: '3', tests: '4', runs: '5' }[view];
if (!tab) throw new Error('View must be home, live, models, tests or runs');
dashboard.handleInput(tab);
const lines = dashboard.render(COLUMNS);
const name = `tui-${view}.svg`;
writeFileSync(inside(localDir(root, 'docs'), name), terminalSvg(lines, `Forseti terminal UI, ${view} view`));
console.log(`Wrote docs/${name} (${COLUMNS} columns x ${lines.length} rows)`);
process.exit(0);
