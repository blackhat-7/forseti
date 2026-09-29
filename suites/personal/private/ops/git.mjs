/**
 * `git` (and `gh`) for the checkout the operator is standing in, modelled the way git keeps it:
 * commits with parents, local branches, remote-tracking refs, HEAD, an index and a stash. Each
 * branch's files are real snapshots, so switching branches rewrites the working tree and a pushed
 * branch never moves `origin/main`.
 *
 *   makeGit(ctx, { branch, remote, initial, log: [{ sha, author, email, t, subject, body?, diff }] })
 *   `initial` maps each workspace path to its text at the tip of `branch`. `log` is that branch's
 *   history, newest first; `t` is virtual seconds (negative = before the session) and `diff` the
 *   commit's unified diff, `diff --git` headers included. Older trees are rebuilt by reversing
 *   those diffs. The returned function has a `gh` property: the GitHub CLI for the same repository.
 *
 * `ctx.repository.commits` is the history array itself: Forseti writes the real repository's
 * hashes into those objects after the world is built, so every hash here is read live from them.
 */
import { createHash } from 'node:crypto';
import { lines, unifiedDiff } from './shell.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const gitDate = (d) => `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCFullYear()} +0000`;
const short = (c) => c.sha.slice(0, 7);
const blob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
/** Real git commands this model does not cover: they fail as git does when given arguments it rejects. */
const OTHER = ['am', 'archive', 'bisect', 'bundle', 'citool', 'difftool', 'format-patch', 'fsck', 'gc', 'gui', 'instaweb', 'maintenance', 'mergetool', 'notes', 'prune', 'range-diff', 'request-pull', 'send-email', 'show-branch', 'sparse-checkout', 'submodule', 'whatchanged', 'worktree', 'switch', 'mv', 'rm', 'apply', 'init', 'clone', 'annotate', 'count-objects', 'cat-file', 'for-each-ref', 'show-ref', 'symbolic-ref', 'update-ref', 'rev-list', 'name-rev', 'merge-base', 'verify-commit'];

