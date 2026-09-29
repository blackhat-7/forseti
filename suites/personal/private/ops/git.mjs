/**
 * `git` for the checkout the operator is standing in.
 *
 *   makeGit(ctx, { branch, remote, initial, log: [{ sha, author, email, t, subject, body?, diff }] })
 *   `initial` maps each workspace path to its text when the session began.
 *   `log` is newest first; `t` is virtual seconds (negative = before the session); `diff` is the
 *   commit's unified diff as text, `diff --git` headers included. The working tree is the task
 *   workspace: `status` and `diff` compare it with the files as the session found them.
 */
import { lines, unifiedDiff } from './shell.mjs';
import { hashString } from './kubectl.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const gitDate = (d) => `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCFullYear()} +0000`;

export function makeGit(ctx, { branch = 'main', remote = 'git@github.com:quillmart/infra.git', initial, log }) {
  const snapshot = { ...initial };
  const staged = new Set();
  let current = branch;
  const commits = log.map(c => ({ ...c }));
  ctx.repository = { branch, remote, commits, at: (t) => ctx.at(t).toISOString(), user: () => ({ name: 'On-call Engineer', email: `${ctx.shell?.env.USER ?? 'oncall'}@quillmart.com` }) };
  const base = () => snapshot;
  const resolve = (spec = 'HEAD') => {
    const m = /^(?:HEAD|@|main|origin\/main)(?:~(\d+)|\^+)?$/.exec(spec);
    if (m) return commits[m[1] ? Number(m[1]) : spec.includes('^') ? spec.split('^').length - 1 : 0];
    return commits.find(c => c.sha.startsWith(spec) && spec.length >= 4);
  };
  const changes = () => {
    const before = base(), now = Object.fromEntries(ctx.shell.fs.list().map(p => [p, ctx.shell.fs.read(p)]));
    const modified = Object.keys(before).filter(p => p in now && now[p] !== before[p]).sort();
    const deleted = Object.keys(before).filter(p => !(p in now)).sort();
    const untracked = Object.keys(now).filter(p => !(p in before)).sort();
    return { before, now, modified, deleted, untracked };
  };
  const workDiff = (paths) => {
    const { before, now, modified, deleted } = changes();
    const out = [];
    for (const p of [...modified, ...deleted].sort()) {
      if (paths.length && !paths.some(q => p === q || p.startsWith(`${q.replace(/\/$/, '')}/`))) continue;
      const a = lines(before[p]), b = p in now ? lines(now[p]) : [];
      out.push(`diff --git a/${p} b/${p}`);
      if (!(p in now)) out.push('deleted file mode 100644');
      out.push(`index ${(hashString(before[p]) >>> 0).toString(16).padStart(7, '0').slice(0, 7)}..${p in now ? (hashString(now[p]) >>> 0).toString(16).padStart(7, '0').slice(0, 7) : '0000000'} 100644`);
      out.push(...unifiedDiff(a, b, `a/${p}`, p in now ? `b/${p}` : '/dev/null'));
    }
    return out;
  };
  const statOf = (diff) => {
    const files = [];
    let cur = null;
    for (const l of diff) {
      const m = /^diff --git a\/(\S+) b\//.exec(l);
      if (m) { cur = { path: m[1], add: 0, del: 0 }; files.push(cur); continue; }
      if (!cur || l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) cur.add++; else if (l.startsWith('-')) cur.del++;
    }
    const width = Math.max(...files.map(f => f.path.length), 0);
    const out = files.map(f => ` ${f.path.padEnd(width)} | ${String(f.add + f.del).padStart(3)} ${'+'.repeat(Math.min(f.add, 40))}${'-'.repeat(Math.min(f.del, 40))}`);
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0);
    out.push(` ${files.length} file${files.length === 1 ? '' : 's'} changed${add ? `, ${add} insertion${add === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}`);
    return out;
  };
  const header = (c, fmt) => {
    if (fmt === 'oneline') return [`${c.sha.slice(0, 7)} ${c === commits[0] ? `(HEAD -> ${current}, origin/main, origin/HEAD) ` : ''}${c.subject}`];
    return [`commit ${c.sha}${c === commits[0] ? ` (HEAD -> ${current}, origin/main, origin/HEAD)` : ''}`, `Author: ${c.author} <${c.email}>`, `Date:   ${gitDate(ctx.at(c.t))}`, '', `    ${c.subject}`, ...(c.body ? ['', ...lines(c.body).map(l => (l ? `    ${l}` : ''))] : []), ''];
  };
  const pretty = (c, spec) => spec.replace(/%H/g, c.sha).replace(/%h/g, c.sha.slice(0, 7)).replace(/%s/g, c.subject).replace(/%an/g, c.author).replace(/%ae/g, c.email).replace(/%ad|%ai|%ci|%cd/g, gitDate(ctx.at(c.t))).replace(/%ar|%cr/g, relative(ctx.t - c.t)).replace(/%n/g, '\n');
  return function git(argv) {
    const args = [...argv];
    while (args[0] === '-C' || args[0] === '--no-pager' || args[0] === '-c') { if (args[0] === '--no-pager') args.shift(); else args.splice(0, 2); }
    const [sub, ...rest] = args;
    ctx.wait(1);
    const flag = (name) => rest.includes(name);
    const dashdash = rest.indexOf('--');
    const paths = dashdash >= 0 ? rest.slice(dashdash + 1) : [];
    switch (sub) {
      case undefined: return { out: ['usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]', '           <command> [<args>]'], code: 1 };
      case 'log': {
        let n = Infinity;
        let fmt = null;
        for (let k = 0; k < rest.length; k++) {
          const a = rest[k];
          if (/^-\d+$/.test(a)) n = Number(a.slice(1));
          else if (a === '-n') n = Number(rest[++k]);
          else if (/^--max-count=/.test(a)) n = Number(a.split('=')[1]);
          else if (a === '--oneline' || a === '--pretty=oneline' || a === '--format=oneline') fmt = 'oneline';
          else if (/^--(pretty|format)=/.test(a)) fmt = a.slice(a.indexOf('=') + 1).replace(/^(format|tformat):/, '');
        }
        const filter = paths.length ? paths : rest.filter((a, k) => !a.startsWith('-') && rest[k - 1] !== '-n' && !/^\d+$/.test(a) && dashdash < 0 && !resolve(a));
        let list = commits.filter(c => !filter.length || filter.some(p => c.diff.includes(` a/${p.replace(/\/$/, '')}`)));
        const start = rest.find(a => !a.startsWith('-') && resolve(a));
        if (start) list = list.slice(Math.max(0, list.indexOf(resolve(start))));
        list = list.slice(0, n);
        const out = [];
        for (const c of list) {
          if (fmt && fmt !== 'oneline') out.push(...pretty(c, fmt).split('\n'));
          else out.push(...header(c, fmt));
          if (flag('--stat')) out.push(...statOf(lines(c.diff)), ...(fmt === 'oneline' ? [] : ['']));
          if (flag('-p') || flag('--patch')) out.push(...lines(c.diff), ...(fmt === 'oneline' ? [] : ['']));
        }
        if (out.at(-1) === '') out.pop();
        return { out };
      }
      case 'show': {
        const spec = rest.find(a => !a.startsWith('-')) ?? 'HEAD';
        if (spec.includes(':')) {
          const [rev, file] = spec.split(':');
          if (!resolve(rev)) return { err: [`fatal: invalid object name '${rev}'.`], code: 128 };
          const text = base()[file];
          return text === undefined ? { err: [`fatal: path '${file}' does not exist in '${rev}'`], code: 128 } : { out: lines(text) };
        }
        const c = resolve(spec);
        if (!c) return { err: [`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`, "Use '--' to separate paths from revisions, like this:", "'git <command> [<revision>...] -- [<file>...]'"], code: 128 };
        if (flag('--stat')) return { out: [...header(c), ...statOf(lines(c.diff))] };
        if (flag('--name-only')) return { out: [...header(c), ...lines(c.diff).filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1])] };
        return { out: [...header(c), ...lines(c.diff)] };
      }
      case 'status': {
        const { modified, deleted, untracked } = changes();
        if (flag('-s') || flag('--short') || flag('--porcelain')) return { out: [...modified.map(p => `${staged.has(p) ? 'M ' : ' M'} ${p}`), ...deleted.map(p => ` D ${p}`), ...untracked.map(p => `?? ${p}`)] };
        const out = [`On branch ${current}`, current === branch ? `Your branch is up to date with 'origin/${branch}'.` : '', ''];
        const stagedList = modified.filter(p => staged.has(p));
        if (stagedList.length) out.push('Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', ...stagedList.map(p => `\tmodified:   ${p}`), '');
        const unstaged = [...modified.filter(p => !staged.has(p)).map(p => `\tmodified:   ${p}`), ...deleted.map(p => `\tdeleted:    ${p}`)];
        if (unstaged.length) out.push('Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...unstaged, '');
        if (untracked.length) out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)', ...untracked.map(p => `\t${p}`), '');
        if (!stagedList.length && !unstaged.length && !untracked.length) out.push('nothing to commit, working tree clean');
        else if (!stagedList.length) out.push('no changes added to commit (use "git add" and/or "git commit -a")');
        return { out: out.filter((l, k) => !(l === '' && k === 1)) };
      }
      case 'diff': {
        if (flag('--cached') || flag('--staged')) { const d = workDiff(paths).join('\n'); return { out: d ? lines(d).filter(() => true) : [] }; }
        const revs = rest.filter(a => !a.startsWith('-') && dashdash < 0 && resolve(a));
        if (revs.length) { const c = resolve(revs[0]); return { out: c === commits[0] ? workDiff(paths) : lines(commits.slice(0, commits.indexOf(c)).map(x => x.diff).join('\n')) }; }
        const filePaths = paths.length ? paths : rest.filter(a => !a.startsWith('-'));
        const d = workDiff(filePaths);
        return { out: flag('--stat') ? (d.length ? statOf(d) : []) : flag('--name-only') ? d.filter(l => l.startsWith('diff --git')).map(l => l.split(' b/')[1]) : d };
      }
      case 'add': {
        const { modified, untracked } = changes();
        const targets = rest.filter(a => !a.startsWith('-'));
        for (const p of [...modified, ...untracked]) if (flag('-A') || flag('--all') || targets.some(t => t === '.' || p === t || p.startsWith(`${t.replace(/\/$/, '')}/`))) staged.add(p);
        return {};
      }
      case 'commit': {
        const { modified, untracked, now } = changes();
        if (flag('-a') || flag('-am')) for (const p of modified) staged.add(p);
        const toCommit = [...modified, ...untracked].filter(p => staged.has(p));
        const msgAt = rest.findIndex(a => a === '-m' || a === '-am');
        if (!toCommit.length) return { out: [`On branch ${current}`, 'nothing to commit, working tree clean'], code: 1 };
        if (msgAt < 0) return { err: ['hint: Waiting for your editor to close the file...', 'error: There was a problem with the editor \'vi\'.', 'Please supply the message using either -m or -F option.'], code: 1 };
        const subject = rest[msgAt + 1] ?? '';
        const diff = workDiff(toCommit.filter(p => p in base())).join('\n');
        const sha = (hashString(subject + diff + ctx.t).toString(16) + hashString(diff).toString(16) + hashString(subject).toString(16) + '0'.repeat(40)).slice(0, 40);
        commits.unshift({ sha, author: 'On-call Engineer', email: `${ctx.shell.env.USER}@quillmart.com`, t: ctx.t, subject, diff });
        for (const p of toCommit) { snapshot[p] = now[p]; staged.delete(p); }
        ctx.event('git.commit', { subject, files: toCommit });
        return { out: [`[${current} ${sha.slice(0, 7)}] ${subject}`, ...statOf(lines(diff)).slice(-1)] };
      }
      case 'push': {
        ctx.wait(3);
        ctx.event('git.push', { branch: current });
        if (current === branch || rest.includes(branch)) return { err: ['Enumerating objects: 9, done.', 'Counting objects: 100% (9/9), done.', 'Delta compression using up to 4 threads', 'Compressing objects: 100% (4/4), done.', 'Writing objects: 100% (5/5), 512 bytes | 512.00 KiB/s, done.', 'Total 5 (delta 3), reused 0 (delta 0), pack-reused 0', 'remote: error: GH006: Protected branch update failed for refs/heads/main.', 'remote: error: Changes must be made through a pull request.', `To ${remote.replace('git@github.com:', 'github.com:')}`, ` ! [remote rejected] ${current} -> ${current} (protected branch hook declined)`, `error: failed to push some refs to '${remote}'`], code: 1 };
        return { err: ['Enumerating objects: 9, done.', 'Writing objects: 100% (5/5), 512 bytes | 512.00 KiB/s, done.', 'remote:', `remote: Create a pull request for '${current}' on GitHub by visiting:`, `remote:      https://github.com/quillmart/infra/pull/new/${current}`, 'remote:', `To ${remote}`, ` * [new branch]      ${current} -> ${current}`] };
      }
      case 'pull': case 'fetch': ctx.wait(2); return sub === 'pull' ? { out: ['Already up to date.'] } : {};
      case 'branch': return { out: flag('-a') ? [`* ${current}`, ...(current !== branch ? [`  ${branch}`] : []), '  remotes/origin/HEAD -> origin/main', '  remotes/origin/main'] : [`* ${current}`, ...(current !== branch ? [`  ${branch}`] : [])] };
      case 'checkout': case 'switch': {
        const create = rest.indexOf('-b') >= 0 ? rest.indexOf('-b') : rest.indexOf('-c');
        if (create >= 0) { current = rest[create + 1]; return { err: [`Switched to a new branch '${current}'`] }; }
        const target = rest.find(a => !a.startsWith('-'));
        if (target === branch || target === current) { current = target; return { err: [`Already on '${target}'`] }; }
        if (target && base()[target] !== undefined) { ctx.shell.fs.write(target, base()[target]); return { err: [`Updated 1 path from the index`] }; }
        return { err: [`error: pathspec '${target}' did not match any file(s) known to git`], code: 1 };
      }
      case 'restore': {
        for (const p of rest.filter(a => !a.startsWith('-'))) if (base()[p] !== undefined) ctx.shell.fs.write(p, base()[p]);
        return {};
      }
      case 'remote': return { out: flag('-v') ? [`origin\t${remote} (fetch)`, `origin\t${remote} (push)`] : ['origin'] };
      case 'rev-parse': {
        if (flag('--abbrev-ref')) return { out: [current] };
        if (flag('--show-toplevel')) return { out: [ctx.shell.home] };
        const c = resolve(rest.find(a => !a.startsWith('-')) ?? 'HEAD');
        return c ? { out: [flag('--short') ? c.sha.slice(0, 7) : c.sha] } : { err: ['fatal: ambiguous argument: unknown revision or path not in the working tree.'], code: 128 };
      }
      case 'blame': {
        const file = rest.find(a => !a.startsWith('-'));
        const text = file ? ctx.shell.readFile(file) : null;
        if (text === null) return { err: [`fatal: no such path '${file}' in HEAD`], code: 128 };
        const owner = commits.find(c => c.diff.includes(` a/${file}`)) ?? commits.at(-1);
        return { out: lines(text).map((l, k) => `${owner.sha.slice(0, 8)} (${owner.author.padEnd(16)} ${ctx.at(owner.t).toISOString().slice(0, 19).replace('T', ' ')} +0000 ${String(k + 1).padStart(3)}) ${l}`) };
      }
      case 'stash': return { out: ['No local changes to save'] };
      case 'version': case '--version': return { out: ['git version 2.39.5'] };
      default: return { err: [`git: '${sub}' is not a git command. See 'git --help'.`], code: 1 };
    }
  };
}
function relative(seconds) {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
