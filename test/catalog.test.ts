import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertModernCatalog, importPreparedResource, importResource, listSnapshots, loadCatalog, newCatalog, prepareResource, readPreparedResource, readSnapshotFiles, renameSavedItem, saveCatalog, saveNameChanges } from "../src/catalog.ts";
import { changeSavedDestination } from "../src/resource-mutations.ts";
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
  assertModernCatalog(catalog);
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

test("loads existing duplicates, blocks generic saves/imports, and atomically renames only conflict members without changing bytes or identity", async (t) => {
  const box = await sandbox(t);
  const unrelated = await addItem(box, "Unrelated");
  const { first, second } = await duplicateFixture(box);
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  await assert.rejects(saveCatalog(box.libraryDir, catalog), /duplicate|conflict/i);
  await assert.rejects(addItem(box, "Third"), /duplicate|conflict/i);
  await assert.rejects(renameSavedItem(box.libraryDir, unrelated.id, "Changed"), /duplicate|conflict/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  const bytes = await readSnapshotFiles(box.libraryDir, second);
  const next = structuredClone(catalog);
  next.items.find((item) => item.id === second.id)!.name = "Separate";
  next.groups.find((group) => group.id === "review")!.name = "Review group";
  await saveNameChanges(box.libraryDir, catalog, next);
  const after = await loadCatalog(box.libraryDir);
  assertModernCatalog(after);
  const renamed = after.items.find((item) => item.id === second.id)!;
  assert.deepEqual(renamed, { ...second, name: "Separate" });
  assert.deepEqual(after.groups, next.groups);
  assert.deepEqual(after.items.find((item) => item.id === first.id), catalog.items.find((item) => item.id === first.id));
  assert.deepEqual(after.items.find((item) => item.id === unrelated.id), catalog.items.find((item) => item.id === unrelated.id));
  assert.deepEqual(await readSnapshotFiles(box.libraryDir, renamed), bytes);
  assert.equal((await listSnapshots(box.libraryDir)).length, 3);
});

test("rename accepts current source bytes with an old descriptor but refuses symlink content", async (t) => {
  const box = await sandbox(t);
  const item = await addItem(box, "Original");
  const manifest = path.join(box.libraryDir, "catalog.json");
  assert.equal(item.content.kind, "tree");
  const file = path.join(box.libraryDir, ...item.content.path.split("/"), "SKILL.md");
  const edited = Buffer.from("direct current source edit");
  await writeFile(file, edited);
  const renamed = await renameSavedItem(box.libraryDir, item.id, "New");
  assert.equal(renamed.name, "New");
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, renamed))[0]!.bytes, edited);
  assert.equal((await loadCatalog(box.libraryDir)).items[0]!.files[0]!.sha256, item.files[0]!.sha256);

  const beforeSymlink = await readFile(manifest);
  await rm(file);
  await symlink(path.join(item.sourcePath, "SKILL.md"), file);
  await assert.rejects(renameSavedItem(box.libraryDir, item.id, "Another"), /symbolic|unsafe/i);
  assert.deepEqual(await readFile(manifest), beforeSymlink);
});

