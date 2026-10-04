import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "./sandbox.ts";

export interface TerminalAction {
  waitFor?: string;
  send?: string;
  hex?: string;
  resize?: [number, number];
  signal?: "SIGTERM" | "SIGINT" | "SIGHUP";
  replaceFile?: { path: string; text: string };
  checkpointTermios?: boolean;
}

/** Real PTY with split UTF-8 writes, resize, signals and independent termios custody. */
export async function runTerminalPty(box: Sandbox, argv: string[], actions: TerminalAction[], size: [number, number] = [12, 60], mode: "tty" | "stdin-pipe" | "stdout-pipe" = "tty", allowPendingInput = false) {
  const python = `import os, pty, select, subprocess, sys, json, time, errno, fcntl, termios, struct, signal
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
def resize(size):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', *size, 0, 0))
resize(json.loads(sys.argv[4]))
mode = sys.argv[5]
p = subprocess.Popen(json.loads(sys.argv[1]), stdin=subprocess.DEVNULL if mode == 'stdin-pipe' else slave, stdout=subprocess.PIPE if mode == 'stdout-pipe' else slave, stderr=slave, cwd=sys.argv[3], env=os.environ.copy())
steps = json.loads(sys.argv[2]); index = 0; pending = b''; output = b''; deadline = time.time() + 25
while time.time() < deadline:
    if select.select([master], [], [], .05)[0]:
        try: chunk = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO: break
            raise
        output += chunk; pending += chunk
    if index < len(steps) and (not steps[index].get('waitFor') or steps[index]['waitFor'].encode() in pending):
        step = steps[index]; time.sleep(.12)
        if step.get('checkpointTermios'):
            state = termios.tcgetattr(slave)
            sys.stderr.write('TERMIOS_CHECKPOINT=' + repr(state) + '\\nCHECKPOINT_LFLAG_XOR=' + str(before[3] ^ state[3]) + '\\n')
        if 'resize' in step:
            resize(step['resize']); p.send_signal(signal.SIGWINCH)
        if 'send' in step: os.write(master, step['send'].encode())
        if 'hex' in step: os.write(master, bytes.fromhex(step['hex']))
        if 'replaceFile' in step:
            with open(step['replaceFile']['path'], 'wb') as f: f.write(step['replaceFile']['text'].encode())
        if 'signal' in step: p.send_signal(getattr(signal, step['signal']))
        index += 1; pending = b''
    if p.poll() is not None:
        while select.select([master], [], [], .05)[0]:
            output += os.read(master, 65536)
        break
if p.poll() is None:
    p.kill(); p.wait(); sys.stderr.write('PTY timeout at action ' + str(index)); code = 124
else: code = p.wait()
after = termios.tcgetattr(slave)
if mode == 'stdout-pipe': output += p.stdout.read()
sys.stdout.buffer.write(output)
exact = before == after
normalized = after.copy()
# Scoped approval: Darwin's transient PENDIN is allowed ONLY for the zero-input rendering exception test.
if sys.platform == 'darwin' and sys.argv[6] == 'true': normalized[3] &= ~termios.PENDIN
expected = before.copy()
if sys.platform == 'darwin' and sys.argv[6] == 'true': expected[3] &= ~termios.PENDIN
sys.stdout.write('\\nPTY_TERMIOS_EXACT=' + str(exact) + '\\nPTY_TERMIOS_RESTORED=' + str(expected == normalized) + '\\n')
sys.stdout.write('TERMIOS_BEFORE=' + repr(before) + '\\nTERMIOS_AFTER=' + repr(after) + '\\nLFLAG_XOR=' + str(before[3] ^ after[3]) + '\\n')
os.close(master); os.close(slave)
sys.exit(code)
`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("python3", ["-c", python, JSON.stringify(argv), JSON.stringify(actions), box.projectDir, JSON.stringify(size), mode, JSON.stringify(allowPendingInput)], {
      env: { ...process.env, HOME: box.homeDir, PI_CODING_AGENT_DIR: box.agentDir, TMPDIR: os.tmpdir(), NPM_CONFIG_USERCONFIG: "/dev/null", TERM: "xterm-256color", FORCE_COLOR: "0" },
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
  });
  const logPath = path.join(os.tmpdir(), `copi-editor-pty-${randomUUID()}.log`);
  await writeFile(logPath, result.output);
  console.log(`PTY evidence: ${logPath}`);
  return { ...result, logPath };
}
