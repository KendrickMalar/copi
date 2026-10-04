import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { importResource, loadCatalog, prepareResource, saveCatalog } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";

export async function sandbox(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-names-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(root, "project");
  const sourceRoot = path.join(root, "source");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir), mkdir(sourceRoot)]);
  return { root, homeDir, agentDir, projectDir, sourceRoot, libraryDir: path.join(homeDir, ".copi") };
}
export type Sandbox = Awaited<ReturnType<typeof sandbox>>;

export async function addItem(box: Sandbox, name: string) {
  const sourcePath = path.join(box.sourceRoot, randomUUID());
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, "SKILL.md"), "# Original name\napiKey: sk_live_syntheticsecret12345\n");
  const candidate = {
    id: sourcePath, kind: "skill", source: "synthetic", scope: "project",
    sourceRoot: box.sourceRoot, sourcePath, name,
    destination: { kind: "project" as const, path: `.pi/skills/${path.basename(sourcePath)}` },
  } as const;
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importResource(box.libraryDir, candidate, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  return item;
}

export async function duplicateFixture(box: Sandbox) {
  const first = await addItem(box, "Straße");
  const second = await addItem(box, "Other");
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups = [
    { id: "daily", name: "Daily", itemIds: [first.id, second.id] },
    { id: "review", name: "Review", itemIds: [first.id] },
  ];
  await saveCatalog(box.libraryDir, catalog);
  catalog.items.find((item) => item.id === second.id)!.name = " STRASSE ";
  catalog.groups[1]!.name = "ＤＡＩＬＹ";
  // Existing duplicate data is installed directly, not via a new registration API.
  await writeFile(path.join(box.libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return { first, second, catalog };
}

export interface PtyAction { waitFor: string; send: string }

// Use the real clack prompts on a local PTY, not prompt mocks.
export async function runPty(box: Sandbox, argv: string[], actions: PtyAction[]) {
  const python = `import os, pty, select, subprocess, sys, json, time, errno, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
p = subprocess.Popen(json.loads(sys.argv[1]), stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[3], env=os.environ.copy())
os.close(slave)
steps = json.loads(sys.argv[2]); index = 0; pending = b''; output = b''; deadline = time.time() + 20
while time.time() < deadline:
    if select.select([master], [], [], .05)[0]:
        try: chunk = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO: break
            raise
        if not chunk: break
        output += chunk; pending += chunk
    if index < len(steps) and steps[index]['waitFor'].encode() in pending:
        time.sleep(.1)
        os.write(master, steps[index]['send'].encode()); index += 1; pending = b''
    if p.poll() is not None: break
if p.poll() is None:
    try: p.wait(timeout=.5)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait(); sys.stdout.buffer.write(output); sys.stderr.write('PTY timeout at action ' + str(index)); sys.exit(124)
os.close(master)
sys.stdout.buffer.write(output)
sys.exit(p.wait())
`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("python3", ["-c", python, JSON.stringify(argv), JSON.stringify(actions), box.projectDir], {
      env: { ...process.env, HOME: box.homeDir, PI_CODING_AGENT_DIR: box.agentDir,
        TMPDIR: os.tmpdir(), NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE,
        NPM_CONFIG_USERCONFIG: "/dev/null", TERM: "xterm-256color", FORCE_COLOR: "0" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  const logPath = path.join(os.tmpdir(), `copi-pty-${randomUUID()}.log`);
  await writeFile(logPath, result.output);
  console.log(`PTY evidence: ${logPath}`);
  return { ...result, logPath };
}
