import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { basename, dirname, join } from "node:path";
import {
  makePlacementFixture,
  proofDir,
  stagedPayload,
} from "./fixtures.mjs";

const helperPath = join(proofDir, "placement-helper");
const absent = { code: "ENOENT" };

function placeArgs(fixture, {
  targetParentRelative = fixture.targetParentRelative,
  targetParentIdentity = fixture.targetParentIdentity,
  targetName = fixture.targetName,
  hook,
} = {}) {
  const args = [
    "place",
    fixture.root,
    fixture.sourceParentRelative,
    fixture.sourceName,
    targetParentRelative,
    targetName,
    fixture.rootIdentity.dev,
    fixture.rootIdentity.ino,
    fixture.sourceParentIdentity.dev,
    fixture.sourceParentIdentity.ino,
    targetParentIdentity.dev,
    targetParentIdentity.ino,
    fixture.sourceIdentity.dev,
    fixture.sourceIdentity.ino,
  ];
  if (hook) args.push(hook);
  return args;
}

function runPlace(fixture, options = {}) {
  return spawnSync(helperPath, placeArgs(fixture, options), {
    encoding: "utf8",
    shell: false,
    timeout: 5000,
  });
}

function outputRecord(result) {
  const line = result.stdout.trim().split("\n").at(-1);
  assert.ok(line, `helper produced no JSON stdout: ${result.stderr}`);
  return JSON.parse(line);
}

async function snapshotEntry(path) {
  const info = await lstat(path, { bigint: true });
  const snapshot = {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: Number(info.mode & 0o777n),
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
  };
  if (info.isDirectory()) {
    snapshot.children = {};
    for (const name of (await readdir(path)).sort()) {
      snapshot.children[name] = await snapshotEntry(join(path, name));
    }
  } else if (info.isFile()) {
    snapshot.base64 = (await readFile(path)).toString("base64");
  } else if (info.isSymbolicLink()) {
    snapshot.target = await readlink(path);
  }
  return snapshot;
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), absent);
}

for (const collision of ["empty-dir", "nonempty-dir", "file", "symlink", "samebytes-dir"]) {
  test(`RENAME_EXCL preserves a competing ${collision} destination at the syscall boundary`, async () => {
    const fixture = await makePlacementFixture(`p1b-collision-${collision}`);
    const sourceBefore = await snapshotEntry(fixture.sourcePath);
    const result = runPlace(fixture, { hook: `--race-collision=${collision}` });
    assert.equal(result.status, 1, result.stderr);
    const record = outputRecord(result);
    assert.equal(record.operation, "renameatx_np");
    assert.equal(record.flag, "RENAME_EXCL");
    assert.equal(record.result, "refused");
    assert.equal(record.errno_name, "EEXIST");
    assert.equal(record.test_interposition, "immediately-before-real-renameatx_np");

    const externalAfter = await snapshotEntry(fixture.targetPath);
    assert.equal(externalAfter.dev, record.injected_external_dev);
    assert.equal(externalAfter.ino, record.injected_external_ino);
    assert.equal(externalAfter.mode, record.injected_external_mode);
    assert.deepEqual(await snapshotEntry(fixture.sourcePath), sourceBefore);
    assert.deepEqual(await stagedPayload(fixture.sourcePath), fixture.sourceBytes);
    if (collision === "empty-dir") {
      assert.equal(externalAfter.type, "directory");
      assert.deepEqual(Object.keys(externalAfter.children), []);
    }
    if (collision === "nonempty-dir") {
      assert.equal(externalAfter.type, "directory");
      assert.deepEqual(Object.keys(externalAfter.children), ["sentinel.txt"]);
      assert.equal(Buffer.from(externalAfter.children["sentinel.txt"].base64, "base64").toString(), "external directory sentinel\n");
    }
    if (collision === "file") {
      assert.equal(externalAfter.type, "file");
      assert.equal(Buffer.from(externalAfter.base64, "base64").toString(), "external file sentinel\n");
    }
    if (collision === "symlink") {
      assert.equal(externalAfter.type, "symlink");
      assert.equal(externalAfter.target, "external-symlink-target");
    }
    if (collision === "samebytes-dir") {
      assert.equal(externalAfter.type, "directory");
      assert.equal(externalAfter.children["payload.txt"].base64, sourceBefore.children["payload.txt"].base64);
      assert.notEqual(externalAfter.ino, sourceBefore.ino);
      assert.notEqual(externalAfter.children["payload.txt"].ino, sourceBefore.children["payload.txt"].ino);
    }
    console.log(JSON.stringify({ case: collision, fixtureRoot: fixture.root, source: sourceBefore, external: externalAfter, record }));
  });
}

