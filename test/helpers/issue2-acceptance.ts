import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertModernCatalog, importResource, loadCatalog, prepareResource, saveCatalog, type PreparedInspection } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";
import type { ResourceCandidate, ResourceKind } from "../../src/types.ts";

// No developer HOME, installed CLI, shared prompt mocks, or /tmp planning files.
export async function acceptanceBox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-issue2-acceptance-"));
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "project");
  const source = path.join(root, "source");
  const tmp = path.join(root, "tmp");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(project), mkdir(source), mkdir(tmp)]);
  console.log(`Acceptance fixture retained: ${root}`);
  return { root, home, agent, project, source, tmp, library: path.join(home, ".copi") };
}
export type AcceptanceBox = Awaited<ReturnType<typeof acceptanceBox>>;

export const secret = "sk_live_independentfixture1234567890";
export async function candidate(box: AcceptanceBox, name: string, kind: ResourceKind = "skill"): Promise<ResourceCandidate> {
  const token = randomUUID();
  const resourceRoot = path.join(box.source, token);
  let sourcePath: string;
  let destinationPath: string;
  if (kind === "skill") {
    sourcePath = resourceRoot;
    await mkdir(path.join(sourcePath, "nested"), { recursive: true });
    await writeFile(path.join(sourcePath, "SKILL.md"), `# Original Straße / ①\napiKey: ${secret}\n`);
    await writeFile(path.join(sourcePath, "nested", "notes.txt"), "e\u0301\nUNCHANGED content\n");
    await writeFile(path.join(sourcePath, "asset.bin"), Buffer.from([0, 255, 1, 128]));
    destinationPath = `.pi/skills/${token}`;
  } else {
    await mkdir(resourceRoot, { recursive: true });
    sourcePath = path.join(resourceRoot, "SKILL.md");
    await writeFile(sourcePath, `# Original Straße / ①\napiKey: ${secret}\n`);
    destinationPath = kind === "subagent" ? `.pi/agents/${token}.md` : `${token}.md`;
  }
  return { id: token, name, kind, source: "independent-acceptance", scope: "project", sourceRoot: box.source,
    sourcePath, destination: { kind: "project", path: destinationPath } };
}
export function fixtureImportOptions(inspection: PreparedInspection, groupIds: string[] = []) {
  // Only this fixture's known, fictional secret is approved, at its concrete file path.
  // Fail rather than silently approving any newly detected sensitive file.
  assert.deepEqual(inspection.sensitivePaths, ["SKILL.md"]);
  return { confirmed: true, groupIds, inspection, approvedSensitivePaths: ["SKILL.md"] };
}
export async function add(box: AcceptanceBox, name: string, kind: ResourceKind = "skill") {
  const input = await candidate(box, name, kind);
  const prepared = await prepareResource(input);
  const inspection = await inspectPreparedResource(prepared);
  // A structural variable also compiles against the older ImportOptions contract.
  const options = fixtureImportOptions(inspection);
  const item = await importResource(box.library, input, options);
  assert.ok(item);
  return item;
}

