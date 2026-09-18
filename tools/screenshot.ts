// Renders the real dashboard to docs/tui-home.svg so the README screenshot stays truthful.
// Usage: npm run screenshot [view]   (view: home | models | tests | runs)
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import { App } from '../src/app.ts';
import { Dashboard } from '../src/tui.ts';
import { inside, localDir } from '../src/files.ts';

const COLUMNS = 132, FONT = 14, CELL = 8.4, LINE = 20, PAD = 18, CHROME = 34;
const FALLBACK_BG = 'rgb(12,20,35)', FALLBACK_FG = 'rgb(220,230,241)';

type Span = { text: string; column: number; fg: string; bg: string; bold: boolean };

/** Parses the small SGR subset the dashboard emits: truecolor fg/bg, bold on/off and resets. */
function spans(line: string): Span[] {
  const out: Span[] = [];
  let fg = FALLBACK_FG, bg = FALLBACK_BG, bold = false, column = 0, index = 0;
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const text = line.slice(index, match.index);
    if (text) { out.push({ text, column, fg, bg, bold }); column += visibleWidth(text); }
    index = match.index + match[0].length;
    const codes = match[1]!.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) { fg = FALLBACK_FG; bg = FALLBACK_BG; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = FALLBACK_FG;
      else if (code === 49) bg = FALLBACK_BG;
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const colour = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (code === 38) fg = colour; else bg = colour;
        i += 4;
      }
    }
  }
  const tail = line.slice(index);
  if (tail) out.push({ text: tail, column, fg, bg, bold });
  return out;
}
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const app = new App(root);
await app.refresh();
const dashboard = new Dashboard(app);
const view = process.argv[2] ?? 'home';
const tab = { home: '1', models: '2', tests: '3', runs: '4' }[view];
if (!tab) throw new Error('View must be home, models, tests or runs');
dashboard.handleInput(tab);

const rows = dashboard.render(COLUMNS).map(spans);
const width = COLUMNS * CELL + PAD * 2;
const height = rows.length * LINE + PAD * 2 + CHROME;
const body: string[] = [];
rows.forEach((row, y) => {
  const top = CHROME + PAD + y * LINE;
  for (const span of row) {
    const x = PAD + span.column * CELL, w = visibleWidth(span.text) * CELL;
    if (span.bg !== FALLBACK_BG) body.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${LINE}" fill="${span.bg}"/>`);
    if (span.text.trim()) body.push(`<text x="${x.toFixed(1)}" y="${(top + FONT).toFixed(1)}" fill="${span.fg}"${span.bold ? ' font-weight="600"' : ''}>${xml(span.text)}</text>`);
  }
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="Forseti terminal UI, ${view} view">
<rect width="100%" height="100%" rx="10" fill="#070d18"/>
<rect x="${PAD}" y="${CHROME}" width="${(COLUMNS * CELL).toFixed(1)}" height="${(rows.length * LINE).toFixed(1)}" fill="${FALLBACK_BG}"/>
<circle cx="24" cy="18" r="6" fill="#ff5f57"/><circle cx="44" cy="18" r="6" fill="#febc2e"/><circle cx="64" cy="18" r="6" fill="#28c840"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}" xml:space="preserve">
${body.join('\n')}
</g>
</svg>
`;
const name = `tui-${view}.svg`;
writeFileSync(inside(localDir(root, 'docs'), name), svg);
console.log(`Wrote docs/${name} (${COLUMNS} columns x ${rows.length} rows)`);