test("symlink in a destination ancestor is rejected without touching its referent", async () => {
  const fixture = await makePlacementFixture("p1b-symlink-ancestor");
  const realParent = join(fixture.root, "real-parent");
  const aliasParent = join(fixture.root, "alias-parent");
  await mkdir(realParent);
  await symlink("real-parent", aliasParent);
  const realParentStat = await stat(realParent, { bigint: true });
  const sourceBefore = await snapshotEntry(fixture.sourcePath);

  const result = runPlace(fixture, {
    targetParentRelative: "alias-parent",
    targetParentIdentity: { dev: realParentStat.dev.toString(), ino: realParentStat.ino.toString() },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), "");
  assert.deepEqual(await snapshotEntry(fixture.sourcePath), sourceBefore);
  const aliasAfter = await snapshotEntry(aliasParent);
  assert.equal(aliasAfter.type, "symlink");
  assert.equal(aliasAfter.target, "real-parent");
  await assertAbsent(join(realParent, fixture.targetName));
  console.log(JSON.stringify({ case: "symlink-ancestor", fixtureRoot: fixture.root, result: { status: result.status, stderr: result.stderr.trim() } }));
});

test("LIMIT: replacing the parent path leaves the opened dirfd attached to the renamed parent", async () => {
  const fixture = await makePlacementFixture("p1b-parent-path-swap");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const heldParent = join(fixture.root, ".p1b-parent-path-swap");
  const visibleParent = join(fixture.root, "sources");
  const result = runPlace(fixture, { hook: "--race-parent-path-swap" });
  assert.equal(result.status, 0, result.stderr);
  const record = outputRecord(result);
  assert.equal(record.boundary, "LIMIT");
  assert.equal(record.test_interposition, "immediately-before-real-renameatx_np");
  assert.equal(record.parent_path_replaced, true);
  assert.equal(record.result, "placed");

  assert.deepEqual(await snapshotEntry(join(heldParent, fixture.targetName)), sourceBefore);
  const replacement = await snapshotEntry(visibleParent);
  assert.deepEqual(Object.keys(replacement.children), [fixture.targetName]);
  assert.equal(Buffer.from(replacement.children[fixture.targetName].base64, "base64").toString(), "replacement parent sentinel\n");
  await assertAbsent(fixture.sourcePath);
  console.log(JSON.stringify({ case: "parent-path-swap", classification: "LIMIT-not-safety-pass", fixtureRoot: fixture.root, heldParent: await snapshotEntry(heldParent), replacementParent: replacement, record }));
});

test("LIMIT: moving the opened parent outside the synthetic root does not confine its dirfd", async () => {
  const fixture = await makePlacementFixture("p1b-parent-namespace-move");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const externalParent = join(dirname(fixture.root), `${basename(fixture.root)}.p1b-outside-parent`);
  const result = runPlace(fixture, { hook: "--race-parent-move-outside" });
  assert.equal(result.status, 0, result.stderr);
  const record = outputRecord(result);
  assert.equal(record.boundary, "LIMIT");
  assert.equal(record.test_interposition, "immediately-before-real-renameatx_np");
  assert.equal(record.moved_parent_outside_root, true);
  assert.equal(record.outside_parent_name, `${basename(fixture.root)}.p1b-outside-parent`);
  assert.equal(record.result, "placed");

  assert.deepEqual(await snapshotEntry(join(externalParent, fixture.targetName)), sourceBefore);
  const replacement = await snapshotEntry(join(fixture.root, "sources"));
  assert.deepEqual(Object.keys(replacement.children), [fixture.targetName]);
  assert.equal(Buffer.from(replacement.children[fixture.targetName].base64, "base64").toString(), "replacement parent sentinel\n");
  await assertAbsent(fixture.sourcePath);
  console.log(JSON.stringify({ case: "parent-namespace-move", classification: "LIMIT-not-safety-pass", fixtureRoot: fixture.root, externalParent: await snapshotEntry(externalParent), replacementParent: replacement, record }));
});

