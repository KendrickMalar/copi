import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importPreparedResource, importResource, listSnapshots, loadCatalog, newCatalog, prepareResource, readPreparedResource, readSnapshotFiles, renameSavedItem, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource, maskSensitiveText } from "../src/inspect.ts";
import type { ResourceCandidate } from "../src/types.ts";
import { addItem, duplicateFixture, sandbox } from "./helpers/sandbox.ts";

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

test("rejects new normalized duplicates across kinds but allows separate item and group namespaces", async (t) => {
  const box = await sandbox(t);
  const first = await addItem(box, "Straße");
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups.push({ id: "same", name: " STRASSE ", itemIds: [first.id] });
  await saveCatalog(box.libraryDir, catalog);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  const sourcePath = path.join(box.sourceRoot, "other.md");
  await writeFile(sourcePath, "other");
  await assert.rejects(importResource(box.libraryDir, {
    ...skillCandidate(box.sourceRoot, sourcePath), kind: "subagent", name: "ＳＴＲＡＳＳＥ",
  }, { confirmed: true, groupIds: [] }), /duplicate|conflict/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  const second = await addItem(box, " Separate ");
  assert.equal(second.name, "Separate");
  await assert.rejects(renameSavedItem(box.libraryDir, second.id, "strasse"), /duplicate|conflict/i);
});

test("loads existing duplicates, blocks generic saves/imports, and renames only conflict members without changing bytes or identity", async (t) => {
  const box = await sandbox(t);
  const unrelated = await addItem(box, "Unrelated");
  const { first, second } = await duplicateFixture(box);
  const catalog = await loadCatalog(box.libraryDir);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  await assert.rejects(saveCatalog(box.libraryDir, catalog), /duplicate|conflict/i);
  await assert.rejects(addItem(box, "Third"), /duplicate|conflict/i);
  await assert.rejects(renameSavedItem(box.libraryDir, unrelated.id, "Changed"), /duplicate|conflict/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  const bytes = await readSnapshotFiles(box.libraryDir, second);
  const renamed = await renameSavedItem(box.libraryDir, second.id, " Separate ");
  assert.deepEqual(renamed, { ...second, name: "Separate" });
  const after = await loadCatalog(box.libraryDir);
  assert.deepEqual(after.groups, catalog.groups);
  assert.deepEqual(after.items.find((item) => item.id === first.id), catalog.items.find((item) => item.id === first.id));
  assert.deepEqual(await readSnapshotFiles(box.libraryDir, renamed), bytes);
  assert.equal((await listSnapshots(box.libraryDir)).length, 3);
});

test("rename refuses checksum mismatch and symlinked saved bytes without changing catalog", async (t) => {
  const box = await sandbox(t);
  const item = await addItem(box, "Original");
  const manifest = path.join(box.libraryDir, "catalog.json");
  const before = await readFile(manifest);
  const file = path.join(box.libraryDir, "items", item.id, "files", "SKILL.md");
  await writeFile(file, "tampered");
  await assert.rejects(renameSavedItem(box.libraryDir, item.id, "New"), /checksum/i);
  assert.deepEqual(await readFile(manifest), before);
  await rm(file);
  await symlink(path.join(item.sourcePath, "SKILL.md"), file);
  await assert.rejects(renameSavedItem(box.libraryDir, item.id, "New"), /symbolic|unsafe/i);
  assert.deepEqual(await readFile(manifest), before);
});

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
  await mkdir(path.join(sourcePath, ".cache"), { recursive: true });
  await mkdir(path.join(sourcePath, ".npm"), { recursive: true });
  await writeFile(path.join(sourcePath, ".cache", "private.txt"), "cached content");
  await writeFile(path.join(sourcePath, ".npm", "private.txt"), "package cache content");
  await mkdir(path.join(sourcePath, "auth", "nested"), { recursive: true });
  await writeFile(path.join(sourcePath, "auth", "private.ts"), "export const authenticate = true;");
  await writeFile(path.join(sourcePath, "auth", "nested", "tokens.json"), "{\"token\":\"private\"}");
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
  for (const relative of [".cache/private.txt", ".npm/private.txt", "auth/private.ts", "auth/nested/tokens.json"]) {
    assert.ok(!saved.files.some((file) => file.path === relative));
    await assert.rejects(lstat(path.join(libraryDir, "items", saved.id, "files", ...relative.split("/"))), { code: "ENOENT" });
  }
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

test("inspects and imports the exact prepared bytes after source changes, excluding every env-prefixed secret file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "auth", "cache", "source");
  const sourcePath = path.join(sourceRoot, "skill");
  const libraryDir = path.join(root, "home", ".copi");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "apiKey=sk_live_approvedsecret123");
  await writeFile(path.join(sourcePath, ".envrc"), "TOKEN=sk_live_envrcsecret123");
  await writeFile(path.join(sourcePath, ".env-production"), "TOKEN=sk_live_envprodsecret123");
  await writeFile(path.join(sourcePath, "auth.json"), "{\"token\":\"private\"}");
  await writeFile(path.join(sourcePath, "OAuth.json"), "{\"token\":\"private\"}");
  await mkdir(path.join(sourcePath, "auth", "nested"), { recursive: true });
  await writeFile(path.join(sourcePath, "auth", "nested", "token.json"), "private");

  const prepared = await prepareResource(skillCandidate(sourceRoot, sourcePath));
  const inspection = await inspectPreparedResource(prepared);
  assert.ok(inspection.sensitivePaths.includes("SKILL.md"));
  assert.ok(Object.isFrozen(inspection.sensitivePaths));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith(".envrc")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith(".env-production")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith("auth.json")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith("OAuth.json")));
  assert.ok(inspection.excludedPaths.some((entry) => entry === "auth"));
  await assert.rejects(lstat(libraryDir), { code: "ENOENT" });
  const previewFiles = readPreparedResource(prepared).files;
  const preview = previewFiles.find((file) => file.path === "SKILL.md");
  assert.ok(preview);
  assert.equal(preview.bytes.toString("utf8"), "apiKey=sk_live_approvedsecret123");
  assert.ok(!maskSensitiveText(preview.bytes.toString("utf8")).includes("sk_live_approvedsecret123"));
  preview.bytes.fill(0);
  await assert.rejects(importPreparedResource(libraryDir, prepared, {
    confirmed: true,
    groupIds: [],
    inspection,
    approvedSensitivePaths: [],
  }), /approval/i);
  await assert.rejects(lstat(libraryDir), { code: "ENOENT" });

  await rm(sourcePath, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "apiKey=sk_live_unapprovedsecret456");
  await writeFile(path.join(sourcePath, "new-secret.txt"), "sk_live_addedlatersecret789");
  const changedPrepared = await prepareResource(skillCandidate(sourceRoot, sourcePath));
  await assert.rejects(importPreparedResource(libraryDir, changedPrepared, {
    confirmed: true,
    groupIds: [],
    inspection,
    approvedSensitivePaths: inspection.sensitivePaths,
  }), /inspection does not match/i);
  await assert.rejects(lstat(libraryDir), { code: "ENOENT" });
  const saved = await importPreparedResource(libraryDir, prepared, {
    confirmed: true,
    groupIds: [],
    inspection,
    approvedSensitivePaths: inspection.sensitivePaths,
  });
  assert.ok(saved);
  assert.deepEqual(saved.files.map((file) => file.path), ["SKILL.md"]);
  const stored = await readSnapshotFiles(libraryDir, saved);
  const storedText = stored.find((file) => file.path === "SKILL.md")?.bytes.toString("utf8");
  assert.equal(storedText, "apiKey=sk_live_approvedsecret123");
  assert.ok(!storedText?.includes("unapprovedsecret456"));
  assert.ok(!stored.some((file) => file.path === "new-secret.txt"));
});
