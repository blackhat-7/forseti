# Linux confinement, installed inside the interpreter before any candidate code runs.
# Landlock gives the same path allow-list as the macOS profile, so a denial surfaces as
# PermissionError exactly as it does under Seatbelt. seccomp removes what Landlock cannot express:
# new processes, running other programs, sockets and hard links. Any failure exits non-zero, so
# the sandbox self-check fails closed rather than running unconfined.
import ctypes, os, platform, struct

def confine(root, read_only):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    def check(result, what):
        if result < 0: raise SystemExit(f'sandbox: {what} failed: {os.strerror(ctypes.get_errno())}')
        return result
    # ABI 6 is the first that can scope signals, without which a trial could kill host processes.
    abi = libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    if abi < 6: raise SystemExit(f'sandbox: Landlock ABI 6 or newer is required, found {abi}')

    READ_FILE, WRITE_FILE, READ_DIR = 1 << 2, 1 << 1, 1 << 3
    READ = READ_FILE | READ_DIR
    # Everything a trial needs to edit its own files; no devices, sockets, FIFOs or execution.
    WRITE = WRITE_FILE | 1 << 4 | 1 << 5 | 1 << 7 | 1 << 8 | 1 << 12 | 1 << 13 | 1 << 14
    ruleset = struct.pack('QQQ', (1 << 16) - 1, 0b11, 0b11)  # every fs right; TCP bind+connect; abstract unix + signals
    fd = check(libc.syscall(444, ruleset, ctypes.c_size_t(len(ruleset)), ctypes.c_uint32(0)), 'landlock ruleset')
    rules = [(p, READ) for p in ('/usr', '/lib', '/lib64') if os.path.isdir(p)]
    rules += [('/dev/null', READ_FILE | WRITE_FILE), ('/dev/urandom', READ_FILE), ('/dev/random', READ_FILE)]
    rules.append((root, READ if read_only else READ | WRITE))
    for path, access in rules:
        target = os.open(path, os.O_PATH | os.O_CLOEXEC)
        rule = struct.pack('<Qi', access, target)
        check(libc.syscall(445, fd, 1, rule, ctypes.c_uint32(0)), f'landlock rule {path}')
        os.close(target)
    check(libc.prctl(38, 1, 0, 0, 0), 'no_new_privs')
    check(libc.syscall(446, fd, ctypes.c_uint32(0)), 'landlock restrict')
    os.close(fd)

    machine = platform.machine()
    if machine == 'x86_64':
        arch, clone, denied = 0xC000003E, 56, [57, 58, 59, 322, 41, 53, 86, 265, 101, 425, 310, 311, 272, 308]
    elif machine == 'aarch64':
        arch, clone, denied = 0xC00000B7, 220, [221, 281, 198, 199, 37, 117, 425, 270, 271, 97, 268]
    else:
        raise SystemExit(f'sandbox: no seccomp policy for {machine}')
    KILL, ALLOW, EPERM, ENOSYS = 0x80000000, 0x7FFF0000, 0x50000 | 1, 0x50000 | 38
    op = lambda code, k, jt=0, jf=0: struct.pack('HBBI', code, jt, jf, k)
    load, jeq, jge, jset, ret = (lambda k: op(0x20, k)), (lambda k, jt, jf: op(0x15, k, jt, jf)), (lambda k, jt, jf: op(0x35, k, jt, jf)), (lambda k, jt, jf: op(0x45, k, jt, jf)), (lambda k: op(0x06, k))
    prog = [load(4), jeq(arch, 1, 0), ret(KILL), load(0)]
    if machine == 'x86_64': prog += [jge(0x40000000, 0, 1), ret(KILL)]  # x32 numbers alias x86_64 ones
    for nr in denied: prog += [jeq(nr, 0, 1), ret(EPERM)]
    # ENOSYS, not EPERM, makes libc fall back to clone, whose flags a filter can inspect.
    prog += [jeq(435, 0, 1), ret(ENOSYS)]
    # Threads stay allowed; a clone without CLONE_THREAD is a new process.
    prog += [jeq(clone, 0, 4), load(16), jset(0x10000, 0, 1), ret(ALLOW), ret(EPERM), ret(ALLOW)]
    code = ctypes.create_string_buffer(b''.join(prog))
    class Program(ctypes.Structure): _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.c_void_p)]
    program = Program(len(prog), ctypes.addressof(code))
    check(libc.prctl(22, 2, ctypes.byref(program), 0, 0), 'seccomp')
