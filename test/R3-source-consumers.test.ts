import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { importResource, loadCatalog, newCatalog, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange, readSavedEdit } from "../src/resource-mutations.ts";
import { runGroupManager, runSetup } from "../src/wizard.ts";
import type { ResourceCandidate } from "../src/types.ts";

interface Box {
  root: string;
  home: string;
  agent: string;
  project: string;
  library: string;
}

async function box(t: test.TestContext): Promise<Box> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-r3-source-consumers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "project");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(project)]);
  return { root, home, agent, project, library: path.join(home, ".copi") };
}

function runCli(b: Box, args: string[]) {
  return spawnSync(process.execPath, ["--experimental-transform-types", path.resolve("src/cli.ts"), ...args], {
    cwd: b.project,
    env: { ...process.env, HOME: b.home, PI_CODING_AGENT_DIR: b.agent },
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function writeLegacyLibrary(b: Box): Promise<{ id: string; catalogBytes: Buffer; fileBytes: Buffer }> {
  const id = "00000000-0000-4000-8000-000000000001";
  const fileBytes = Buffer.from("# Legacy saved copy\nread only\n");
  const filePath = path.join(b.library, "items", id, "files", "legacy.md");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, fileBytes, { mode: 0o600 });
  const catalog = {
    version: 1,
    items: [{
      id,
      kind: "instruction",
      source: "legacy-fixture",
      scope: "project",
      sourcePath: path.join(b.root, "missing-origin.md"),
      destination: { kind: "project", path: "AGENTS.md" },
      name: "Legacy entry",
      savedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "legacy.md", mode: 0o600, sha256: createHash("sha256").update(fileBytes).digest("hex") }],
    }],
    groups: [{ id: "legacy-group", name: "Legacy group", itemIds: [id] }],
  };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(b.library, "catalog.json"), catalogBytes, { mode: 0o600 });
  return { id, catalogBytes, fileBytes };
}