test("LIMIT: replacing the final source basename is not made conditional by RENAME_EXCL", async () => {
  const fixture = await makePlacementFixture("p1b-source-basename-swap");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const heldSource = join(fixture.root, ".p1b-source-held");
  const result = runPlace(fixture, { hook: "--race-source-basename-swap" });
  assert.equal(result.status, 64, result.stderr);
  const record = outputRecord(result);
  assert.equal(record.boundary, "LIMIT");
  assert.equal(record.test_interposition, "immediately-before-real-renameatx_np");
  assert.equal(record.result, "placed");
  assert.equal(record.destination_identity_preserved, false);

  assert.deepEqual(await snapshotEntry(heldSource), sourceBefore);
  const destinationAfter = await snapshotEntry(fixture.targetPath);
  assert.equal(destinationAfter.type, "directory");
  assert.notEqual(destinationAfter.ino, sourceBefore.ino);
  assert.equal(destinationAfter.children["payload.txt"].base64, sourceBefore.children["payload.txt"].base64);
  await assertAbsent(fixture.sourcePath);
  console.log(JSON.stringify({ case: "source-basename-swap", classification: "LIMIT-not-safety-pass", fixtureRoot: fixture.root, original: await snapshotEntry(heldSource), replacementDestination: destinationAfter, record }));
});

test("unsupported flag failure does not fall back to an ordinary rename", async () => {
  const fixture = await makePlacementFixture("p1b-unsupported-flag");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const result = runPlace(fixture, { hook: "--race-unsupported-flag" });
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  const record = outputRecord(result);
  assert.equal(record.operation, "renameatx_np");
  assert.equal(record.flag, "RENAME_EXCL|UNSUPPORTED_TEST_BIT");
  assert.equal(record.result, "refused");
  assert.notEqual(record.errno, 0);
  assert.deepEqual(await snapshotEntry(fixture.sourcePath), sourceBefore);
  await assertAbsent(fixture.targetPath);
  console.log(JSON.stringify({ case: "unsupported-flag", fixtureRoot: fixture.root, result: record }));
});

test("synthetic unknown-errno branch stops without treating injection as filesystem evidence", async () => {
  const fixture = await makePlacementFixture("p1b-unknown-errno");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const result = runPlace(fixture, { hook: "--test-unknown-errno" });
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  const record = outputRecord(result);
  assert.equal(record.result, "refused");
  assert.equal(record.errno_name, "OTHER");
  assert.equal(record.filesystem_result, false);
  assert.equal(record.syscall_performed, false);
  assert.deepEqual(await snapshotEntry(fixture.sourcePath), sourceBefore);
  await assertAbsent(fixture.targetPath);
  console.log(JSON.stringify({ case: "synthetic-unknown-errno-control-only", fixtureRoot: fixture.root, result: record }));
});

test("helper killed immediately before rename leaves the source and vacancy unchanged", async () => {
  const fixture = await makePlacementFixture("p1b-helper-kill-before");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const result = runPlace(fixture, { hook: "--test-kill-before-syscall" });
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(await snapshotEntry(fixture.sourcePath), sourceBefore);
  await assertAbsent(fixture.targetPath);
  console.log(JSON.stringify({ case: "helper-kill-before-syscall", fixtureRoot: fixture.root, signal: result.signal, source: sourceBefore, destination: "absent" }));
});

test("helper killed after the real rename has an indeterminate receipt but placed bytes remain", async () => {
  const fixture = await makePlacementFixture("p1b-helper-kill-after");
  const sourceBefore = await snapshotEntry(fixture.sourcePath);
  const result = runPlace(fixture, { hook: "--test-kill-after-syscall" });
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(await snapshotEntry(fixture.targetPath), sourceBefore);
  await assertAbsent(fixture.sourcePath);
  console.log(JSON.stringify({ case: "helper-kill-after-syscall", classification: "receipt-unknown-preserve-and-stop", fixtureRoot: fixture.root, signal: result.signal, destination: await snapshotEntry(fixture.targetPath) }));
});
