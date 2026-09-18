"""Actual PTY smoke test. All artifacts and temporary state stay in the workspace."""
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
config = ROOT / 'forseti.json'
original = config.read_bytes()
state = json.loads(original)
for model in state['models']:
    model['enabled'] = model['provider'] == 'control'
state['disabledTests'] = []
state['removedTests'] = []
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 110, 0, 0))
output = bytearray()
process = None

def collect(seconds=0.4):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        ready, _, _ = select.select([master], [], [], min(0.1, max(0, until-time.monotonic())))
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)

def send(keys):
    os.write(master, keys.encode())
    collect()

try:
    config.write_text(json.dumps(state, indent=2) + '\n')
    env = {**os.environ, 'TERM': 'xterm-256color', 'TMPDIR': str(ROOT / '.tmp'), 'PYTHONDONTWRITEBYTECODE': '1'}
    env.pop('PI_TUI_WRITE_LOG', None)
    process = subprocess.Popen([shutil.which('node'), 'src/cli.ts'], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    collect(1)
    assert b'forseti' in output, 'TUI did not mount'
    send('2')
    assert b'control/reference' in output, 'Model view did not open'
    send('\x1b[B')
    send('3')
    assert b'shared-count' in output, 'Test view did not open'
    send('1r')
    # Terminal packets can contain multiple keys; send separate normal key events.
    if b'Preflight' not in output:
        send('1')
        send('r')
    assert b'Preflight' in output, 'Preflight did not open'
    send('\r')
    # Wait on the outcome, not on a fixed tick count: a hardcoded budget silently becomes a
    # failing test every time the suite grows a task.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and b'Run completed' not in output:
        collect(0.3)
    assert b'Run completed' in output, 'Synthetic run did not finish in the TUI'
    send('c')
    assert b'Scorecard' in output, 'Comparison summary did not open'
    send('\x1b')
    send('e')
    assert b'Exported' in output, 'Report export failed'
    send('\r')
    assert b'Evidence' in output, 'Evidence view did not open'
    send('\x1b')
    send('q')
    process.wait(timeout=5)
    assert process.returncode == 0, f'TUI exited {process.returncode}'
    print('PASS: actual PTY navigation → preflight → all isolated controls → comparison → export → evidence → clean exit')
finally:
    if process and process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    config.write_bytes(original)
    (ROOT / '.cache').mkdir(exist_ok=True)
    (ROOT / '.cache/tui-pty.ansi').write_bytes(output)
    os.close(master)
