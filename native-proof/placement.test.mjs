import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { join } from "node:path";
import {
  directorySnapshot,
  makePlacementFixture,
  proofDir,
  stagedPayload,
} from "./fixtures.mjs";

const helperPath = join(proofDir, "placement-helper");
const raceKinds = ["file-parent", "tree-target", "absent-sources-root"];

function runPlace(fixture, injectRace = false) {
  const args = [
    "place",
    fixture.root,
    fixture.sourceParentRelative,
    fixture.sourceName,
    fixture.targetParentRelative,
    fixture.targetName,
    fixture.rootIdentity.dev,
    fixture.rootIdentity.ino,
    fixture.sourceParentIdentity.dev,
    fixture.sourceParentIdentity.ino,
    fixture.targetParentIdentity.dev,
    fixture.targetParentIdentity.ino,
    fixture.sourceIdentity.dev,
    fixture.sourceIdentity.ino,
  ];
  if (injectRace) args.push("--race-empty-dir");
  return spawnSync(helperPath, args, { encoding: "utf8", shell: false, timeout: 5000 });
}

function outputRecord(result) {
  const line = result.stdout.trim().split("\n").at(-1);
  assert.ok(line, `helper produced no JSON stdout: ${result.stderr}`);
  return JSON.parse(line);
}

for (const kind of raceKinds) {
  test(`RENAME_EXCL preserves a competing empty destination (${kind})`, async () => {
    const fixture = await makePlacementFixture(kind);
    await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });

    const sourceBefore = await directorySnapshot(fixture.sourcePath);
    const result = runPlace(fixture, true);
    assert.equal(result.status, 1, result.stderr);
    const record = outputRecord(result);
    assert.equal(record.operation, "renameatx_np");
    assert.equal(record.flag, "RENAME_EXCL");
    assert.equal(record.result, "refused");
    assert.equal(record.errno_name, "EEXIST");

    const externalAfter = await directorySnapshot(fixture.targetPath);
    assert.deepEqual(externalAfter, {
      dev: record.injected_external_dev,
      ino: record.injected_external_ino,
      mode: record.injected_external_mode,
      isDirectory: true,
      children: [],
    });
    assert.deepEqual(await directorySnapshot(fixture.sourcePath), sourceBefore);
    assert.deepEqual(await stagedPayload(fixture.sourcePath), fixture.sourceBytes);
    console.log(JSON.stringify({ kind, fixtureRoot: fixture.root, source: sourceBefore, external: externalAfter, result: record }));
  });
}

test("RENAME_EXCL moves a vacant staged tree without changing its inode or bytes", async () => {
  const fixture = await makePlacementFixture("normal-vacant");
  const sourceBefore = await directorySnapshot(fixture.sourcePath);
  const result = runPlace(fixture);
  assert.equal(result.status, 0, result.stderr);
  const record = outputRecord(result);
  assert.equal(record.result, "placed");
  assert.equal(record.destination_identity_preserved, true);
  assert.deepEqual(await directorySnapshot(fixture.targetPath), {
    ...sourceBefore,
    children: ["payload.txt"],
  });
  assert.deepEqual(await stagedPayload(fixture.targetPath), fixture.sourceBytes);
  await assert.rejects(lstat(fixture.sourcePath), { code: "ENOENT" });
  console.log(JSON.stringify({ kind: "normal-vacant", fixtureRoot: fixture.root, source: sourceBefore, result: record }));
});

test("malformed helper argv exits nonzero without changing staged source or vacant destination", async () => {
  const fixture = await makePlacementFixture("wrong-argv");
  const sourceBefore = await directorySnapshot(fixture.sourcePath);
  const result = spawnSync(helperPath, ["place", fixture.root], { encoding: "utf8", shell: false, timeout: 5000 });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /place-argument-count/);
  assert.deepEqual(await directorySnapshot(fixture.sourcePath), sourceBefore);
  assert.deepEqual(await stagedPayload(fixture.sourcePath), fixture.sourceBytes);
  await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
});
