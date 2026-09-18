import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
export const check = (id, dimension, passed, evidence) => ({id, dimension, passed: Boolean(passed), evidence});
export function fixture(id) {
  const dir = new URL(`../fixtures/${id}/`, import.meta.url);
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(new URL(name, dir), 'utf8')]));
}
export function preserved(files, originals, editable = []) {
  const added = Object.keys(files).filter(p => !Object.hasOwn(originals, p));
  const missing = Object.keys(originals).filter(p => !Object.hasOwn(files, p));
  const changed = Object.entries(originals).filter(([p,v]) => Object.hasOwn(files, p) && !editable.includes(p) && files[p] !== v).map(([p]) => p);
  return check('edit-scope', 'instructions', !added.length && !missing.length && !changed.length,
    `actual=${bounded({added,missing,changed})}; expected=no added/deleted files or changes outside ${bounded(editable)}`);
}
export function parseAnswer(answer) { try { return JSON.parse(answer); } catch { return null; } }
/**
 * Correctness must be graded on the content the model produced, not on its packaging.
 * Wrapping the answer in prose or a code fence is an instruction failure (see jsonOnly),
 * not a wrong answer, so the two are scored separately instead of one hiding the other.
 */
export function answerJson(answer) {
  const direct = parseAnswer(answer);
  if (direct !== null) return direct;
  const text = String(answer ?? '');
  for (const fenced of [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1].trim()).reverse()) {
    const value = parseAnswer(fenced);
    if (value !== null) return value;
  }
  const start = text.indexOf('{');
  for (let end = text.lastIndexOf('}'); start >= 0 && end > start; end = text.lastIndexOf('}', end - 1)) {
    const value = parseAnswer(text.slice(start, end + 1));
    if (value !== null) return value;
  }
  return null;
}
/**
 * One fence wrapped around the whole answer is the client rendering it, not the model padding it.
 * Across 81 recorded trials not one model returned bare JSON, so requiring bare text graded the
 * chat client and every model lost the same constant. What does vary is whether anything comes
 * *with* the answer — a preamble, a trailing note — and that is what the instruction actually asks
 * about. Anything outside the fence is still a failure.
 */
