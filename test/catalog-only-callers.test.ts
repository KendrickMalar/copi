import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalog, newCatalog, renameSavedItem, saveCatalog } from "../src/catalog.ts";
import { createGroup, renameGroup, setGroupItems } from "../src/groups.ts";
import { changeSavedDestination } from "../src/resource-mutations.ts";
import { StorageTransactions, storageTransactions } from "../src/storage-transaction.ts";
import type { Catalog, LegacyCatalog, SavedItem } from "../src/types.ts";

const itemId = "123e4567-e89b-42d3-a456-426614174000";
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-catalog-callers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function assertAbsent(target: string): Promise<void> {
  await assert.rejects(lstat(target), { code: "ENOENT" });
}

async function itemFixture(t: test.TestContext) {
  const root = await temporaryRoot(t);
  const libraryDir = path.join(root, "library");
  const sourceFile = path.join(libraryDir, "sources", itemId, "instructions.md");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  const descriptorBytes = Buffer.from("descriptor bytes before a direct edit\n");
  const currentBytes = Buffer.from("current source bytes; descriptor intentionally stale\n");
  await writeFile(sourceFile, currentBytes, { mode: 0o600 });
  const item: SavedItem = {
    id: itemId,
    kind: "instruction",
    source: "synthetic-origin",
    scope: "project",
    sourcePath: "/deleted/origin/instructions.md",
    destination: { kind: "project", path: "AGENTS.md" },
    name: "Instructions",
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "instructions.md", mode: 0o644, sha256: digest(descriptorBytes) }],
    content: { kind: "file", path: `sources/${itemId}/instructions.md` },
  };
  const catalog: Catalog = {
    version: 2,
    items: [item],
    groups: [{ id: "daily", name: "Daily", itemIds: [] }],
  };
  await writeFile(path.join(libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  const beforeStat = await lstat(sourceFile);
  return { root, libraryDir, sourceFile, item, catalog, currentBytes, beforeStat };
}

function runGroupManager(libraryDir: string, actions: Array<{ waitFor: string; send: string; stopOn?: string }>) {
  const app = `import { runGroupManager } from "./src/wizard.ts"; await runGroupManager(${JSON.stringify(libraryDir)}); process.exit(0);`;
  const driver = `import errno, fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
argv = json.loads(sys.argv[1])
steps = json.loads(sys.argv[2])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, cwd=os.getcwd(), env=os.environ.copy())
os.close(slave)
output = bytearray()
pending = bytearray()
index = 0
deadline = time.time() + 8
while time.time() < deadline:
    if select.select([master], [], [], .05)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
        pending.extend(chunk)
    if index < len(steps) and steps[index]['waitFor'].encode() in pending:
        time.sleep(.1)
        os.write(master, steps[index]['send'].encode())
        index += 1
        pending.clear()
    if index > 0 and steps[index - 1].get('stopOn') and steps[index - 1]['stopOn'].encode() in output:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.close(master)
        sys.stdout.buffer.write(output)
        sys.exit(0)
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
    child.wait()
    os.close(master)
    sys.stdout.buffer.write(output)
    sys.stderr.write('PTY timeout before action ' + str(index))
    sys.exit(124)
code = child.wait()
os.close(master)
sys.stdout.buffer.write(output)
sys.exit(code)
`;
  const childArgv = [process.execPath, "--experimental-transform-types", "--input-type=module", "-e", app];
  const result = spawnSync("python3", ["-c", driver, JSON.stringify(childArgv), JSON.stringify(actions)], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 12_000,
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "0" },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, error: result.error };
}

