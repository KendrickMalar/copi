import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, loadCatalog, readSnapshotFiles } from "../src/catalog.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange, readSavedEdit } from "../src/resource-mutations.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function approval(change: ReturnType<typeof readSavedChange>) {
  return { reviewId: change.reviewId, confirmed: true, approvedSensitivePaths: [...change.sensitivePaths] };
}

test("group-free skill import stores UUID-addressed sources content and edits current bytes after origin removal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-current-import-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "origin");
  const sourcePath = path.join(sourceRoot, "portable");
  const libraryDir = path.join(root, "library");
  await mkdir(sourcePath, { recursive: true });
  const original = Buffer.from("# Original skill\n");
  await writeFile(path.join(sourcePath, "SKILL.md"), original);

  const saved = await importResource(libraryDir, {
    id: "discovery-id-is-not-the-storage-id", kind: "skill", source: "fixture-origin", scope: "user",
    sourceRoot, sourcePath, name: "Portable",
    destination: { kind: "project", path: ".pi/skills/portable" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(saved);
  assert.match(saved.id, uuidV4);
  assert.equal(saved.content.kind, "tree");
  assert.equal(saved.content.path, `sources/${saved.id}`);
  assert.equal(saved.sourcePath, sourcePath);
  assert.deepEqual(saved.destination, { kind: "project", path: ".pi/skills/portable" });
  assert.equal(saved.files[0]!.sha256, digest(original));
  assert.deepEqual((await loadCatalog(libraryDir)).version, 2);
  assert.deepEqual((await loadCatalog(libraryDir)).groups, []);
  await assert.rejects(lstat(path.join(libraryDir, "items")), { code: "ENOENT" });

  await rm(sourcePath, { recursive: true });
  const storedPath = path.join(libraryDir, ...saved.content.path.split("/"), "SKILL.md");
  const direct = Buffer.from("# Direct current edit\n");
  await writeFile(storedPath, direct);
  const current = (await readSnapshotFiles(libraryDir, saved))[0]!;
  assert.deepEqual(current.bytes, direct);
  assert.equal(current.sha256, digest(direct));
  assert.equal(saved.files[0]!.sha256, digest(original));

  const edit = await prepareSavedEdit(libraryDir, saved.id, "SKILL.md");
  assert.deepEqual(readSavedEdit(edit).file.bytes, direct);
  const proposed = Buffer.from("# Reviewed edit from current bytes\n");
  const change = await prepareSavedChange(edit, proposed);
  const view = readSavedChange(change);
  assert.ok(view.diffs[0]!.diff.includes("Direct current edit"));
  assert.ok(!view.diffs[0]!.diff.includes("Original skill"));
  const updated = await commitSavedChange(change, approval(view));
  assert.deepEqual((await readSnapshotFiles(libraryDir, updated))[0]!.bytes, proposed);
  assert.equal(updated.files[0]!.sha256, digest(proposed));
  assert.deepEqual(await readFile(storedPath), proposed);
});

test("group-free file import uses current source bytes and rejects edits after preview", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-current-import-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "origin");
  const sourcePath = path.join(sourceRoot, "instructions.md");
  const libraryDir = path.join(root, "library");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(sourcePath, "# Original instructions\n");

  const saved = await importResource(libraryDir, {
    id: "discovery-id-is-not-the-storage-id", kind: "instruction", source: "fixture-origin", scope: "user",
    sourceRoot, sourcePath, name: "Instructions",
    destination: { kind: "project", path: "AGENTS.md" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(saved);
  assert.match(saved.id, uuidV4);
  assert.equal(saved.content.kind, "file");
  assert.equal(saved.content.path, `sources/${saved.id}/instructions.md`);
  await assert.rejects(lstat(path.join(libraryDir, "items")), { code: "ENOENT" });

  await rm(sourcePath);
  const storedPath = path.join(libraryDir, ...saved.content.path.split("/"));
  const direct = Buffer.from("# Direct before review\n");
  await writeFile(storedPath, direct);
  const edit = await prepareSavedEdit(libraryDir, saved.id, "instructions.md");
  assert.deepEqual(readSavedEdit(edit).file.bytes, direct);
  const change = await prepareSavedChange(edit, Buffer.from("# Reviewed preview\n"));
  const view = readSavedChange(change);
  const external = Buffer.from("# Direct edit after preview\n");
  await writeFile(storedPath, external);

  await assert.rejects(commitSavedChange(change, approval(view)), /changed|revision|before-reviewed/i);
  assert.deepEqual(await readFile(storedPath), external);
  assert.equal((await loadCatalog(libraryDir)).items[0]!.files[0]!.sha256, saved.files[0]!.sha256);
});