const LONE_FENCE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/i;
export function unfenced(answer) {
  const text = String(answer ?? '').trim();
  const fenced = text.match(LONE_FENCE);
  return fenced ? fenced[1].trim() : text;
}
export function jsonOnly(answer) {
  const only = parseAnswer(unfenced(answer)) !== null;
  const recovered = !only && answerJson(answer) !== null;
  return check('json-only', 'instructions', only,
    `answer is the JSON and nothing else=${only}; JSON recovered from surrounding text=${recovered}; length=${String(answer ?? '').length}`);
}
export function bounded(value, limit = 600) {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length <= limit ? text : text.slice(0, limit) + '…[truncated]';
}
export function equal(id, got, expected, dimension = 'correctness') {
  return check(id, dimension, isDeepStrictEqual(got, expected), `actual=${bounded(got)}; expected=${bounded(expected)}`);
}
export async function observe(python, source) {
  const r = await python(source);
  const diagnostic = `exit=${r.code}; timedOut=${r.timedOut}; stdout=${bounded(r.stdout)}; stderr=${bounded(r.stderr)}`;
  if (r.code !== 0 || r.timedOut) return {ok:false, value:null, diagnostic};
  try { return {ok:true, value:JSON.parse(r.stdout), diagnostic}; }
  catch (error) { return {ok:false, value:null, diagnostic:diagnostic + `; invalid JSON: ${bounded(error.message)}`}; }
}
// Only public driver code and explicit inputs enter the candidate interpreter.
export function observeCases(python, input) {
  return observe(python, `import runpy
runpy.run_path('observe.py')['observe'](${JSON.stringify(JSON.stringify(input))})`);
}
// Parse text only: the candidate module is never imported by this probe.
export async function pythonHygiene(python, files, path) {
  const r = await observe(python, `import sys
# Drop the runner's first (workspace) import path before loading analysis modules.
sys.path = [entry for entry in sys.path if entry not in ('', '.', sys.path[0])]
import ast, json
source=json.loads(${JSON.stringify(JSON.stringify(files[path] ?? null))})
result={'parsed':False,'imports':[],'dynamic':[],'stdlib':sorted(sys.stdlib_module_names)}
try:
 tree=ast.parse(source)
 result['parsed']=True
 for node in ast.walk(tree):
  if isinstance(node, ast.Import):
   result['imports'].extend({'module':a.name.split('.')[0],'level':0,'line':node.lineno} for a in node.names)
  elif isinstance(node, ast.ImportFrom):
   result['imports'].append({'module':(node.module or '').split('.')[0],'level':node.level,'line':node.lineno})
   if node.module == 'builtins':
    result['dynamic'].extend({'name':a.name,'line':node.lineno} for a in node.names if a.name in ('eval','exec','*'))
  if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in ('eval','exec'):
   result['dynamic'].append({'name':node.id,'line':node.lineno})
  elif isinstance(node, ast.Attribute) and node.attr in ('eval','exec'):
   result['dynamic'].append({'name':node.attr,'line':node.lineno})
except (SyntaxError, TypeError, ValueError) as error:
 result['error']={'type':type(error).__name__,'message':str(error),'line':getattr(error,'lineno',None)}
print(json.dumps(result))`);
  const parsed = r.ok && r.value?.parsed === true;
  const imports = r.value?.imports ?? [];
  const stdlib = new Set(r.value?.stdlib ?? []);
  const disallowed = imports.filter(item => item.level !== 0 || !stdlib.has(item.module));
  const dynamic = r.value?.dynamic ?? [];
  return [
    check('python-ast-parses','hygiene',parsed, `${path}: actual=${bounded(r.value?.error ?? {parsed:r.value?.parsed})}; expected=valid Python AST; ${r.ok ? '' : r.diagnostic}`),
    check('python-stdlib-imports','hygiene',parsed && disallowed.length === 0, `${path}: imports=${bounded(imports)}; disallowed=${bounded(disallowed)}; expected=only absolute stdlib imports in the edited module`),
    check('python-no-eval-exec','hygiene',parsed && dynamic.length === 0, `${path}: named dynamic-evaluation references=${bounded(dynamic)}; expected=[]`)
  ];
}
export function toolChecks(trace = [], requiredReads = [], publicCheck = null, readOnly = false, {lane = 'tools', control = false, agent = 'pi'} = {}) {
  // This rubric names the Forseti tool harness. Another agent's trace cannot satisfy it.
  if (lane === 'prompt' || control || agent !== 'pi') return [];
  const checks = [];
  if (readOnly) checks.push(equal('no-write-tool', trace.filter(e => e.tool === 'write_file').length, 0, 'tools'));
  if (requiredReads.length) {
    const firstWrite = trace.findIndex(e => e.tool === 'write_file');
    const earlier = firstWrite < 0 ? trace : trace.slice(0, firstWrite);
    const missing = requiredReads.filter(path => !earlier.some(e => e.tool === 'read_file' && e.ok && e.args.path === path));
    checks.push(check('read-before-write', 'tools', !missing.length, `firstWriteIndex=${firstWrite}; missing prior successful reads=${bounded(missing)}; expected=[]`));
  }
  if (publicCheck) {
    const command = `import runpy; runpy.run_path('${publicCheck}', run_name='__main__')`;
    const attempts = trace.filter(e => e.tool === 'python' && typeof e.args.source === 'string' && e.args.source.trim() === command).map(e => {
      const result = parseAnswer(e.output);
      return {ok:e.ok,code:result?.code,timedOut:result?.timedOut};
    });
    checks.push(check('public-python-check', 'tools', attempts.some(e => e.ok && e.code === 0 && e.timedOut === false), `exact-command attempts=${bounded(attempts)}; expected=at least one {ok:true,code:0,timedOut:false}`));
  }
  return checks;
}