test("imports an owner-only skill tree as canonical sources content and preserves metadata after origin removal", async (t) => {
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
  assert.deepEqual(saved.destination, { kind: "project", path: ".pi/skills/portable" });
  assert.equal(saved.content.kind, "tree");
  assert.equal(saved.content.path, `sources/${saved.id}`);
  assert.equal(saved.sourcePath, sourcePath);
  assert.equal(saved.name, "portable");
  assert.ok(Number.isFinite(Date.parse(saved.savedAt)));
  assert.ok(saved.files.some((file) => file.path === "scripts/tool.sh" && file.mode === 0o755));
  const savedRoot = path.join(libraryDir, ...saved.content.path.split("/"));
  for (const relative of [".cache/private.txt", ".npm/private.txt", "auth/private.ts", "auth/nested/tokens.json"]) {
    assert.ok(!saved.files.some((file) => file.path === relative));
    await assert.rejects(lstat(path.join(savedRoot, ...relative.split("/"))), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(path.join(sourcePath, "SKILL.md")), originalText);
  assert.equal((await lstat(path.join(sourcePath, "scripts", "tool.sh"))).mode & 0o777, originalMode);

  const loaded = await loadCatalog(libraryDir);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.groups.map((group) => group.itemIds), [[saved.id], [saved.id]]);
  assert.equal((await lstat(libraryDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(libraryDir, "catalog.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(savedRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(savedRoot, "assets.bin"))).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(libraryDir, "items")), { code: "ENOENT" });

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

test("rejects symlinked registered source content before reading bytes outside the private store", async (t) => {
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
  await rm(path.join(libraryDir, ...saved.content.path.split("/")), { recursive: true });
  await symlink(outside, path.join(libraryDir, ...saved.content.path.split("/")), "dir");

  await assert.rejects(readSnapshotFiles(libraryDir, saved), /unsafe|symbolic|outside/i);
});

test("imports a single-file resource into its UUID sources path without creating items", async (t) => {
  const box = await sandbox(t);
  const sourcePath = path.join(box.sourceRoot, "instructions.md");
  const sourceBytes = Buffer.from("instructions from origin\n");
  await writeFile(sourcePath, sourceBytes);
  const imported = await importResource(box.libraryDir, {
    id: "single-file-import", kind: "instruction", source: "fixture-origin", scope: "user",
    sourceRoot: box.sourceRoot, sourcePath, name: "Instructions",
    destination: { kind: "project", path: "AGENTS.md" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(imported);
  assert.equal(imported.content.kind, "file");
  assert.equal(imported.content.path, `sources/${imported.id}/instructions.md`);
  const target = path.join(box.libraryDir, ...imported.content.path.split("/"));
  assert.deepEqual(await readFile(target), sourceBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, "items")), { code: "ENOENT" });
  await rm(sourcePath);
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, imported))[0]!.bytes, sourceBytes);
});

test("v1 catalogs remain readable while import and source mutators refuse writes", async (t) => {
  const box = await sandbox(t);
  const legacyId = "123e4567-e89b-42d3-a456-426614174099";
  const legacyBytes = Buffer.from("legacy source bytes\n");
  const legacyRoot = path.join(box.libraryDir, "items", legacyId, "files");
  await mkdir(legacyRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(legacyRoot, "legacy.md"), legacyBytes, { mode: 0o600 });
  const legacy = {
    version: 1,
    items: [{
      id: legacyId, kind: "instruction", source: "old-origin", scope: "user", sourcePath: "/deleted/legacy.md",
      destination: { kind: "project", path: "AGENTS.md" }, name: "Legacy", savedAt: "2026-10-05T00:00:00.000Z",
      files: [{ path: "legacy.md", mode: 0o644, sha256: createHash("sha256").update(legacyBytes).digest("hex") }],
    }],
    groups: [],
  } as const;
  const catalogPath = path.join(box.libraryDir, "catalog.json");
  const legacyRaw = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(catalogPath, legacyRaw, { mode: 0o600 });
  const loaded = await loadCatalog(box.libraryDir);
  assert.equal(loaded.version, 1);
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, loaded.items[0]!))[0]!.bytes, legacyBytes);

  const newSourcePath = path.join(box.sourceRoot, "new.md");
  await writeFile(newSourcePath, "new import\n");
  await assert.rejects(importResource(box.libraryDir, {
    id: "new-file", kind: "instruction", source: "new-origin", scope: "user",
    sourceRoot: box.sourceRoot, sourcePath: newSourcePath, name: "New",
    destination: { kind: "project", path: "new.md" },
  }, { confirmed: true, groupIds: [] }), /catalog v2|migrat/i);
  await assert.rejects(changeSavedDestination(box.libraryDir, legacyId, { kind: "global-only" }), /catalog v2|migrat/i);
  assert.deepEqual(await readFile(catalogPath), legacyRaw);
  assert.deepEqual(await readFile(path.join(legacyRoot, "legacy.md")), legacyBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, "sources")), { code: "ENOENT" });
  assert.deepEqual((await readdir(path.join(box.libraryDir, "items", legacyId, "files"))).sort(), ["legacy.md"]);
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