// Capture every byte, directory and symlink without following symlinks.
// This detects orphan copies as well as accidental catalog/source/target changes.
export async function treeBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(target: string, relative: string): Promise<void> {
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) { result[relative] = "absent"; return; }
    if (stat.isSymbolicLink()) { result[relative] = `link:${await readlink(target)}`; return; }
    if (stat.isDirectory()) {
      result[relative] = "directory";
      for (const entry of (await readdir(target)).sort()) await visit(path.join(target, entry), path.posix.join(relative, entry));
    } else result[relative] = (await readFile(target)).toString("base64");
  }
  await visit(root, ".");
  return result;
}
export async function legacy(box: AcceptanceBox) {
  const items = [];
  for (const name of ["① Kit", "temporary-one", "ΟΣ", "temporary-two", "safe"]) items.push(await add(box, name));
  const catalog = await loadCatalog(box.library);
  assertModernCatalog(catalog);
  catalog.groups = [
    { id: "day-a", name: "Daily", itemIds: items.map((item) => item.id) },
    { id: "day-b", name: "temporary-day", itemIds: [items[0]!.id, items[4]!.id] },
    { id: "cafe-a", name: "Café", itemIds: [items[2]!.id] },
    { id: "cafe-b", name: "temporary-cafe", itemIds: [items[1]!.id, items[3]!.id] },
    { id: "safe-team", name: "safe-team", itemIds: [items[4]!.id] },
  ];
  await saveCatalog(box.library, catalog);
  catalog.items[1]!.name = " 1 KIT ";
  catalog.items[3]!.name = "ος";
  catalog.groups[1]!.name = "ＤＡＩＬＹ";
  catalog.groups[3]!.name = "Cafe\u0301";
  // Old data is deliberately installed outside all new registration APIs.
  await writeFile(path.join(box.library, "catalog.json"), `  ${JSON.stringify(catalog)}  \n\n`);
  return catalog;
}
const sourceTest = import.meta.url.endsWith(".ts");
export const cli = fileURLToPath(new URL(sourceTest ? "../../src/cli.ts" : "../../src/cli.js", import.meta.url));
export function wizardArgv(box: AcceptanceBox) {
  const url = new URL(sourceTest ? "../../src/wizard.ts" : "../../src/wizard.js", import.meta.url).href;
  return [process.execPath, ...(sourceTest ? ["--experimental-transform-types"] : []), "--input-type=module", "-e", `import {resolveNameConflicts} from ${JSON.stringify(url)}; await resolveNameConflicts(${JSON.stringify(box.library)});`];
}
function childEnvironment(box: AcceptanceBox) {
  return { ...process.env, HOME: box.home, PI_CODING_AGENT_DIR: box.agent, TMPDIR: box.tmp,
    NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? path.join(box.root, "npm-cache"),
    NPM_CONFIG_USERCONFIG: "/dev/null", TERM: "xterm-256color", FORCE_COLOR: "0" };
}
export async function cliPipe(box: AcceptanceBox, args: string[]) {
  return runChild(box, process.execPath, [cli, ...args]);
}
async function runChild(box: AcceptanceBox, command: string, args: string[]) {
  const childArgs = command === process.execPath && sourceTest && args[0] !== "--experimental-transform-types"
    ? ["--experimental-transform-types", ...args]
    : args;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, childArgs, { cwd: box.project, env: childEnvironment(box) });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
  const log = path.join(box.root, `command-${randomUUID()}.log`);
  await writeFile(log, JSON.stringify({ command, args, code: result.code }) + "\n" + result.output);
  console.log(`Acceptance command evidence: ${log}`);
  return { ...result, log };
}
export interface Action { waitFor: string; send: string }
export async function realPty(box: AcceptanceBox, argv: string[], actions: Action[]) {
  // Python stdlib only. The actual compiled CLI/wizard and actual clack run on a PTY.
  const driver = `import os,pty,select,subprocess,sys,json,time,errno,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,140,0,0))
p=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,cwd=sys.argv[3],env=os.environ.copy())
os.close(slave)
steps=json.loads(sys.argv[2]); index=0; pending=b''; output=b''; deadline=time.monotonic()+30
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   if not chunk: break
   output+=chunk; pending+=chunk
  if index<len(steps) and steps[index]['waitFor'].encode() in pending:
   time.sleep(.12)
   os.write(master,steps[index]['send'].encode()); index+=1; pending=b''
  if p.poll() is not None: break
 if p.poll() is None:
  try: p.wait(timeout=.5)
  except subprocess.TimeoutExpired:
   p.kill(); p.wait(); sys.stderr.write('PTY timeout at action '+str(index)+'\\n')
   sys.stdout.buffer.write(output); sys.exit(124)
 sys.stdout.buffer.write(output)
 sys.stderr.write('\\nPTY actions '+str(index)+'/'+str(len(steps))+'\\n')
 sys.exit(p.returncode if index==len(steps) else 125)
finally:
 os.close(master)
`;
  const childArgv = sourceTest && argv[0] === process.execPath && argv[1] !== "--experimental-transform-types"
    ? [argv[0]!, "--experimental-transform-types", ...argv.slice(1)]
    : argv;
  return runChild(box, "python3", ["-c", driver, JSON.stringify(childArgv), JSON.stringify(actions), box.project]);
}
export const choose = { waitFor: "Select a conflicting name to rename", send: "\r" };
export function renameSteps(names: string[]): Action[] {
  return names.flatMap((name) => [choose, { waitFor: "New name for", send: `${name}\r` }]);
}
export function assertOnlyNames(before: Awaited<ReturnType<typeof loadCatalog>>, after: Awaited<ReturnType<typeof loadCatalog>>) {
  const restored = structuredClone(after);
  restored.items.forEach((item, index) => { item.name = before.items[index]!.name; });
  restored.groups.forEach((group, index) => { group.name = before.groups[index]!.name; });
  assert.deepEqual(restored, before);
}