export function makeGit(ctx, { branch: main = 'main', remote = 'git@github.com:quillmart/infra.git', initial, log }) {
  const history = log.map(c => ({ ...c }));
  const user = () => ({ name: config['user.name'] ?? 'On-call Engineer', email: config['user.email'] ?? `${ctx.shell?.env.USER ?? 'oncall'}@quillmart.com` });
  ctx.repository = { branch: main, remote, commits: history, at: (t) => ctx.at(t).toISOString(), user };
  const repoName = remote.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1');
  const config = {};
  /** Commits made during the session, newest first. Each has `parent` (a commit) and `files`. */
  const made = [];
  const parentOf = (c) => (c.parent !== undefined ? c.parent : history[history.indexOf(c) + 1] ?? null);
  const heads = new Map([[main, history[0]]]);
  const remotes = new Map([[main, history[0]]]);
  const upstream = new Map([[main, main]]);
  const tags = new Map();
  let head = { branch: main };
  const reflog = [{ c: history[0], what: `clone: from ${remote}` }];
  const stash = [];
  const snapshots = new Map([[history[0], { ...initial }]]);
  /** The tree a commit records. History before the tip is the tip with newer diffs reversed. */
  const tree = (c) => {
    if (!c) return {};
    if (c.files) return c.files;
    if (snapshots.has(c)) return snapshots.get(c);
    const newer = history[history.indexOf(c) - 1];
    const files = { ...tree(newer) };
    patch(files, newer.diff, true);
    snapshots.set(c, files);
    return files;
  };
  const current = () => (head.branch ? heads.get(head.branch) : head.commit);
  let index = { ...initial };
  const work = () => Object.fromEntries(ctx.shell.fs.list().map(p => [p, ctx.shell.fs.read(p)]));
  const writeTree = (from, to) => {
    for (const p of Object.keys(from)) if (!(p in to)) { try { ctx.shell.fs.remove(p); } catch { /* already gone */ } }
    for (const [p, text] of Object.entries(to)) if (from[p] !== text) ctx.shell.fs.write(p, text);
  };
  /** Resolves a revision: HEAD~n, HEAD^, branch, origin/branch, tag, @{u}, or a hash prefix. */
  const resolve = (spec) => {
    if (!spec) return null;
    const m = /^(.*?)((?:~\d*|\^+)*)$/.exec(spec);
    let base = m[1], c;
    if (base === 'HEAD' || base === '@' || base === '') c = current();
    else if (base === '@{u}' || base === '@{upstream}') c = head.branch && upstream.has(head.branch) ? remotes.get(upstream.get(head.branch)) : null;
    else if (heads.has(base)) c = heads.get(base);
    else if (base.startsWith('origin/') && remotes.has(base.slice(7))) c = remotes.get(base.slice(7));
    else if (base === 'origin/HEAD' || base === 'origin') c = remotes.get(main);
    else if (base.startsWith('refs/heads/')) c = heads.get(base.slice(11));
    else if (tags.has(base)) c = tags.get(base);
    else if (/^[0-9a-f]{4,40}$/.test(base)) c = [...made, ...history].find(x => x.sha.startsWith(base));
    if (!c) return null;
    for (const step of m[2].match(/~\d*|\^/g) ?? []) {
      const n = step === '^' ? 1 : Number(step.slice(1) || 1);
      for (let k = 0; k < n && c; k++) c = parentOf(c);
    }
    return c ?? null;
  };
  const ancestry = (c) => { const out = []; for (let x = c; x; x = parentOf(x)) out.push(x); return out; };
  const isAncestor = (a, b) => ancestry(b).includes(a);
  const decorate = (c) => {
    const labels = [];
    if (head.branch && heads.get(head.branch) === c) labels.push(`HEAD -> ${head.branch}`);
    else if (!head.branch && head.commit === c) labels.push('HEAD');
    for (const [name, t] of tags) if (t === c) labels.push(`tag: ${name}`);
    for (const [name, r] of remotes) if (r === c) { labels.push(`origin/${name}`); if (name === main) labels.push('origin/HEAD'); }
    for (const [name, h] of heads) if (h === c && name !== head.branch) labels.push(name);
    return labels.length ? ` (${labels.join(', ')})` : '';
  };
  const header = (c, oneline, withDecor = true) => (oneline
    ? [`${short(c)}${withDecor ? decorate(c) : ''} ${c.subject}`]
    : [`commit ${c.sha}${withDecor ? decorate(c) : ''}`, `Author: ${c.author} <${c.email}>`, `Date:   ${gitDate(ctx.at(c.t))}`, '', `    ${c.subject}`, ...(c.body ? ['', ...lines(c.body).map(l => (l ? `    ${l}` : ''))] : []), '']);
  const pretty = (c, spec) => spec.replace(/%H/g, c.sha).replace(/%h/g, short(c)).replace(/%s/g, c.subject).replace(/%b/g, c.body ?? '').replace(/%an/g, c.author).replace(/%ae/g, c.email)
    .replace(/%ad|%cd/g, gitDate(ctx.at(c.t))).replace(/%ai|%ci/g, ctx.at(c.t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000')).replace(/%ar|%cr/g, relative(ctx.t - c.t)).replace(/%d/g, decorate(c)).replace(/%D/g, decorate(c).slice(2, -1)).replace(/%P/g, parentOf(c)?.sha ?? '').replace(/%n/g, '\n');
  /** A commit's own diff: recorded for history, computed for commits made here. */
  const diffOf = (c) => (c.diff !== undefined ? c.diff : diffTrees(tree(parentOf(c)), tree(c)).join('\n'));
  const change = (subject, body, files, parent = current(), extra = {}) => {
    const u = user(), t = ctx.t;
    const sha = createHash('sha1').update(JSON.stringify([parent?.sha, subject, body, t, Object.entries(files).sort()])).digest('hex');
    const c = { sha, author: u.name, email: u.email, t, subject, body, files: { ...files }, parent, ...extra };
    made.unshift(c);
    return c;
  };
  const move = (c, what) => {
    if (head.branch) heads.set(head.branch, c); else head.commit = c;
    reflog.unshift({ c, what });
  };
  const changes = () => {
    const now = work(), base = tree(current());
    const staged = Object.keys({ ...base, ...index }).filter(p => base[p] !== index[p]).sort();
    const unstaged = Object.keys(index).filter(p => now[p] !== index[p]).sort();
    const untracked = Object.keys(now).filter(p => !(p in index)).sort();
    return { now, base, staged, unstaged, untracked };
  };
  const inPaths = (paths) => (p) => !paths.length || paths.some(q => p === q || p.startsWith(`${q.replace(/\/$/, '')}/`) || q === '.');
  const statOf = (diff) => {
    const files = [];
    let cur = null;
    for (const l of diff) {
      const m = /^diff --git a\/(\S+) b\//.exec(l);
      if (m) { cur = { path: m[1], add: 0, del: 0 }; files.push(cur); continue; }
      if (!cur || l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) cur.add++; else if (l.startsWith('-')) cur.del++;
    }
    if (!files.length) return [];
    const width = Math.max(...files.map(f => f.path.length));
    const out = files.map(f => ` ${f.path.padEnd(width)} | ${String(f.add + f.del).padStart(3)} ${'+'.repeat(Math.min(f.add, 40))}${'-'.repeat(Math.min(f.del, 40))}`);
    return [...out, summary(files)];
  };
  const summary = (files) => {
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0);
    return ` ${files.length} file${files.length === 1 ? '' : 's'} changed${add ? `, ${add} insertion${add === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}`;
  };
  const tracking = (b) => {
    const up = upstream.get(b), local = heads.get(b), theirs = up ? remotes.get(up) : null;
    if (!up) return null;
    if (!theirs) return { up, gone: true };
    const ahead = ancestry(local).filter(x => !ancestry(theirs).includes(x)).length;
    const behind = ancestry(theirs).filter(x => !ancestry(local).includes(x)).length;
    return { up, ahead, behind };
  };
  const trackingLine = (b) => {
    const t = tracking(b);
    if (!t) return null;
    if (t.gone) return `Your branch is based on 'origin/${t.up}', but the upstream is gone.\n  (use "git branch --unset-upstream" to fixup)`;
    if (t.ahead && t.behind) return `Your branch and 'origin/${t.up}' have diverged,\nand have ${t.ahead} and ${t.behind} different commits each, respectively.`;
    if (t.ahead) return `Your branch is ahead of 'origin/${t.up}' by ${t.ahead} commit${t.ahead === 1 ? '' : 's'}.\n  (use "git push" to publish your local commits)`;
    if (t.behind) return `Your branch is behind 'origin/${t.up}' by ${t.behind} commit${t.behind === 1 ? '' : 's'}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)`;
    return `Your branch is up to date with 'origin/${t.up}'.`;
  };
  /** Moves HEAD and the working tree to another commit, keeping local edits that do not collide. */
  const checkoutTree = (target) => {
    const { now, base } = changes();
    const to = tree(target);
    const dirty = Object.keys({ ...base, ...now }).filter(p => (p in index || p in base) && now[p] !== base[p]);
    const clash = dirty.filter(p => to[p] !== base[p]);
    if (clash.length) return { err: ['error: Your local changes to the following files would be overwritten by checkout:', ...clash.map(p => `\t${p}`), 'Please commit your changes or stash them before you switch branches.', 'Aborting'], code: 1 };
    writeTree(Object.fromEntries(Object.entries(base).filter(([p]) => !dirty.includes(p))), Object.fromEntries(Object.entries(to).filter(([p]) => !dirty.includes(p))));
    index = { ...to, ...Object.fromEntries(dirty.filter(p => p in index).map(p => [p, index[p]])) };
    carried = dirty.filter(p => p in to || p in base).sort().map(p => `${p in now ? 'M' : 'D'}\t${p}`);
    return null;
  };
  const pushed = [];
  /** Local edits a checkout carried over, which git lists before it says it switched. */
  let carried = [];

  function git(argv) {
    const args = [...argv];
    while (['-C', '-c', '--no-pager', '--git-dir', '--work-tree', '-P'].includes(args[0])) { if (['--no-pager', '-P'].includes(args[0])) args.shift(); else args.splice(0, 2); }
    const [sub, ...rest] = args;
    ctx.wait(1);
    const flag = (...names) => names.some(n => rest.includes(n));
    const value = (name) => { const k = rest.findIndex(a => a === name || a.startsWith(`${name}=`)); return k < 0 ? undefined : rest[k].includes('=') ? rest[k].slice(rest[k].indexOf('=') + 1) : rest[k + 1]; };
    const dashdash = rest.indexOf('--');
    const paths = dashdash >= 0 ? rest.slice(dashdash + 1) : [];
    const operands = (dashdash >= 0 ? rest.slice(0, dashdash) : rest).filter((a, k, all) => !a.startsWith('-') && !['-n', '-m', '-F', '--format', '--pretty', '-b', '-c', '-B', '-C', '--source', '-u', '--set-upstream-to'].includes(all[k - 1]));
    switch (sub) {
      case undefined: case 'help': case '--help': return { out: ['usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]', '           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]', '           [-p | --paginate | -P | --no-pager] [--no-replace-objects] [--bare]', '           [--git-dir=<path>] [--work-tree=<path>] [--namespace=<name>]', '           <command> [<args>]'], code: sub ? 0 : 1 };
      case 'version': case '--version': case '-v': return { out: ['git version 2.39.5'] };
      case 'log': case 'shortlog': {
        let n = Infinity, fmt = null;
        for (let k = 0; k < rest.length; k++) {
          const a = rest[k];
          if (/^-\d+$/.test(a)) n = Number(a.slice(1));
          else if (a === '-n') n = Number(rest[++k]);
          else if (/^--max-count=/.test(a)) n = Number(a.split('=')[1]);
          else if (a === '--oneline') fmt = 'oneline';
          else if (/^--(pretty|format)=/.test(a)) fmt = a.slice(a.indexOf('=') + 1).replace(/^(format|tformat):/, '');
          else if (a === '--format' || a === '--pretty') fmt = (rest[++k] ?? '').replace(/^(format|tformat):/, '');
        }
        if (fmt === 'oneline' || fmt === 'short' || fmt === 'medium' || fmt === 'full') fmt = fmt === 'oneline' ? 'oneline' : null;
        let list;
        const range = operands.find(a => a.includes('..'));
        if (flag('--all')) list = [...new Set([...heads.values(), ...remotes.values(), ...tags.values()].flatMap(ancestry))].sort((a, b) => b.t - a.t);
        else if (range) {
          const [a, b] = range.split(/\.\.\.?/);
          const from = resolve(a || 'HEAD'), to = resolve(b || 'HEAD');
          if (!from || !to) return { err: [`fatal: ambiguous argument '${range}': unknown revision or path not in the working tree.`, "Use '--' to separate paths from revisions, like this:", "'git <command> [<revision>...] -- [<file>...]'"], code: 128 };
          const exclude = new Set(ancestry(from));
          list = ancestry(to).filter(x => !exclude.has(x));
        } else {
          const revs = operands.filter(a => resolve(a));
          const unknown = operands.filter(a => !resolve(a) && dashdash < 0);
          const onDisk = unknown.filter(a => a in index || Object.keys(index).some(p => p.startsWith(`${a.replace(/\/$/, '')}/`)));
          const bad = unknown.filter(a => !onDisk.includes(a));
          if (bad.length) return { err: [`fatal: ambiguous argument '${bad[0]}': unknown revision or path not in the working tree.`, "Use '--' to separate paths from revisions, like this:", "'git <command> [<revision>...] -- [<file>...]'"], code: 128 };
          paths.push(...onDisk);
          list = ancestry(revs.length ? resolve(revs[0]) : current());
        }
        if (paths.length) list = list.filter(c => lines(diffOf(c)).some(l => { const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(l); return m && inPaths(paths)(m[2]); }));
        if (sub === 'shortlog') {
          const by = new Map();
          for (const c of list) by.set(c.author, (by.get(c.author) ?? 0) + 1);
          const rows = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
          return { out: flag('-s', '-sn', '-ns') ? rows.map(([a, k]) => `${String(k).padStart(6)}\t${a}`) : rows.flatMap(([a, k]) => [`${a} (${k}):`, ...list.filter(c => c.author === a).map(c => `      ${c.subject}`), '']) };
        }
        const out = [];
        for (const c of list.slice(0, n)) {
          const prefix = flag('--graph') ? '* ' : '';
          if (fmt && fmt !== 'oneline') out.push(...pretty(c, fmt).split('\n').map((l, k) => (k === 0 ? prefix + l : l)));
          else out.push(...header(c, fmt === 'oneline', !flag('--no-decorate')).map((l, k) => (k === 0 ? prefix + l : flag('--graph') ? `| ${l}`.trimEnd() : l)));
          if (flag('--stat')) out.push(...statOf(lines(diffOf(c))), ...(fmt === 'oneline' ? [] : ['']));
          if (flag('-p', '--patch')) out.push(...lines(diffOf(c)), ...(fmt === 'oneline' ? [] : ['']));
          if (flag('--name-only')) out.push(...lines(diffOf(c)).filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1]), ...(fmt === 'oneline' ? [] : ['']));
        }
        if (out.at(-1) === '') out.pop();
        return { out };
      }
      case 'show': {
        const spec = operands[0] ?? 'HEAD';
        if (spec.includes(':')) {
          const [rev, file] = spec.split(':');
          const c = resolve(rev || 'HEAD');
          if (!c) return { err: [`fatal: invalid object name '${rev}'.`], code: 128 };
          const text = tree(c)[file];
          return text === undefined ? { err: [`fatal: path '${file}' does not exist in '${rev}'`], code: 128 } : { out: lines(text) };
        }
        const c = resolve(spec);
        if (!c) return { err: [`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`, "Use '--' to separate paths from revisions, like this:", "'git <command> [<revision>...] -- [<file>...]'"], code: 128 };
        const fmt = value('--format') ?? value('--pretty');
        const head_ = fmt ? pretty(c, fmt.replace(/^(format|tformat):/, '')).split('\n') : flag('--oneline') ? header(c, true) : header(c, false);
        if (flag('--stat')) return { out: [...head_, ...statOf(lines(diffOf(c)))] };
        if (flag('--name-only')) return { out: [...head_, ...lines(diffOf(c)).filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1])] };
        if (flag('-s', '--no-patch', '--quiet')) return { out: head_.filter((l, k, all) => !(k === all.length - 1 && l === '')) };
        return { out: [...head_, ...lines(diffOf(c))] };
      }
      case 'status': {
        const { staged, unstaged, untracked, now } = changes();
        const b = head.branch;
        if (flag('--porcelain', '-s', '--short', '-sb')) {
          const out = [];
          if (flag('-b', '-sb', '--branch')) { const t = b && tracking(b); out.push(`## ${b ?? 'HEAD (no branch)'}${t && !t.gone ? `...origin/${t.up}${t.ahead || t.behind ? ` [${[t.ahead ? `ahead ${t.ahead}` : '', t.behind ? `behind ${t.behind}` : ''].filter(Boolean).join(', ')}]` : ''}` : ''}`); }
          const all = [...new Set([...staged, ...unstaged])].sort();
          for (const p of all) {
            const x = staged.includes(p) ? (!(p in tree(current())) ? 'A' : !(p in index) ? 'D' : 'M') : ' ';
            const y = unstaged.includes(p) ? (!(p in now) ? 'D' : 'M') : ' ';
            out.push(`${x}${y} ${p}`);
          }
          out.push(...untracked.map(p => `?? ${p}`));
          return { out };
        }
        const out = [b ? `On branch ${b}` : `HEAD detached at ${short(head.commit)}`];
        const tl = b && trackingLine(b);
        if (tl) out.push(...tl.split('\n'));
        out.push('');
        if (staged.length) out.push('Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', ...staged.map(p => `\t${!(p in tree(current())) ? 'new file:   ' : !(p in index) ? 'deleted:    ' : 'modified:   '}${p}`), '');
        if (unstaged.length) out.push('Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...unstaged.map(p => `\t${p in now ? 'modified:   ' : 'deleted:    '}${p}`), '');
        if (untracked.length) out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)', ...untracked.map(p => `\t${p}`), '');
        if (!staged.length && !unstaged.length && !untracked.length) out.push('nothing to commit, working tree clean');
        else if (!staged.length) out.push(untracked.length && !unstaged.length ? 'nothing added to commit but untracked files present (use "git add" to track)' : 'no changes added to commit (use "git add" and/or "git commit -a")');
        if (out.at(-1) === '') out.pop();
        return { out };
      }
      case 'diff': {
        const revs = [];
        for (const a of operands) {
          if (a.includes('..')) { const [x, y] = a.split(/\.\.\.?/); revs.push(x || 'HEAD', y || 'HEAD'); }
          else if (resolve(a)) revs.push(a);
          else if (dashdash < 0) paths.push(a);
        }
        const bad = revs.find(r => !resolve(r));
        if (bad) return { err: [`fatal: ambiguous argument '${bad}': unknown revision or path not in the working tree.`], code: 128 };
        let from, to;
        if (flag('--cached', '--staged')) { from = tree(revs[0] ? resolve(revs[0]) : current()); to = index; }
        else if (revs.length >= 2) { from = tree(resolve(revs[0])); to = tree(resolve(revs[1])); }
        else if (revs.length === 1) { from = tree(resolve(revs[0])); to = work(); for (const p of Object.keys(to)) if (!(p in index)) delete to[p]; }
        else { from = index; to = work(); for (const p of Object.keys(to)) if (!(p in index)) delete to[p]; }
        const d = diffTrees(from, to, inPaths(paths));
        if (flag('--stat')) return { out: statOf(d) };
        if (flag('--name-only')) return { out: d.filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1]) };
        if (flag('--name-status')) return { out: d.filter(l => l.startsWith('diff --git')).map(l => { const p = l.split(' b/')[1]; return `${!(p in from) ? 'A' : !(p in to) ? 'D' : 'M'}\t${p}`; }) };
        if (flag('--quiet', '--exit-code')) return { out: flag('--quiet') ? [] : d, code: d.length ? 1 : 0 };
        return { out: d };
      }
      case 'add': {
        const now = work();
        const targets = operands.length ? operands : flag('-A', '--all', '-u') ? ['.'] : [];
        if (!targets.length) return { err: ['Nothing specified, nothing added.', "hint: Maybe you wanted to say 'git add .'?", 'hint: Turn this message off by running', 'hint: "git config advice.addEmptyPathspec false"'] };
        for (const t of targets) {
          const match = inPaths([t]);
          const hit = [...new Set([...Object.keys(now), ...Object.keys(index)])].filter(match);
          if (!hit.length) return { err: [`fatal: pathspec '${t}' did not match any files`], code: 128 };
          for (const p of hit) { if (flag('-u') && !(p in index)) continue; if (p in now) index[p] = now[p]; else delete index[p]; }
        }
        return {};
      }
      case 'rm': case 'mv': {
        if (sub === 'mv') {
          const [from, to] = operands;
          if (!(from in index)) return { err: [`fatal: not under version control, source=${from}, destination=${to}`], code: 128 };
          ctx.shell.fs.write(to, ctx.shell.fs.read(from)); ctx.shell.fs.remove(from);
          index[to] = index[from]; delete index[from];
          return {};
        }
        const out = [];
        for (const t of operands) {
          const hit = Object.keys(index).filter(inPaths([t]));
          if (!hit.length) return { err: [`fatal: pathspec '${t}' did not match any files`], code: 128 };
          for (const p of hit) { delete index[p]; if (!flag('--cached')) { try { ctx.shell.fs.remove(p); } catch { /* gone */ } } out.push(`rm '${p}'`); }
        }
        return { out };
      }
      case 'commit': {
        const messages = [];
        for (let k = 0; k < rest.length; k++) {
          if (rest[k] === '-m' || rest[k] === '--message') messages.push(rest[++k] ?? '');
          else if (/^-[a-z]*m$/.test(rest[k]) && rest[k] !== '-m') messages.push(rest[++k] ?? '');
          else if (rest[k].startsWith('--message=')) messages.push(rest[k].slice(10));
          else if (rest[k] === '-F' || rest[k] === '--file') { const text = ctx.shell.readFile(rest[++k] ?? ''); if (text === null) return { err: [`fatal: could not read log file '${rest[k]}': No such file or directory`], code: 128 }; messages.push(text.trim()); }
        }
        if (flag('-a', '--all') || rest.some(a => /^-[a-z]*a[a-z]*$/.test(a))) { const now = work(); for (const p of Object.keys(index)) { if (p in now) index[p] = now[p]; else delete index[p]; } }
        const amend = flag('--amend');
        const parent = amend ? parentOf(current()) : current();
        const { staged, unstaged, untracked } = changes();
        if (!staged.length && !amend && !flag('--allow-empty')) {
          const b = head.branch;
          return { out: [b ? `On branch ${b}` : `HEAD detached at ${short(head.commit)}`, ...(b && trackingLine(b) ? trackingLine(b).split('\n') : []), '', ...(unstaged.length ? ['Changes not staged for commit:', ...unstaged.map(p => `\tmodified:   ${p}`), '', 'no changes added to commit (use "git add" and/or "git commit -a")'] : untracked.length ? ['Untracked files:', ...untracked.map(p => `\t${p}`), '', 'nothing added to commit but untracked files present (use "git add" to track)'] : ['nothing to commit, working tree clean'])], code: 1 };
        }
        const message = messages.length ? messages.join('\n\n') : amend ? [current().subject, current().body].filter(Boolean).join('\n\n') : null;
        if (!message) return { err: ['hint: Waiting for your editor to close the file... error: There was a problem with the editor \'vi\'.', 'Please supply the message using either -m or -F option.'], code: 1 };
        const [subject, ...bodyParts] = message.split('\n\n');
        const c = change(subject.split('\n')[0], bodyParts.join('\n\n') || undefined, index, parent);
        move(c, `commit${amend ? ' (amend)' : ''}: ${c.subject}`);
        const d = diffTrees(tree(parent), c.files);
        ctx.event('git.commit', { subject: c.subject, files: d.filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1]) });
        const created = d.filter(l => l.startsWith('new file mode')).length;
        return { out: [`[${head.branch ?? 'detached HEAD'} ${short(c)}] ${c.subject}`, ...(statOf(d).slice(-1).length ? [statOf(d).slice(-1)[0]] : [' 0 files changed']), ...(created ? d.map((l, k) => (l.startsWith('new file mode') ? ` create mode 100644 ${d[k - 1].split(' b/')[1]}` : null)).filter(Boolean) : [])] };
      }
      case 'push': {
        ctx.wait(3);
        const force = flag('-f', '--force') || rest.some(a => a.startsWith('--force-with-lease'));
        const setUp = flag('-u', '--set-upstream');
        const del = flag('-d', '--delete');
        let [remoteName = 'origin', ...specs] = operands;
        if (remoteName !== 'origin') { if (resolve(remoteName) || heads.has(remoteName)) { specs = [remoteName, ...specs]; remoteName = 'origin'; } else return { err: [`fatal: '${remoteName}' does not appear to be a git repository`, 'fatal: Could not read from remote repository.', '', 'Please make sure you have the correct access rights', 'and the repository exists.'], code: 128 }; }
        const url = remote;
        if (!specs.length) {
          if (!head.branch) return { err: ['fatal: You are not currently on a branch.', 'To push the history leading to the current (detached HEAD)', 'state now, use', '', '    git push origin HEAD:<name-of-remote-branch>', ''], code: 128 };
          if (!upstream.has(head.branch) && !setUp) return { err: [`fatal: The current branch ${head.branch} has no upstream branch.`, 'To push the current branch and set the remote as upstream, use', '', `    git push --set-upstream origin ${head.branch}`, '', "To have this happen automatically for branches without a tracking", "upstream, see 'push.autoSetupRemote' in 'git help config'.", ''], code: 128 };
          specs = [head.branch];
        }
        const out = [], err = [], done = [];
        let failed = false;
        for (const spec of specs) {
          const deleting = del || spec.startsWith(':');
          const [srcSpec, dstSpec] = spec.startsWith(':') ? ['', spec.slice(1)] : spec.split(':');
          const dst = (dstSpec ?? (srcSpec === 'HEAD' ? head.branch : srcSpec)) ?? '';
          if (deleting) {
            const name = dst || srcSpec;
            if (name === main) { err.push(`To ${url}`, ` ! [remote rejected] ${main} (refusing to delete the current branch: refs/heads/${main})`, `error: failed to push some refs to '${url}'`); failed = true; continue; }
            if (!remotes.has(name)) { err.push(`error: unable to delete '${name}': remote ref does not exist`, `error: failed to push some refs to '${url}'`); failed = true; continue; }
            remotes.delete(name);
            ctx.event('git.push', { branch: name, deleted: true });
            done.push(` - [deleted]         ${name}`);
            continue;
          }
          const src = resolve(srcSpec || 'HEAD');
          if (!src) { err.push(`error: src refspec ${srcSpec} does not match any`, `error: failed to push some refs to '${url}'`); failed = true; continue; }
          const theirs = remotes.get(dst);
          if (theirs === src) { done.push(null); continue; }
          if (dst === main) {
            ctx.event('git.push', { branch: dst, rejected: true });
            err.push('Enumerating objects: 9, done.', 'Counting objects: 100% (9/9), done.', 'Delta compression using up to 4 threads', 'Compressing objects: 100% (4/4), done.', 'Writing objects: 100% (5/5), 512 bytes | 512.00 KiB/s, done.', 'Total 5 (delta 3), reused 0 (delta 0), pack-reused 0', `remote: error: GH006: Protected branch update failed for refs/heads/${main}.`, 'remote: error: Changes must be made through a pull request.', `To ${url.replace('git@github.com:', 'github.com:')}`, ` ! [remote rejected] ${srcSpec === 'HEAD' || !srcSpec ? head.branch ?? 'HEAD' : srcSpec} -> ${dst} (protected branch hook declined)`, `error: failed to push some refs to '${url}'`);
            failed = true; continue;
          }
          if (theirs && !isAncestor(theirs, src) && !force) {
            err.push(`To ${url}`, ` ! [rejected]        ${srcSpec || head.branch} -> ${dst} (non-fast-forward)`, `error: failed to push some refs to '${url}'`, 'hint: Updates were rejected because the tip of your current branch is behind', "hint: its remote counterpart. If you want to integrate the remote changes,", "hint: use 'git pull' before pushing again.", "hint: See the 'Note about fast-forwards' in 'git push --help' for details.");
            failed = true; continue;
          }
          const name = srcSpec === 'HEAD' || !srcSpec ? head.branch ?? dst : srcSpec;
          remotes.set(dst, src);
          pushed.push(dst);
          if (setUp && heads.has(name)) upstream.set(name, dst);
          ctx.event('git.push', { branch: dst });
          if (!theirs) done.push('remote:', `remote: Create a pull request for '${dst}' on GitHub by visiting:`, `remote:      https://github.com/${repoName}/pull/new/${dst}`, 'remote:', ` * [new branch]      ${name} -> ${dst}`);
          else done.push(`${force && !isAncestor(theirs, src) ? ' + ' : '   '}${short(theirs)}${force && !isAncestor(theirs, src) ? '...' : '..'}${short(src)}  ${name} -> ${dst}${force && !isAncestor(theirs, src) ? ' (forced update)' : ''}`);
          if (setUp) out.push(`branch '${name}' set up to track 'origin/${dst}'.`);
        }
        const real = done.filter(Boolean);
        if (!real.length && !failed) return { err: ['Everything up-to-date'] };
        const body = real.some(l => !l.startsWith(' - ')) ? ['Enumerating objects: 7, done.', 'Counting objects: 100% (7/7), done.', 'Delta compression using up to 4 threads', 'Compressing objects: 100% (4/4), done.', 'Writing objects: 100% (4/4), 603 bytes | 603.00 KiB/s, done.', 'Total 4 (delta 2), reused 0 (delta 0), pack-reused 0', 'remote: Resolving deltas: 100% (2/2), completed with 2 local objects.'] : [];
        const remoteLines = real.filter(l => l.startsWith('remote:'));
        const refLines = real.filter(l => !l.startsWith('remote:'));
        return { out, err: [...(real.length ? [...body, ...remoteLines, `To ${url}`, ...refLines] : []), ...err], code: failed ? 1 : 0 };
      }
      case 'fetch': case 'pull': {
        ctx.wait(2);
        if (sub === 'fetch') return {};
        if (!head.branch || !upstream.has(head.branch)) return { err: ['There is no tracking information for the current branch.', 'Please specify which branch you want to merge with.', "See git-pull(1) for details.", '', '    git pull <remote> <branch>', '', 'If you wish to set tracking information for this branch you can do so with:', '', `    git branch --set-upstream-to=origin/<branch> ${head.branch ?? ''}`, ''], code: 1 };
        const theirs = remotes.get(upstream.get(head.branch));
        if (!theirs || isAncestor(theirs, current())) return { out: ['Already up to date.'] };
        return fastForward(theirs);
      }
      case 'merge': {
        const target = resolve(operands[0] ?? '');
        if (!target) return { err: [`merge: ${operands[0] ?? ''} - not something we can merge`], code: 1 };
        if (isAncestor(target, current())) return { out: ['Already up to date.'] };
        if (isAncestor(current(), target)) return fastForward(target);
        return replay(target, 'merge');
      }
      case 'rebase': {
        const onto = resolve(operands[0] ?? (head.branch && upstream.has(head.branch) ? `origin/${upstream.get(head.branch)}` : ''));
        if (!onto) return { err: ['There is no tracking information for the current branch.', 'Please specify which branch you want to rebase against.'], code: 1 };
        if (isAncestor(onto, current())) return { out: [`Current branch ${head.branch ?? 'HEAD'} is up to date.`] };
        if (isAncestor(current(), onto)) { const r = fastForward(onto); return r.code ? r : { out: [`Successfully rebased and updated refs/heads/${head.branch}.`] }; }
        return replay(onto, 'rebase');
      }
      case 'branch': {
        if (flag('--show-current')) return { out: head.branch ? [head.branch] : [] };
        const mIdx = rest.findIndex(a => ['-m', '-M', '--move'].includes(a));
        if (mIdx >= 0) {
          const names = rest.slice(mIdx + 1).filter(a => !a.startsWith('-'));
          const [from, to] = names.length >= 2 ? names : [head.branch, names[0]];
          if (!to) return { err: ['fatal: branch name required'], code: 128 };
          if (!heads.has(from)) return { err: [`error: refname refs/heads/${from} not found`, `fatal: Branch rename failed`], code: 128 };
          if (heads.has(to) && rest[mIdx] !== '-M') return { err: [`fatal: A branch named '${to}' already exists.`], code: 128 };
          heads.set(to, heads.get(from)); heads.delete(from);
          if (upstream.has(from)) { upstream.set(to, upstream.get(from)); upstream.delete(from); }
          if (head.branch === from) head = { branch: to };
          return {};
        }
        const dIdx = rest.findIndex(a => ['-d', '-D', '--delete'].includes(a));
        if (dIdx >= 0) {
          const out = [], err = [];
          for (const name of rest.slice(dIdx + 1).filter(a => !a.startsWith('-'))) {
            if (flag('-r')) { if (!remotes.has(name.replace(/^origin\//, ''))) { err.push(`error: remote-tracking branch '${name}' not found.`); continue; } out.push(`Deleted remote-tracking branch ${name} (was ${short(remotes.get(name.replace(/^origin\//, '')))}).`); remotes.delete(name.replace(/^origin\//, '')); continue; }
            if (!heads.has(name)) { err.push(`error: branch '${name}' not found.`); continue; }
            if (head.branch === name) { err.push(`error: Cannot delete branch '${name}' checked out at '${ctx.shell.home}'`); continue; }
            const up = upstream.has(name) ? remotes.get(upstream.get(name)) : heads.get(main);
            if (rest[dIdx] !== '-D' && !isAncestor(heads.get(name), up ?? current())) { err.push(`error: The branch '${name}' is not fully merged.`, `If you are sure you want to delete it, run 'git branch -D ${name}'.`); continue; }
            out.push(`Deleted branch ${name} (was ${short(heads.get(name))}).`);
            heads.delete(name); upstream.delete(name);
          }
          return { out, err, code: err.length ? 1 : 0 };
        }
        const upTo = value('--set-upstream-to') ?? value('-u');
        if (upTo) {
          const name = operands.find(a => a !== upTo) ?? head.branch;
          if (!remotes.has(upTo.replace(/^origin\//, ''))) return { err: [`error: the requested upstream branch '${upTo}' does not exist`], code: 128 };
          upstream.set(name, upTo.replace(/^origin\//, ''));
          return { out: [`branch '${name}' set up to track '${upTo}'.`] };
        }
        const create = operands.filter(a => !a.startsWith('-'));
        if (create.length && !flag('-a', '-r', '--list', '-l')) {
          const [name, start] = create;
          if (heads.has(name)) return { err: [`fatal: a branch named '${name}' already exists`], code: 128 };
          const at = resolve(start ?? 'HEAD');
          if (!at) return { err: [`fatal: not a valid object name: '${start}'`], code: 128 };
          heads.set(name, at);
          return {};
        }
        const verbose = flag('-v', '-vv', '--verbose');
        const width = Math.max(...[...heads.keys()].map(n => n.length), 0);
        const row = (name, c, mark) => `${mark} ${verbose ? name.padEnd(width) : name}${verbose ? ` ${short(c)} ${flag('-vv') && upstream.has(name) ? `[origin/${upstream.get(name)}${(() => { const t = tracking(name); return t && !t.gone && (t.ahead || t.behind) ? `: ${[t.ahead ? `ahead ${t.ahead}` : '', t.behind ? `behind ${t.behind}` : ''].filter(Boolean).join(', ')}` : t?.gone ? ': gone' : ''; })()}] ` : ''}${c.subject}` : ''}`;
        const out = [];
        if (!flag('-r')) {
          if (!head.branch) out.push(`* (HEAD detached at ${short(head.commit)})`);
          for (const [name, c] of [...heads].sort(([a], [b]) => a.localeCompare(b))) out.push(row(name, c, name === head.branch ? '*' : ' '));
        }
        if (flag('-a', '-r')) {
          const pre = flag('-r') ? '' : 'remotes/';
          out.push(`  ${pre}origin/HEAD -> origin/${main}`);
          for (const [name, c] of [...remotes].sort(([a], [b]) => a.localeCompare(b))) out.push(`  ${pre}origin/${name}${verbose ? ` ${short(c)} ${c.subject}` : ''}`);
        }
        return { out };
      }
      case 'checkout': case 'switch': {
        if (dashdash >= 0 || (sub === 'checkout' && operands.length && operands.every(a => !resolve(a) && (a in index || a === '.' || Object.keys(index).some(p => p.startsWith(`${a.replace(/\/$/, '')}/`)))))) {
          const targets = dashdash >= 0 ? paths : operands;
          const source = dashdash >= 0 && operands[0] ? resolve(operands[0]) : null;
          const from = source ? tree(source) : index;
          let n = 0;
          for (const t of targets) for (const p of Object.keys(from).filter(inPaths([t]))) { ctx.shell.fs.write(p, from[p]); if (source) index[p] = from[p]; n++; }
          if (!n) return { err: [`error: pathspec '${targets[0]}' did not match any file(s) known to git`], code: 1 };
          return { err: [`Updated ${n} path${n === 1 ? '' : 's'} from ${source ? 'the index' : 'the index'}`] };
        }
        const newFlag = rest.findIndex(a => ['-b', '-B', '-c', '-C'].includes(a));
        if (newFlag >= 0) {
          const name = rest[newFlag + 1];
          if (!name) return { err: [`error: switch \`${rest[newFlag].slice(1)}' requires a value`], code: 129 };
          if (heads.has(name) && !['-B', '-C'].includes(rest[newFlag])) return { err: [sub === 'switch' ? `fatal: a branch named '${name}' already exists` : `fatal: a branch named '${name}' already exists`], code: 128 };
          const start = rest.slice(newFlag + 2).find(a => !a.startsWith('-'));
          const at = start ? resolve(start) : current();
          if (!at) return { err: [`fatal: '${start}' is not a commit and a branch '${name}' cannot be created from it`], code: 128 };
          if (at !== current()) { const r = checkoutTree(at); if (r) return r; }
          heads.set(name, at);
          if (start?.startsWith('origin/')) upstream.set(name, start.slice(7));
          head = { branch: name };
          reflog.unshift({ c: at, what: `checkout: moving from ${short(current())} to ${name}` });
          return { err: [`Switched to a new branch '${name}'`, ...(start?.startsWith('origin/') ? [`branch '${name}' set up to track '${start}'.`] : [])] };
        }
        let target = operands[0];
        if (!target) return sub === 'switch' ? { err: ['fatal: missing branch or commit argument'], code: 128 } : { out: [] };
        if (target === '-') target = reflog.find(r => r.what.startsWith('checkout: moving from'))?.what.split(' ')[3] ?? '';
        if (head.branch === target) return { err: [`Already on '${target}'`], out: trackingLine(target) ? trackingLine(target).split('\n') : [] };
        if (!heads.has(target) && remotes.has(target)) {
          const r = checkoutTree(remotes.get(target)); if (r) return r;
          heads.set(target, remotes.get(target)); upstream.set(target, target); head = { branch: target };
          return { err: [`branch '${target}' set up to track 'origin/${target}'.`, `Switched to a new branch '${target}'`] };
        }
        if (heads.has(target)) {
          const r = checkoutTree(heads.get(target)); if (r) return r;
          const from = head.branch ?? short(current());
          head = { branch: target };
          reflog.unshift({ c: current(), what: `checkout: moving from ${from} to ${target}` });
          return { err: [`Switched to branch '${target}'`], out: [...carried, ...(trackingLine(target) ? trackingLine(target).split('\n') : [])] };
        }
        const c = resolve(target);
        if (!c || sub === 'switch' && !flag('--detach', '-d')) return { err: sub === 'switch' && c ? ['fatal: a branch is expected, got commit \'' + target + '\'', 'hint: If you want to detach HEAD at the commit, try again with the --detach option.'] : [`error: pathspec '${target}' did not match any file(s) known to git`], code: sub === 'switch' ? 128 : 1 };
        const r = checkoutTree(c); if (r) return r;
        const from = head.branch ?? short(current());
        head = { commit: c };
        reflog.unshift({ c, what: `checkout: moving from ${from} to ${target}` });
        return { err: [`Note: switching to '${target}'.`, '', "You are in 'detached HEAD' state. You can look around, make experimental", 'changes and commit them, and you can discard any commits you make in this', 'state without impacting any branches by switching back to a branch.', '', 'If you want to create a new branch to retain commits you create, you may', 'do so (now or later) by using -c with the switch command. Example:', '', '  git switch -c <new-branch-name>', '', 'Or undo this operation with:', '', '  git switch -', '', 'Turn off this advice by setting config variable advice.detachedHead to false', '', `HEAD is now at ${short(c)} ${c.subject}`] };
      }
      case 'restore': {
        const source = value('--source') ?? value('-s');
        const from = source ? tree(resolve(source)) : flag('--staged', '-S') ? tree(current()) : index;
        if (source && !resolve(source)) return { err: [`fatal: could not resolve ${source}`], code: 128 };
        const targets = operands.filter(a => a !== source);
        if (!targets.length) return { err: ['fatal: you must specify path(s) to restore'], code: 128 };
        for (const t of targets) {
          const hit = [...new Set([...Object.keys(from), ...Object.keys(index)])].filter(inPaths([t]));
          if (!hit.length) return { err: [`error: pathspec '${t}' did not match any file(s) known to git`], code: 1 };
          for (const p of hit) {
            if (flag('--staged', '-S')) { if (p in from) index[p] = from[p]; else delete index[p]; }
            if (!flag('--staged', '-S') || flag('--worktree', '-W')) { if (p in from) ctx.shell.fs.write(p, from[p]); else { try { ctx.shell.fs.remove(p); } catch { /* gone */ } } }
          }
        }
        return {};
      }
      case 'reset': {
        const mode = flag('--hard') ? 'hard' : flag('--soft') ? 'soft' : 'mixed';
        const spec = operands.find(a => resolve(a));
        const pathArgs = operands.filter(a => a !== spec);
        if (pathArgs.length && mode === 'mixed') { for (const p of Object.keys({ ...index, ...tree(current()) }).filter(inPaths(pathArgs))) { const base = tree(current()); if (p in base) index[p] = base[p]; else delete index[p]; } return { out: [] }; }
        const target = spec ? resolve(spec) : current();
        const before = work(), tracked = index;
        move(target, `reset: moving to ${spec ?? 'HEAD'}`);
        if (mode !== 'soft') index = { ...tree(target) };
        if (mode === 'hard') {
          // Untracked files survive a hard reset; everything tracked becomes the target's.
          const untracked = Object.fromEntries(Object.entries(before).filter(([p]) => !(p in tracked) && !(p in tree(target))));
          writeTree(before, { ...tree(target), ...untracked });
          return { out: [`HEAD is now at ${short(target)} ${target.subject}`] };
        }
        if (mode === 'mixed') { const d = Object.keys(index).filter(p => before[p] !== index[p]); return { out: d.length ? ['Unstaged changes after reset:', ...d.map(p => `M\t${p}`)] : [] }; }
        return {};
      }
      case 'revert': case 'cherry-pick': {
        const c = resolve(operands[0] ?? '');
        if (!c) return { err: [`fatal: bad revision '${operands[0] ?? ''}'`], code: 128 };
        const { staged, unstaged } = changes();
        if (staged.length || unstaged.length) return { err: ['error: your local changes would be overwritten by ' + sub + '.', 'hint: commit your changes or stash them to proceed.', `fatal: ${sub === 'revert' ? 'revert' : 'cherry-pick'} failed`], code: 128 };
        const files = { ...tree(current()) };
        const conflict = patch(files, diffOf(c), sub === 'revert');
        if (conflict) {
          return { err: [`error: could not ${sub === 'revert' ? 'revert' : 'apply'} ${short(c)}... ${c.subject}`, `hint: After resolving the conflicts, mark them with`, 'hint: "git add/rm <pathspec>", then run', `hint: "git ${sub} --continue".`, `hint: You can instead skip this commit with "git ${sub} --skip".`, `hint: To abort and get back to the state before "git ${sub}",`, `hint: run "git ${sub} --abort".`], out: [`CONFLICT (content): Merge conflict in ${conflict}`], code: 1 };
        }
        const subject = sub === 'revert' ? `Revert "${c.subject}"` : c.subject;
        const body = sub === 'revert' ? `This reverts commit ${c.sha}.` : c.body;
        if (flag('-n', '--no-commit')) { writeTree(work(), { ...work(), ...files }); for (const p of Object.keys(tree(current()))) if (!(p in files)) { try { ctx.shell.fs.remove(p); } catch { /* gone */ } } index = { ...files }; return {}; }
        const before = tree(current());
        const made_ = change(subject, body, files);
        writeTree(before, files);
        index = { ...files };
        move(made_, `${sub}: ${subject}`);
        const d = diffTrees(before, files);
        ctx.event('git.commit', { subject, files: d.filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1]) });
        return { out: [`[${head.branch ?? 'detached HEAD'} ${short(made_)}] ${subject}`, ...(sub === 'cherry-pick' ? [` Date: ${gitDate(ctx.at(c.t))}`] : []), statOf(d).at(-1) ?? ' 0 files changed'] };
      }
      case 'stash': {
        const verb = operands[0] ?? 'push';
        const label = () => `${head.branch ?? '(no branch)'}: ${short(current())} ${current().subject}`;
        if (verb === 'list') return { out: stash.map((s, k) => `stash@{${k}}: WIP on ${s.label}`) };
        if (verb === 'push' || verb === 'save') {
          const { now, staged, unstaged } = changes();
          if (!staged.length && !unstaged.length) return { out: ['No local changes to save'] };
          const saved = Object.fromEntries([...new Set([...staged, ...unstaged])].map(p => [p, p in now ? now[p] : null]));
          stash.unshift({ files: saved, label: label() });
          const base = tree(current());
          for (const p of Object.keys(saved)) { if (p in base) ctx.shell.fs.write(p, base[p]); else { try { ctx.shell.fs.remove(p); } catch { /* gone */ } } }
          index = { ...base };
          return { out: [`Saved working directory and index state WIP on ${stash[0].label}`] };
        }
        if (verb === 'pop' || verb === 'apply') {
          if (!stash.length) return { err: ['No stash entries found.'], code: 1 };
          const s = verb === 'pop' ? stash.shift() : stash[0];
          for (const [p, text] of Object.entries(s.files)) { if (text === null) { try { ctx.shell.fs.remove(p); } catch { /* gone */ } } else ctx.shell.fs.write(p, text); }
          const status = git(['status']).out ?? [];
          return { out: [...status, ...(verb === 'pop' ? [`Dropped refs/stash@{0} (${blob(JSON.stringify(s.files))})`] : [])] };
        }
        if (verb === 'show') { if (!stash.length) return { err: ['error: No stash entries found.'], code: 1 }; return { out: statOf(diffTrees(tree(current()), Object.fromEntries(Object.entries({ ...tree(current()), ...stash[0].files }).filter(([, v]) => v !== null)))) }; }
        if (verb === 'drop' || verb === 'clear') { if (!stash.length && verb === 'drop') return { err: ['No stash entries found.'], code: 1 }; if (verb === 'clear') stash.length = 0; else stash.shift(); return verb === 'drop' ? { out: ['Dropped refs/stash@{0}'] } : {}; }
        return { err: [`error: unknown subcommand: \`${verb}'`, 'usage: git stash list [<log-options>]'], code: 129 };
      }
      case 'tag': {
        const name = operands[0];
        if (!name || flag('-l', '--list')) return { out: [...tags.keys()].sort() };
        if (flag('-d')) { if (!tags.has(name)) return { err: [`error: tag '${name}' not found.`], code: 1 }; const c = tags.get(name); tags.delete(name); return { out: [`Deleted tag '${name}' (was ${short(c)})`] }; }
        if (tags.has(name)) return { err: [`fatal: tag '${name}' already exists`], code: 128 };
        const at = resolve(operands[1] ?? 'HEAD');
        tags.set(name, at);
        return {};
      }
      case 'describe': {
        const c = resolve(operands[0] ?? 'HEAD');
        for (const [k, x] of ancestry(c).entries()) { const t = [...tags].find(([, y]) => y === x); if (t) return { out: [k ? `${t[0]}-${k}-g${short(c)}` : t[0]] }; }
        return { err: ['fatal: No names found, cannot describe anything.'], code: 128 };
      }
      case 'config': {
        const u = user();
        const known = { 'user.name': u.name, 'user.email': u.email, 'remote.origin.url': remote, 'remote.origin.fetch': '+refs/heads/*:refs/remotes/origin/*', 'core.bare': 'false', 'init.defaultbranch': main, [`branch.${main}.remote`]: 'origin', [`branch.${main}.merge`]: `refs/heads/${main}` };
        for (const [b, up] of upstream) { known[`branch.${b}.remote`] = 'origin'; known[`branch.${b}.merge`] = `refs/heads/${up}`; }
        if (flag('--list', '-l')) return { out: Object.entries({ ...known, ...config }).map(([k, v]) => `${k}=${v}`) };
        const keys = operands.filter(a => a.includes('.') || a === operands[0]);
        const key = (keys[0] ?? '').toLowerCase();
        if (!key) return { err: ['usage: git config [<options>]'], code: 129 };
        if (operands.length >= 2 && !flag('--get')) { config[key] = operands[1]; return {}; }
        const v = config[key] ?? known[key];
        return v === undefined ? { code: 1 } : { out: [v] };
      }
      case 'remote': {
        const verb = operands[0];
        if (!verb) return { out: flag('-v') ? [`origin\t${remote} (fetch)`, `origin\t${remote} (push)`] : ['origin'] };
        if (verb === 'get-url') return operands[1] === 'origin' ? { out: [remote] } : { err: [`error: No such remote '${operands[1] ?? ''}'`], code: 2 };
        if (verb === 'show') {
          ctx.wait(1);
          return { out: ['* remote origin', `  Fetch URL: ${remote}`, `  Push  URL: ${remote}`, `  HEAD branch: ${main}`, '  Remote branches:', ...[...remotes.keys()].sort().map(b => `    ${b} tracked`), "  Local branch configured for 'git pull':", ...[...upstream].filter(([b]) => heads.has(b)).map(([b, up]) => `    ${b} merges with remote ${up}`), "  Local ref configured for 'git push':", ...[...upstream].filter(([b]) => heads.has(b) && remotes.has(upstream.get(b))).map(([b, up]) => `    ${b} pushes to ${up} (${heads.get(b) === remotes.get(up) ? 'up to date' : isAncestor(remotes.get(up), heads.get(b)) ? 'fast-forwardable' : 'local out of date'})`)] };
        }
        if (verb === 'add') return { err: ['error: remote origin already exists.'], code: 3 };
        return { err: [`error: unknown subcommand: \`${verb}'`], code: 129 };
      }
      case 'ls-remote': {
        ctx.wait(1);
        if (operands[0] && operands[0] !== 'origin' && operands[0] !== remote) return { err: [`fatal: '${operands[0]}' does not appear to be a git repository`, 'fatal: Could not read from remote repository.'], code: 128 };
        const rows = [];
        if (!flag('--heads', '-h', '--tags', '-t')) rows.push(`${remotes.get(main).sha}\tHEAD`);
        if (!flag('--tags', '-t')) for (const [b, c] of [...remotes].sort(([a], [b]) => a.localeCompare(b))) rows.push(`${c.sha}\trefs/heads/${b}`);
        return { out: rows };
      }
      case 'rev-parse': {
        if (flag('--is-inside-work-tree')) return { out: ['true'] };
        if (flag('--show-toplevel')) return { out: [ctx.shell.home] };
        if (flag('--git-dir')) return { out: ['.git'] };
        if (flag('--abbrev-ref')) { const a = operands[0] ?? 'HEAD'; if (a === 'HEAD') return { out: [head.branch ?? 'HEAD'] }; if (/@\{u(pstream)?\}/.test(a)) return head.branch && upstream.has(head.branch) ? { out: [`origin/${upstream.get(head.branch)}`] } : { err: ['fatal: no upstream configured for branch \'' + (head.branch ?? 'HEAD') + '\''], code: 128 }; return { out: [a] }; }
        const out = [];
        for (const a of operands.length ? operands : ['HEAD']) { const c = resolve(a); if (!c) return { out, err: [a, `fatal: ambiguous argument '${a}': unknown revision or path not in the working tree.`], code: 128 }; out.push(flag('--short') ? short(c) : c.sha); }
        return { out };
      }
      case 'ls-files': { const now = work(); return { out: Object.keys(index).filter(inPaths(operands)).filter(p => !flag('-m', '--modified') || now[p] !== index[p]).sort() }; }
      case 'grep': {
        const [pattern, ...where] = operands;
        if (!pattern) return { err: ['fatal: no pattern given'], code: 128 };
        const re = new RegExp(flag('-F', '--fixed-strings') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, flag('-i') ? 'i' : '');
        const out = [];
        const now = work();
        for (const p of Object.keys(index).filter(inPaths([...where, ...paths])).sort()) {
          const text = now[p] ?? '';
          const hits = lines(text).map((l, k) => [l, k]).filter(([l]) => re.test(l) !== flag('-v'));
          if (!hits.length) continue;
          if (flag('-l')) { out.push(p); continue; }
          if (flag('-c')) { out.push(`${p}:${hits.length}`); continue; }
          for (const [l, k] of hits) out.push(`${p}:${flag('-n') ? `${k + 1}:` : ''}${l}`);
        }
        return { out, code: out.length ? 0 : 1 };
      }
      case 'blame': {
        const file = operands.find(a => a in index) ?? operands[0];
        const text = file ? ctx.shell.readFile(file) : null;
        if (text === null || !(file in index)) return { err: [`fatal: no such path '${file}' in HEAD`], code: 128 };
        const owner = ancestry(current()).find(c => lines(diffOf(c)).some(l => l === `diff --git a/${file} b/${file}`)) ?? history.at(-1);
        return { out: lines(text).map((l, k) => `${owner.sha.slice(0, 8)} (${owner.author.padEnd(16)} ${ctx.at(owner.t).toISOString().slice(0, 19).replace('T', ' ')} +0000 ${String(k + 1).padStart(3)}) ${l}`) };
      }
      case 'reflog': return { out: reflog.slice(0, Number(value('-n') ?? 50)).map((r, k) => `${short(r.c)} HEAD@{${k}}: ${r.what}`) };
      case 'clean': {
        const { untracked } = changes();
        if (!flag('-n', '--dry-run') && !rest.some(a => /^-[a-z]*f/.test(a))) return { err: ['fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean'], code: 128 };
        if (!flag('-n', '--dry-run')) for (const p of untracked) { try { ctx.shell.fs.remove(p); } catch { /* gone */ } }
        return { out: untracked.map(p => `${flag('-n', '--dry-run') ? 'Would remove' : 'Removing'} ${p}`) };
      }
      case 'worktree': return operands[0] === 'list' ? { out: [`${ctx.shell.home}  ${short(current())} [${head.branch ?? 'detached HEAD'}]`] } : { err: ['usage: git worktree add [<options>] <path> [<commit-ish>]', '   or: git worktree list [<options>]'], code: 129 };
      case 'gc': case 'prune': case 'fsck': case 'maintenance': return {};
      case 'apply': {
        const file = operands[0];
        const text = file ? ctx.shell.readFile(file) : null;
        if (text === null) return { err: [`error: can't open patch '${file}': No such file or directory`], code: 128 };
        const files = work();
        const conflict = patch(files, text, flag('-R', '--reverse'), flag('--check'));
        if (conflict) return { err: [`error: patch failed: ${conflict}:1`, `error: ${conflict}: patch does not apply`], code: 1 };
        if (!flag('--check')) writeTree(work(), files);
        return {};
      }
      default:
        if (OTHER.includes(sub)) return { err: [`usage: git ${sub} [<options>]`, '', `    see 'git help ${sub}'`], code: 129 };
        return { err: [`git: '${sub}' is not a git command. See 'git --help'.`], code: 1 };
    }
  }
  function fastForward(target) {
    const from = current(), before = tree(from);
    const r = checkoutTree(target);
    if (r) return r;
    move(target, `pull: Fast-forward`);
    return { out: [`Updating ${short(from)}..${short(target)}`, 'Fast-forward', ...statOf(diffTrees(before, tree(target)))] };
  }
  /** A rebase or merge of diverged history: the other side's commits are applied on top. */
  function replay(target, how) {
    const mine = current();
    const base = ancestry(mine).find(x => ancestry(target).includes(x));
    const files = { ...tree(mine) };
    for (const c of ancestry(target).slice(0, ancestry(target).indexOf(base)).reverse()) {
      const conflict = patch(files, diffOf(c), false);
      if (conflict) return { out: [`Auto-merging ${conflict}`, `CONFLICT (content): Merge conflict in ${conflict}`], err: [how === 'merge' ? 'Automatic merge failed; fix conflicts and then commit the result.' : `error: could not apply ${short(c)}... ${c.subject}`], code: 1 };
    }
    const before = tree(mine);
    const c = change(how === 'merge' ? `Merge ${heads.has(target) ? `branch '${[...heads].find(([, x]) => x === target)?.[0]}'` : `remote-tracking branch 'origin/${[...remotes].find(([, x]) => x === target)?.[0] ?? ''}'`}` : mine.subject, undefined, files);
    writeTree(before, files);
    index = { ...files };
    move(c, how);
    return { out: how === 'merge' ? ["Merge made by the 'ort' strategy.", ...statOf(diffTrees(before, files))] : [`Successfully rebased and updated refs/heads/${head.branch}.`] };
  }

  /** The GitHub CLI for this repository. Pull requests need their branch on the remote. */
  const prs = [];
  const firstPr = 2000 + (Array.from(repoName).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 900);
  git.gh = function gh(argv) {
    const [group, verb, ...rest] = argv;
    ctx.wait(1);
    const value = (...names) => { const k = rest.findIndex(a => names.includes(a) || names.some(n => a.startsWith(`${n}=`))); return k < 0 ? undefined : rest[k].includes('=') ? rest[k].slice(rest[k].indexOf('=') + 1) : rest[k + 1]; };
    if (!group || group === 'help' || group === '--help') return { out: ['Work seamlessly with GitHub from the command line.', '', 'USAGE', '  gh <command> <subcommand> [flags]', '', 'CORE COMMANDS', '  auth:        Authenticate gh and git with GitHub', '  browse:      Open repositories, issues, pull requests, and more in the browser', '  issue:       Manage issues', '  pr:          Manage pull requests', '  repo:        Manage repositories'] };
    if (group === '--version' || group === 'version') return { out: ['gh version 2.46.0 (2024-03-20)', 'https://github.com/cli/cli/releases/tag/v2.46.0'] };
    if (group === 'auth' && verb === 'status') return { out: ['github.com', `  ✓ Logged in to github.com account ${user().email.split('@')[0]}-quillmart (keyring)`, '  - Active account: true', '  - Git operations protocol: ssh', '  - Token: gho_************************************', "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'"] };
    if (group === 'repo' && verb === 'view') return { out: [repoName, 'No description provided', '', '', `View this repository on GitHub: https://github.com/${repoName}`] };
    if (group !== 'pr') return { err: [`unknown command "${group}" for "gh"`, '', 'Usage:  gh <command> <subcommand> [flags]', '', 'Available commands:', '  auth', '  browse', '  issue', '  pr', '  repo'], code: 1 };
    if (verb === 'create') {
      const headRef = value('--head', '-H') ?? head.branch;
      const baseRef = value('--base', '-B') ?? main;
      const title = value('--title', '-t');
      if (!headRef) return { err: ['could not determine the current branch: not on any branch'], code: 1 };
      if (headRef === baseRef) return { err: [`could not create pull request: head branch "${headRef}" is the same as base branch "${baseRef}", cannot create a pull request`], code: 1 };
      if (!remotes.has(headRef)) return { err: [`aborted: you must first push the current branch to a remote, or use the --head flag`], code: 1 };
      if (!title && !rest.includes('--fill') && !rest.includes('-f')) return { err: ['must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively'], code: 1 };
      if (prs.some(p => p.head === headRef && p.state === 'OPEN')) return { err: [`a pull request for branch "${headRef}" into branch "${baseRef}" already exists:`, `https://github.com/${repoName}/pull/${prs.find(p => p.head === headRef).number}`], code: 1 };
      const pr = { number: firstPr + prs.length, title: title ?? remotes.get(headRef).subject, body: value('--body', '-b') ?? '', head: headRef, base: baseRef, state: 'OPEN', t: ctx.t };
      prs.push(pr);
      ctx.event('gh.pr.create', { number: pr.number, head: headRef, base: baseRef, title: pr.title });
      return { err: [`\nCreating pull request for ${headRef} into ${baseRef} in ${repoName}\n`], out: [`https://github.com/${repoName}/pull/${pr.number}`] };
    }
    if (verb === 'list') return prs.length ? { out: [`\nShowing ${prs.length} of ${prs.length} open pull request${prs.length === 1 ? '' : 's'} in ${repoName}\n`, ...prs.map(p => `#${p.number}\t${p.title}\t${p.head}\t${relative(ctx.t - p.t).replace(/^(\d)/, "about $1")}`)] } : { err: [`no open pull requests in ${repoName}`], code: 0 };
    if (verb === 'view' || verb === 'merge' || verb === 'checks') {
      const pr = rest[0] && !rest[0].startsWith('-') ? prs.find(p => String(p.number) === rest[0].replace(/^#/, '')) : prs.find(p => p.head === head.branch);
      if (!pr) return { err: [rest[0] && !rest[0].startsWith('-') ? `GraphQL: Could not resolve to a PullRequest with the number of ${rest[0]}. (repository.pullRequest)` : `no pull requests found for branch "${head.branch}"`], code: 1 };
      if (verb === 'merge') return { err: [`X Pull request ${repoName}#${pr.number} is not mergeable: the base branch policy prohibits the merge.`, 'To have the pull request merged after all the requirements have been met, add the `--auto` flag.', 'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.'], code: 1 };
      if (verb === 'checks') return { out: ['Some checks are still pending', '0 cancelled, 0 failing, 1 successful, 0 skipped, and 2 pending checks', '', '*  ci/build     Running', '*  ci/test      Running', '✓  lint         8s'], code: 8 };
      return { out: [pr.title, `Open • ${user().email.split('@')[0]}-quillmart wants to merge 1 commit into ${pr.base} from ${pr.head} • about ${relative(ctx.t - pr.t)}`, 'Reviewers: none requested', '', ...(pr.body ? lines(pr.body).map(l => `  ${l}`) : ['  No description provided']), '', `View this pull request on GitHub: https://github.com/${repoName}/pull/${pr.number}`] };
    }
    return { err: [`unknown command "${verb ?? ''}" for "gh pr"`], code: 1 };
  };
  return git;
}

/** A git-style diff between two trees, restricted to paths `keep` accepts. */
function diffTrees(from, to, keep = () => true) {
  const out = [];
  for (const p of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    if (!keep(p) || from[p] === to[p]) continue;
    const added = !(p in from), removed = !(p in to);
    out.push(`diff --git a/${p} b/${p}`);
    if (added) out.push('new file mode 100644');
    if (removed) out.push('deleted file mode 100644');
    out.push(`index ${added ? '0000000' : blob(from[p]).slice(0, 7)}..${removed ? '0000000' : blob(to[p]).slice(0, 7)}${added || removed ? '' : ' 100644'}`);
    const body = unifiedDiff(added ? [] : lines(from[p]), removed ? [] : lines(to[p]), added ? '/dev/null' : `a/${p}`, removed ? '/dev/null' : `b/${p}`);
    out.push(...body);
  }
  return out;
}
/**
 * Applies a unified diff to `files` in place (reversed when asked). Returns the first path that
 * does not apply, or null. With `check`, nothing is changed.
 */
function patch(files, diff, reverse = false, check = false) {
  const staged = { ...files };
  let path = null, hunks = [], created = false, deleted = false;
  const sections = [];
  for (const l of lines(diff)) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(l);
    if (m) { if (path) sections.push({ path, hunks, created, deleted }); path = m[2]; hunks = []; created = false; deleted = false; continue; }
    if (l.startsWith('new file mode')) { created = true; continue; }
    if (l.startsWith('deleted file mode')) { deleted = true; continue; }
    if (l.startsWith('@@')) { hunks.push([]); continue; }
    if (hunks.length && /^[ +-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---')) hunks.at(-1).push(l);
  }
  if (path) sections.push({ path, hunks, created, deleted });
  for (const s of sections) {
    const adds = reverse ? '-' : '+', dels = reverse ? '+' : '-';
    if ((s.created && !reverse) || (s.deleted && reverse)) { staged[s.path] = s.hunks.flat().filter(l => l[0] === adds).map(l => `${l.slice(1)}\n`).join(''); continue; }
    if ((s.deleted && !reverse) || (s.created && reverse)) { if (!(s.path in staged)) return s.path; delete staged[s.path]; continue; }
    if (!(s.path in staged)) return s.path;
    let text = lines(staged[s.path]);
    for (const h of s.hunks) {
      const before = h.filter(l => l[0] === ' ' || l[0] === dels).map(l => l.slice(1));
      const after = h.filter(l => l[0] === ' ' || l[0] === adds).map(l => l.slice(1));
      let at = -1;
      for (let k = 0; k + before.length <= text.length; k++) if (before.every((l, j) => text[k + j] === l)) { at = k; break; }
      if (at < 0) return s.path;
      text = [...text.slice(0, at), ...after, ...text.slice(at + before.length)];
    }
    staged[s.path] = text.length ? `${text.join('\n')}\n` : '';
  }
  if (!check) { for (const k of Object.keys(files)) if (!(k in staged)) delete files[k]; Object.assign(files, staged); }
  return null;
}
function relative(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return 'less than a minute ago';
  if (s < 3600) { const m = Math.max(1, Math.round(s / 60)); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (s < 86400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