test("group-only first and repeated saves use catalog v2 without creating sources or leaving a lock", async (t) => {
  const root = await temporaryRoot(t);
  const libraryDir = path.join(root, "library");
  const initial = newCatalog();
  const daily = createGroup(initial, "Daily");
  await saveCatalog(libraryDir, initial);

  let raw = JSON.parse(await readFile(path.join(libraryDir, "catalog.json"), "utf8")) as { version: number; groups: Array<{ id: string; name: string; itemIds: string[] }> };
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.groups, [{ id: daily.id, name: "Daily", itemIds: [] }]);
  await assertAbsent(path.join(libraryDir, "sources"));
  await assertAbsent(path.join(libraryDir, ".copi-transaction"));

  const repeated = await loadCatalog(libraryDir);
  assert.equal(repeated.version, 2);
  if (repeated.version !== 2) throw new Error("Expected a modern catalog.");
  const review = createGroup(repeated, "Review");
  renameGroup(repeated, daily.id, "Daily review");
  setGroupItems(repeated, review.id, []);
  await saveCatalog(libraryDir, repeated);

  raw = JSON.parse(await readFile(path.join(libraryDir, "catalog.json"), "utf8")) as typeof raw;
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.groups, [
    { id: daily.id, name: "Daily review", itemIds: [] },
    { id: review.id, name: "Review", itemIds: [] },
  ]);
  await assertAbsent(path.join(libraryDir, "sources"));
  await assertAbsent(path.join(libraryDir, ".copi-transaction"));
});

test("group, rename, and legal destination callers preserve current source bytes and every other item field", async (t) => {
  const box = await itemFixture(t);
  const current = await loadCatalog(box.libraryDir);
  assert.equal(current.version, 2);
  if (current.version !== 2) throw new Error("Expected a modern catalog.");
  const review = createGroup(current, "Review");
  renameGroup(current, "daily", "Daily review");
  setGroupItems(current, "daily", [itemId]);
  setGroupItems(current, review.id, [itemId]);
  await saveCatalog(box.libraryDir, current);

  const renamed = await renameSavedItem(box.libraryDir, itemId, "Instructions renamed");
  const moved = await changeSavedDestination(box.libraryDir, itemId, { kind: "project", path: ".pi/skills/instructions" });
  const actual = await loadCatalog(box.libraryDir);
  assert.equal(actual.version, 2);
  if (actual.version !== 2) throw new Error("Expected a modern catalog.");
  assert.deepEqual(actual.items, [{ ...box.item, name: renamed.name, destination: moved.destination }]);
  assert.deepEqual(actual.items[0], {
    ...box.item,
    name: "Instructions renamed",
    destination: { kind: "project", path: ".pi/skills/instructions" },
  });
  assert.deepEqual(actual.groups, [
    { id: "daily", name: "Daily review", itemIds: [itemId] },
    { id: review.id, name: "Review", itemIds: [itemId] },
  ]);
  assert.deepEqual(await readFile(box.sourceFile), box.currentBytes);
  const afterStat = await lstat(box.sourceFile);
  assert.equal(afterStat.dev, box.beforeStat.dev);
  assert.equal(afterStat.ino, box.beforeStat.ino);
  assert.equal(actual.items[0]!.files[0]!.sha256, digest("descriptor bytes before a direct edit\n"));
  assert.equal(actual.items[0]!.content.path, `sources/${itemId}/instructions.md`);
  await assertAbsent(path.join(box.libraryDir, ".copi-transaction"));
});

test("invalid v2 metadata and ordinary v1 saves are refused without changing catalog or source bytes", async (t) => {
  const box = await itemFixture(t);
  const catalogPath = path.join(box.libraryDir, "catalog.json");
  const beforeCatalog = await readFile(catalogPath);
  const invalidDestination = await changeSavedDestination(box.libraryDir, itemId, { kind: "project", path: ".env/private" }).catch((error: unknown) => error);
  assert.ok(invalidDestination instanceof Error);
  assert.match(invalidDestination.message, /unsafe|private|excluded/i);
  assert.deepEqual(await readFile(catalogPath), beforeCatalog);
  assert.deepEqual(await readFile(box.sourceFile), box.currentBytes);

  const changedOrigin = await loadCatalog(box.libraryDir);
  assert.equal(changedOrigin.version, 2);
  if (changedOrigin.version !== 2) throw new Error("Expected a modern catalog.");
  changedOrigin.items[0]!.sourcePath = "/unapproved/other-origin.md";
  await assert.rejects(saveCatalog(box.libraryDir, changedOrigin), /source metadata|origin|transition|only item names/i);
  assert.deepEqual(await readFile(catalogPath), beforeCatalog);
  assert.deepEqual(await readFile(box.sourceFile), box.currentBytes);
  await assertAbsent(path.join(box.libraryDir, ".copi-transaction"));

  const legacy: LegacyCatalog = { version: 1, items: [], groups: [{ id: "legacy", name: "Legacy", itemIds: [] }] };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(catalogPath, legacyBytes);
  const forgedModernType = legacy as unknown as Catalog;
  await assert.rejects(saveCatalog(box.libraryDir, forgedModernType), /catalog v2|migrate/i);
  assert.deepEqual(await readFile(catalogPath), legacyBytes);
  assert.deepEqual(await readFile(box.sourceFile), box.currentBytes);
  await assertAbsent(path.join(box.libraryDir, ".copi-transaction"));
});

