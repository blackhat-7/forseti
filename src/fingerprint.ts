import ts from 'typescript';
import { dirname, join, normalize } from 'node:path';
import { hash } from './files.ts';
import type { Task } from './types.ts';

/**
 * What decides whether two tries are comparable. A fingerprint covers what a try runs and is graded
 * by, compared as it runs: comments, formatting and type annotations are removed first, so a
 * reworded comment never strands a recorded try and a changed line of logic always does.
 *
 * It is computed the same way from the live workspace and from the copy of code and suite every run
 * saves, so improving it never strands an old run: bump SCHEME and every cached value is redone.
 */
export const SCHEME = 1;
const CODE = /\.(ts|mjs|js)$/;
/** Source as it executes: comments, layout and types removed. Anything else is compared byte for byte. */
export function canonical(path: string, text: string): string {
  if (!CODE.test(path)) return text;
  return ts.transpileModule(text, { fileName: path, compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
/** `from './x'`, `import('./x')` and `new URL('x', import.meta.url)`: every file a module reaches. */
const REACH = /(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{0,2}\/?[\w./-]+)['"]/g;
/**
 * src/trial.ts and everything it reaches, found by following its imports. A new file on that path is
 * covered the moment something imports it, and a file only the screens use never is.
 */
export function trialClosure(src: Record<string, string>): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path) || !(path in src)) return;
    seen.add(path);
    for (const [, target] of src[path]!.matchAll(REACH)) if (!target!.startsWith('node:') && /\.\w+$/.test(target!)) visit(normalize(join(dirname(path), target!)));
  };
  visit('trial.ts');
  return [...seen].sort();
}
/** Packages the try path imports by name, at the versions the lockfile installs. */
function packages(code: string[], lock: string): Record<string, string> {
  const installed = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages ?? {};
  const names = new Set(code.flatMap(text => [...text.matchAll(/from\s+['"]((?:@[\w-]+\/)?[\w.-]+)/g)].map(m => m[1]!)).filter(n => !n.startsWith('node:') && !n.startsWith('.')));
  return Object.fromEntries([...names].sort().map(name => [name, installed[`node_modules/${name}`]?.version ?? 'missing']));
}
/** The code that runs and grades a try. `src` maps paths under src/ to their text. */
export function harnessFingerprint(src: Record<string, string>, lock: string): string {
  const closure = trialClosure(src);
  // A run saved before trial.ts existed has no try path to follow; it can only match itself.
  if (!closure.length) return hash({ scheme: SCHEME, legacy: src, lock });
  const code = closure.map(path => canonical(path, src[path]!));
  return hash({ scheme: SCHEME, code: Object.fromEntries(closure.map((path, i) => [path, code[i]])), packages: packages(code, lock) });
}
/**
 * A task as the model meets it and as it is graded: its definition without the labels the model
 * never sees, its fixture byte for byte (the model reads comments too), its own grader and the
 * helpers every grader imports. `suite` maps paths under the suite folder to their text.
 */
export function taskFingerprint(task: Task, suite: Record<string, string>): string {
  const { title, tier, capabilities, ...shown } = task;
  const prefix = `${task.fixture.replace(/\/$/, '')}/`;
  const fixture = Object.fromEntries(Object.entries(suite).filter(([p]) => p.startsWith(prefix)).map(([p, text]) => [p.slice(prefix.length), text]).sort(([a], [b]) => a.localeCompare(b)));
  const graders = [task.grader, 'private/helpers.mjs'].filter(p => p in suite).map(p => [p, canonical(p, suite[p]!)]);
  return hash({ scheme: SCHEME, task: shown, fixture, graders });
}
