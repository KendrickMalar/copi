import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, listSnapshots, loadCatalog, newCatalog, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import type { ResourceCandidate } from "../src/types.ts";

function skillCandidate(sourceRoot: string, sourcePath: string): ResourceCandidate {
  return {
    id: "test-skill-id",
    kind: "skill",
    source: "shared-agent-skills",
    scope: "shared",
    sourceRoot,
    sourcePath,
    name: "portable",
    destination: { kind: "project", path: ".pi/skills/portable" },
  };
}

test("stores an owner-only, byte-for-byte skill bundle snapshot and preserves shared group membership after its source is removed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "portable");
  const libraryDir = path.join(root, "home", ".copi");
  await mkdir(path.join(sourcePath, "scripts"), { recursive: true });
  await mkdir(path.join(sourcePath, "references"), { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "Read references/guide.md and run scripts/tool.sh");
  await writeFile(path.join(sourcePath, "references", "guide.md"), "reference payload");
  const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
  await writeFile(path.join(sourcePath, "assets.bin"), binary);
  await writeFile(path.join(sourcePath, "scripts", "tool.sh"), "#!/bin/sh\nprintf bundled\n");
  await chmod(path.join(sourcePath, "scripts", "tool.sh"), 0o755);
  const originalText = await readFile(path.join(sourcePath, "SKILL.md"));
  const originalMode = (await lstat(path.join(sourcePath, "scripts", "tool.sh"))).mode & 0o777;

  const catalog = newCatalog();
  catalog.groups = [
    { id: "daily", name: "Daily", itemIds: [] },
    { id: "review", name: "Review", itemIds: [] },
  ];
  await saveCatalog(libraryDir, catalog);
  const saved = await importResource(libraryDir, skillCandidate(sourceRoot, sourcePath), {
    confirmed: true,
    groupIds: ["daily", "review"],
  });
  assert.ok(saved);
  assert.equal(saved.destination.kind, "project");
  assert.ok(saved.files.some((file) => file.path === "scripts/tool.sh" && file.mode === 0o755));
  assert.deepEqual(await readFile(path.join(sourcePath, "SKILL.md")), originalText);
  assert.equal((await lstat(path.join(sourcePath, "scripts", "tool.sh"))).mode & 0o777, originalMode);

  const loaded = await loadCatalog(libraryDir);
  assert.deepEqual(loaded.groups.map((group) => group.itemIds), [[saved.id], [saved.id]]);
  assert.equal((await lstat(libraryDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(libraryDir, "catalog.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(libraryDir, "items", saved.id, "files", "assets.bin"))).mode & 0o777, 0o600);

  await rm(sourcePath, { recursive: true });
  const stored = await readSnapshotFiles(libraryDir, saved);
  assert.deepEqual(stored.find((file) => file.path === "assets.bin")?.bytes, binary);
  assert.equal(stored.find((file) => file.path === "scripts/tool.sh")?.mode, 0o755);
  assert.equal((await listSnapshots(libraryDir))[0]?.id, saved.id);
});

test("does not create or change the library when the import is cancelled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "skill");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "safe");

  assert.equal(await importResource(libraryDir, skillCandidate(sourceRoot, sourcePath), {
    confirmed: false,
    groupIds: [],
  }), null);
  await assert.rejects(lstat(libraryDir), { code: "ENOENT" });
});

test("rejects malformed catalogs and source paths that escape their declared search root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-invalid-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, "library");
  await mkdir(libraryDir);
  await writeFile(path.join(libraryDir, "catalog.json"), "{ definitely not JSON");
  await assert.rejects(loadCatalog(libraryDir), /catalog/i);

  const sourceRoot = path.join(root, "source");
  const outside = path.join(root, "outside");
  await mkdir(sourceRoot);
  await mkdir(outside);
  await writeFile(path.join(outside, "SKILL.md"), "outside");
  const candidate = skillCandidate(sourceRoot, outside);
  await assert.rejects(importResource(path.join(root, "other-library"), candidate, {
    confirmed: true,
    groupIds: [],
  }), /outside|escape|boundary/i);
  await assert.rejects(lstat(path.join(root, "other-library")), { code: "ENOENT" });
});

test("rejects a symlinked item directory before reading snapshot bytes outside the private store", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-snapshot-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "skill");
  const libraryDir = path.join(root, "library");
  const outside = path.join(root, "outside");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(path.join(outside, "files"), { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "same bytes");
  const saved = await importResource(libraryDir, skillCandidate(sourceRoot, sourcePath), { confirmed: true, groupIds: [] });
  assert.ok(saved);
  await writeFile(path.join(outside, "files", "SKILL.md"), "same bytes");
  await rm(path.join(libraryDir, "items", saved.id), { recursive: true });
  await symlink(outside, path.join(libraryDir, "items", saved.id), "dir");

  await assert.rejects(readSnapshotFiles(libraryDir, saved), /unsafe|symbolic|outside/i);
});
