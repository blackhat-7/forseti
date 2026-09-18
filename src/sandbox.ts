import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { inside, localDir, put } from './files.ts';
import type { PythonResult } from './types.ts';

let pythonPath: string | undefined;
export function pythonExecutable(): string {
  if (pythonPath) return pythonPath;
  const found = spawnSync('/usr/bin/which', ['python3'], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error('Python 3 is required');
  pythonPath = realpathSync(found.stdout.trim());
  // Homebrew's framework launcher spawns Python.app; invoke the interpreter directly
  // so candidate code never needs process-fork permission.
  const frameworkBinary = resolve(dirname(pythonPath), '../Resources/Python.app/Contents/MacOS/Python');
  if (existsSync(frameworkBinary)) pythonPath = realpathSync(frameworkBinary);
  if (!pythonPath.startsWith('/opt/homebrew/') && !pythonPath.startsWith('/usr/') && !pythonPath.startsWith('/Library/')) {
    throw new Error('Python must be installed in /opt/homebrew, /usr or /Library for the sandbox');
  }
  return pythonPath;
}
export function sandboxProfile(root: string, readOnly = false): string {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Fail closed: this release requires macOS sandbox-exec. No unsandboxed fallback.');
  }
  const resolved = realpathSync(root);
  const runtimeRoots = ['/System', '/usr/lib', '/usr/share', '/Library/Frameworks', '/Library/Developer', '/opt/homebrew/Cellar'];
  if (runtimeRoots.some(path => resolved === path || resolved.startsWith(`${path}/`))) throw new Error('Trial workspaces cannot be inside a system runtime read root');
  const literal = JSON.stringify(resolved);
  return `(version 1)
(deny default)
(allow process-exec (literal ${JSON.stringify(pythonExecutable())}))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")
 (subpath "/Library/Frameworks") (subpath "/Library/Developer") (subpath "/opt/homebrew/Cellar")
 (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
 (literal "/private/etc/localtime") (subpath ${literal}))
(allow file-write* ${readOnly ? '' : `(subpath ${literal})`} (literal "/dev/null"))`;
}

/** Untrusted code receives no host environment, network, child processes, or private suite files. */
export async function runPython(root: string, source: string, signal?: AbortSignal, timeoutMs = 5000, readOnly = false): Promise<PythonResult> {
  root = realpathSync(root);
  inside(root, '.');
  if (Buffer.byteLength(source) > 128 * 1024) throw new Error('Python input exceeds 128 KiB');
  if (signal?.aborted) return { stdout: '', stderr: 'Cancelled', code: null, timedOut: true };
  const profile = sandboxProfile(root, readOnly);
  // The limits are installed before candidate code, which cannot raise the hard limits.
  const bootstrap = `import os,sys,resource\nresource.setrlimit(resource.RLIMIT_CPU,(3,3))\nresource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576))\nresource.setrlimit(resource.RLIMIT_NOFILE,(64,64))\nsys.path.insert(0,os.getcwd())\nexec(compile(sys.stdin.read(),'<trial>','exec'))`;
  return await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, pythonExecutable(), '-I', '-B', '-c', bootstrap], {
      cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, TMP: root, TEMP: root, PYTHONDONTWRITEBYTECODE: '1', LC_ALL: 'en_US.UTF-8' },
    });
    let stdout = '', stderr = '', timedOut = false, size = 0;
    const kill = () => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    const consume = (data: Buffer, error: boolean) => {
      size += data.length;
      if (size > 256 * 1024) { kill(); return; }
      if (error) stderr += data.toString(); else stdout += data.toString();
    };
    child.stdout.on('data', (d: Buffer) => consume(d, false));
    child.stderr.on('data', (d: Buffer) => consume(d, true));
    child.on('error', reject);
    child.stdin.on('error', () => { /* Exit/abort can close stdin before all source is consumed. */ });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      // Kill any descendant still in the group, including on a normal parent exit.
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Group is already gone. */ }
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(source);
  });
}

export async function checkSandbox(workspace: string): Promise<string> {
  const probe = localDir(workspace, `.state/probes/${randomUUID()}`);
  put(probe, 'secret.txt', 'hidden verifier sentinel');
  const root = localDir(probe, 'public');
  let result;
  try {
    result = await runPython(root, `import json,socket,pathlib,subprocess,platform\nchecks=[]\nfor f in [lambda:pathlib.Path('../secret.txt').read_text(),lambda:pathlib.Path('../escape.txt').write_text('no'),lambda:socket.create_connection(('127.0.0.1',9),timeout=.2),lambda:subprocess.run(['/usr/bin/true'],check=True)]:\n try:f();checks.append(False)\n except PermissionError:checks.append(True)\nprint(json.dumps({'checks':checks,'python':platform.python_version()}))`);
  } finally { rmSync(probe, { recursive: true, force: true }); }
  let probeResult;
  try { probeResult = JSON.parse(result.stdout); } catch { /* Report failed probes below. */ }
  if (result.code !== 0 || JSON.stringify(probeResult?.checks) !== '[true,true,true,true]' || typeof probeResult?.python !== 'string') {
    throw new Error(`Sandbox self-check failed: ${result.stderr || result.stdout}. No benchmark executed.`);
  }
  return probeResult.python;
}
