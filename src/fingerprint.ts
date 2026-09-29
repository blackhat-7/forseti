import ts from 'typescript';
import { dirname, join, normalize } from 'node:path';
import { hash } from './files.ts';
import type { Task } from './types.ts';

/**
 * What decides whether two tries are comparable, in two parts. The submission fingerprint covers
 * what the model met and the code that ran it; the grading fingerprint covers how its submission
 * is judged. A changed submission needs the model again; a changed grading only needs the saved
 * submission graded again. Both are compared as the code runs: comments, formatting and type
 * annotations are removed first, so a reworded comment never strands a recorded try and a changed
 * line of logic always does.
 *
 * It is computed the same way from the live workspace and from the copy of code and suite every run
 * saves, so improving it never strands an old run: bump SCHEME and every cached value is redone.
 */
export const SCHEME = 2;
const CODE = /\.(ts|mjs|js)$/;
/** Source as it executes: comments, layout and types removed. Anything else is compared byte for byte. */
export function canonical(path: string, text: string): string {
  if (!CODE.test(path)) return text;
  return ts.transpileModule(text, { fileName: path, compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
}
/** `from './x'`, `import('./x')` and `new URL('x', import.meta.url)`: every file a module reaches. */
const REACH = /(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{0,2}\/?[\w./-]+)['"]/g;
/** `entry` and every file it reaches, found by following imports, not going past `stop`. */
function closure(src: Record<string, string>, entry: string, stop?: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path) || path === stop || !(path in src)) return;
    seen.add(path);
    for (const [, target] of src[path]!.matchAll(REACH)) if (!target!.startsWith('node:') && /\.\w+$/.test(target!)) visit(normalize(join(dirname(path), target!)));
  };
  visit(entry);
  return [...seen].sort();
}
/**
 * src/trial.ts and everything it reaches, except by way of the grading code. A new file on that
 * path is covered the moment something imports it, and a file only the screens use never is.
 */
export const trialClosure = (src: Record<string, string>) => closure(src, 'trial.ts', 'grade.ts');
/** src/grade.ts and everything it reaches. A file both paths reach counts for both. */
export const gradeClosure = (src: Record<string, string>) => closure(src, 'grade.ts');
/** Packages the try path imports by name, at the versions the lockfile installs. */
function packages(code: string[], lock: string): Record<string, string> {
  const installed = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages ?? {};
  const names = new Set(code.flatMap(text => [...text.matchAll(/from\s+['"]((?:@[\w-]+\/)?[\w.-]+)/g)].map(m => m[1]!)).filter(n => !n.startsWith('node:') && !n.startsWith('.')));
  return Object.fromEntries([...names].sort().map(name => [name, installed[`node_modules/${name}`]?.version ?? 'missing']));
}
function codeFingerprint(paths: string[], src: Record<string, string>, lock: string): string {
  const code = paths.map(path => canonical(path, src[path]!));
  return hash({ scheme: SCHEME, code: Object.fromEntries(paths.map((path, i) => [path, code[i]])), packages: packages(code, lock) });
}
/** The code that runs a try. `src` maps paths under src/ to their text. */
export function harnessFingerprint(src: Record<string, string>, lock: string): string {
  // A run saved before trial.ts existed has no try path to follow; it can only match itself.
  if (!('trial.ts' in src)) return hash({ scheme: SCHEME, legacy: src, lock });
  return codeFingerprint(trialClosure(src), src, lock);
}
/**
 * The code that grades a try. A run saved before grade.ts existed graded inside the try path, so
 * its grading is only as comparable as its whole harness; fingerprint.lock may declare it equal.
 */
export function gradingFingerprint(src: Record<string, string>, lock: string): string {
  return 'grade.ts' in src ? codeFingerprint(gradeClosure(src), src, lock) : harnessFingerprint(src, lock);
}
/**
 * A task as the model meets it: its definition without the labels it never sees and without how it
 * is graded, and its fixture byte for byte (the model reads comments too). `suite` maps paths under
 * the suite folder to their text.
 */
export function taskFingerprint(task: Task, suite: Record<string, string>): string {
  const { title, tier, capabilities, dimensions, grader, ...shown } = task;
  const prefix = `${task.fixture.replace(/\/$/, '')}/`;
  const fixture = Object.fromEntries(Object.entries(suite).filter(([p]) => p.startsWith(prefix)).map(([p, text]) => [p.slice(prefix.length), text]).sort(([a], [b]) => a.localeCompare(b)));
  // A simulated estate is what the model meets on every command, so its code counts as the task.
  const world = task.world ? { world: Object.fromEntries(closure(suite, task.world).map(p => [p, canonical(p, suite[p]!)])) } : {};
  return hash({ scheme: SCHEME, task: shown, fixture, ...world });
}
/** How a task is graded: what it checks, its own grader and the helpers every grader imports. */
export function taskGrading(task: Task, suite: Record<string, string>): string {
  const graders = [task.grader, 'private/helpers.mjs'].filter(p => p in suite).map(p => [p, canonical(p, suite[p]!)]);
  return hash({ scheme: SCHEME, dimensions: task.dimensions, graders });
}