test("stale catalog and source-tree changes during metadata commit are rejected while external source bytes remain", async (t) => {
  const box = await itemFixture(t);
  const stale = await loadCatalog(box.libraryDir);
  assert.equal(stale.version, 2);
  if (stale.version !== 2) throw new Error("Expected a modern catalog.");
  const winner = await loadCatalog(box.libraryDir);
  assert.equal(winner.version, 2);
  if (winner.version !== 2) throw new Error("Expected a modern catalog.");
  winner.groups[0]!.name = "Winner";
  await saveCatalog(box.libraryDir, winner);
  const winnerBytes = await readFile(path.join(box.libraryDir, "catalog.json"));
  stale.groups[0]!.name = "Stale";
  await assert.rejects(saveCatalog(box.libraryDir, stale), /changed|revision|conflict/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), winnerBytes);
  assert.deepEqual(await readFile(box.sourceFile), box.currentBytes);
  await assertAbsent(path.join(box.libraryDir, ".copi-transaction"));

  const beforeConflict = await loadCatalog(box.libraryDir);
  assert.equal(beforeConflict.version, 2);
  if (beforeConflict.version !== 2) throw new Error("Expected a modern catalog.");
  beforeConflict.groups[0]!.name = "Must not commit";
  const beforeConflictBytes = await readFile(path.join(box.libraryDir, "catalog.json"));
  const externalBytes = Buffer.from("external edit during catalog-only staging; preserve these bytes\n");
  let edited = false;
  const kernel = new StorageTransactions({
    checkpoint: async (point) => {
      if (point === "stage-write" && !edited) {
        edited = true;
        await writeFile(box.sourceFile, externalBytes);
      }
    },
  });
  const patched = t.mock.method(storageTransactions, "run", kernel.run.bind(kernel));
  try {
    await assert.rejects(saveCatalog(box.libraryDir, beforeConflict), /sources tree changed|revision/i);
  } finally {
    patched.mock.restore();
  }
  assert.equal(edited, true);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), beforeConflictBytes);
  assert.deepEqual(await readFile(box.sourceFile), externalBytes);
  await assertAbsent(path.join(box.libraryDir, ".copi-transaction"));
});

test("group manager cancellation preserves an unchanged v2 catalog", async (t) => {
  const root = await temporaryRoot(t);
  const libraryDir = path.join(root, "library");
  await saveCatalog(libraryDir, newCatalog());
  const catalogPath = path.join(libraryDir, "catalog.json");
  const before = await readFile(catalogPath);
  const run = runGroupManager(libraryDir, [{ waitFor: "Manage saved groups", send: "\u001b", stopOn: "Group changes were not saved." }]);
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Group changes were not saved/);
  assert.deepEqual(await readFile(catalogPath), before);
  await assertAbsent(path.join(libraryDir, "sources"));
  await assertAbsent(path.join(libraryDir, ".copi-transaction"));
});

test("group manager refuses v1 mutation before collecting metadata", async (t) => {
  const root = await temporaryRoot(t);
  const libraryDir = path.join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const legacy: LegacyCatalog = { version: 1, items: [], groups: [{ id: "legacy", name: "Legacy", itemIds: [] }] };
  const catalogPath = path.join(libraryDir, "catalog.json");
  const before = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(catalogPath, before, { mode: 0o600 });

  const run = runGroupManager(libraryDir, [{ waitFor: "Manage saved groups", send: "\r", stopOn: "New group name" }]);
  assert.ifError(run.error);
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /catalog v2|migrate/i);
  assert.doesNotMatch(run.output, /New group name/);
  assert.deepEqual(await readFile(catalogPath), before);
  await assertAbsent(path.join(libraryDir, "sources"));
  await assertAbsent(path.join(libraryDir, ".copi-transaction"));
});