function runWizardEntry(b: Box, entry: "runSetup" | "runGroupManager", args: unknown[]) {
  const wizardUrl = pathToFileURL(path.resolve("src/wizard.ts")).href;
  const script = `import { ${entry} } from ${JSON.stringify(wizardUrl)}; await ${entry}(...${JSON.stringify(args)});`;
  return spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
    cwd: b.project,
    env: { ...process.env, HOME: b.home, PI_CODING_AGENT_DIR: b.agent },
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runManagePty(b: Box) {
  const argv = [process.execPath, "--experimental-transform-types", path.resolve("src/cli.ts"), "manage"];
  const steps = [
    { wait: "Manage saved resources", send: "\r" },
    { wait: "Select resource by name", send: "\r" },
    { wait: "Resource action", send: "\r" },
    { wait: "Select saved file", send: "\r" },
    { wait: "Manage saved resources", send: "\u0003" },
  ];
  const driver = `import os,pty,select,subprocess,sys,json,time,errno,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,140,0,0))
p=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave,cwd=sys.argv[3],env=os.environ.copy())
os.close(slave)
steps=json.loads(sys.argv[2]); index=0; pending=b''; output=b''; deadline=time.monotonic()+25
try:
 while time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try: chunk=os.read(master,65536)
   except OSError as e:
    if e.errno==errno.EIO: break
    raise
   if not chunk: break
   output+=chunk; pending+=chunk
  if index<len(steps) and steps[index]['wait'].encode() in pending:
   time.sleep(.12); os.write(master,steps[index]['send'].encode()); index+=1; pending=b''
  if p.poll() is not None: break
 if p.poll() is None:
  try: p.wait(timeout=.5)
  except subprocess.TimeoutExpired:
   p.kill(); p.wait(); sys.stdout.buffer.write(output); sys.exit(124)
 sys.stdout.buffer.write(output)
 sys.stderr.write('PTY actions '+str(index)+'/'+str(len(steps))+'\\n')
 sys.exit(p.returncode if index==len(steps) else 125)
finally:
 os.close(master)
`;
  return spawnSync("python3", ["-c", driver, JSON.stringify(argv), JSON.stringify(steps), b.project], {
    cwd: b.project,
    env: { ...process.env, HOME: b.home, PI_CODING_AGENT_DIR: b.agent },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("v1 remains readable via list, groups, and manage's masked-view-only route", async (t) => {
  const b = await box(t);
  const before = await writeLegacyLibrary(b);

  const listed = runCli(b, ["list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Legacy entry/);
  assert.ok(!listed.stdout.includes(before.id));
  const groups = runCli(b, ["groups"]);
  assert.equal(groups.status, 0, groups.stderr);
  assert.match(groups.stdout, /Legacy group/);
  assert.ok(!groups.stdout.includes(before.id));

  const managed = runManagePty(b);
  assert.equal(managed.status, 0, `${managed.stdout}\n${managed.stderr}`);
  assert.match(managed.stderr, /PTY actions 5\/5/);
  assert.match(managed.stdout, /read only/i);
  assert.match(managed.stdout, /Legacy saved copy/);
  for (const writerPrompt of ["Edit saved text", "Rename display name", "Change destination", "Refresh from source", "Manage groups", "Apply group", "Setup copied resources", "Resolve name conflicts"]) {
    assert.ok(!managed.stdout.includes(writerPrompt), writerPrompt);
  }
  assert.deepEqual(await readFile(path.join(b.library, "catalog.json")), before.catalogBytes);
  assert.deepEqual(await readFile(path.join(b.library, "items", before.id, "files", "legacy.md")), before.fileBytes);
});

test("legacy v1 writers and apply reject before asking for mutation input", async (t) => {
  const b = await box(t);
  await writeLegacyLibrary(b);
  const roots = { homeDir: b.home, agentDir: b.agent, projectDir: b.project };

  const setup = runWizardEntry(b, "runSetup", [b.library, roots]);
  assert.equal(setup.status, 1, setup.stdout);
  assert.match(`${setup.stdout}\n${setup.stderr}`, /catalog v2; explicitly migrate/i);
  assert.ok(!setup.stdout.includes("Choose the locations copi may inspect"));
  const groups = runWizardEntry(b, "runGroupManager", [b.library]);
  assert.equal(groups.status, 1, groups.stdout);
  assert.match(`${groups.stdout}\n${groups.stderr}`, /catalog v2; explicitly migrate/i);
  assert.ok(!groups.stdout.includes("Manage saved groups"));
  const apply = runCli(b, ["apply", "Legacy group", b.project, "--dry-run"]);
  assert.equal(apply.status, 1, apply.stdout);
  assert.match(`${apply.stdout}\n${apply.stderr}`, /catalog v2; explicitly migrate/i);
});

test("v2 edit and apply read current registered bytes after origin removal, retaining registered mode", async (t) => {
  const b = await box(t);
  const sourceRoot = path.join(b.root, "source");
  const sourcePath = path.join(sourceRoot, "current-skill");
  const originFile = path.join(sourcePath, "SKILL.md");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(originFile, "# Origin bytes\n");
  await chmod(originFile, 0o751);

  const catalog = newCatalog();
  catalog.groups.push({ id: "current-group", name: "Current group", itemIds: [] });
  await saveCatalog(b.library, catalog);
  const candidate: ResourceCandidate = {
    id: randomUUID(), kind: "skill", source: "current-fixture", scope: "project", sourceRoot,
    sourcePath, name: "Current skill", destination: { kind: "project", path: ".pi/skills/current" },
  };
  const item = await importResource(b.library, candidate, { confirmed: true, groupIds: ["current-group"] });
  assert.ok(item);
  assert.equal(item.files[0]?.mode, 0o751);
  const privateSnapshot = path.join(b.library, "sources", item.id, "SKILL.md");
  assert.equal((await lstat(privateSnapshot)).mode & 0o777, 0o600);
  assert.equal((await readSnapshotFiles(b.library, item))[0]?.mode, 0o751);
  await rm(sourceRoot, { recursive: true });

  const prepared = await prepareSavedEdit(b.library, item.id, "SKILL.md");
  assert.equal(readSavedEdit(prepared).file.bytes.toString("utf8"), "# Origin bytes\n");
  const change = await prepareSavedChange(prepared, Buffer.from("# Edited from current content\n"));
  assert.equal(readSavedChange(change).bytesChanged, true);
  await commitSavedChange(change, { reviewId: change.reviewId, confirmed: true, approvedSensitivePaths: [] });
  const current = await readSnapshotFiles(b.library, item);
  assert.equal(current[0]?.bytes.toString("utf8"), "# Edited from current content\n");
  assert.equal(current[0]?.mode, 0o751);

  const apply = runCli(b, ["apply", "Current group", b.project, "--dry-run"]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Edited from current content/);
  assert.ok(!apply.stdout.includes("Origin bytes"));
  const storedFile = path.join(b.library, "sources", item.id, "SKILL.md");
  assert.equal((await readFile(storedFile)).toString("utf8"), "# Edited from current content\n");
  assert.equal((await loadCatalog(b.library)).version, 2);
});
