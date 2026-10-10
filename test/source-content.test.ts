import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importResource, loadCatalog, parseStoredCatalog, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { sandbox } from "./helpers/sandbox.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function isCaseInsensitiveAlias(target: string, alias: string): Promise<boolean> {
  const canonicalTarget = await realpath(target);
  const canonicalAlias = await realpath(alias).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return canonicalAlias === canonicalTarget;
}

function v2Catalog(content: unknown, files?: Array<{ path: string; mode: number; sha256: string }>, kind: "instruction" | "skill" = "instruction") {
  return {
    version: 2,
    items: [{
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind,
      source: "test-origin",
      scope: "project",
      sourcePath: "/deleted/origin.md",
      destination: { kind: "project", path: "AGENTS.md" },
      name: "Instructions",
      savedAt: "2026-10-05T00:00:00.000Z",
      files: files ?? [{ path: "origin.md", mode: 0o644, sha256: "0".repeat(64) }],
      content,
    }],
    groups: [],
  };
}

test("parses v1 read-only data and v2 content locations while rejecting unsafe/overlapping locations", () => {
  const legacy = v2Catalog(undefined);
  legacy.version = 1;
  delete (legacy.items[0] as Partial<typeof legacy.items[number]>).content;
  assert.equal(parseStoredCatalog(legacy).version, 1);

  const modern = v2Catalog({ kind: "file", path: "sources/123e4567-e89b-42d3-a456-426614174000/origin.md" });
  assert.deepEqual(parseStoredCatalog(modern), modern);
  for (const content of [
    { kind: "file", path: "/tmp/escape.md" },
    { kind: "file", path: "sources/../outside.md" },
    { kind: "tree", path: "items/123e4567-e89b-42d3-a456-426614174000" },
    { kind: "unknown", path: "sources/file" },
  ]) assert.throws(() => parseStoredCatalog(v2Catalog(content)), /catalog|content|path/i);

  const duplicate = v2Catalog({ kind: "file", path: "sources/123e4567-e89b-42d3-a456-426614174000/origin.md" });
  const duplicateItem = structuredClone(duplicate.items[0]!);
  duplicateItem.id = randomUUID();
  duplicateItem.name = "Duplicate path";
  duplicate.items.push(duplicateItem);
  assert.throws(() => parseStoredCatalog(duplicate), /duplicate|overlap|content/i);

  const overlapping = v2Catalog({ kind: "tree", path: "sources/shared" }, undefined, "skill");
  const second = structuredClone(overlapping.items[0]!);
  second.id = randomUUID();
  second.kind = "instruction";
  second.name = "Child";
  second.content = { kind: "file", path: "sources/shared/child.md" };
  second.files = [{ path: "child.md", mode: 0o600, sha256: "0".repeat(64) }];
  overlapping.items.push(second);
  assert.throws(() => parseStoredCatalog(overlapping), /duplicate|overlap|content/i);
});

type ReadContent = Array<{ path: string; mode: number; sha256: string; bytes: Buffer }>;

async function readPureSourceContent(libraryDir: string, item: unknown): Promise<ReadContent> {
  const reader: unknown = Reflect.get(await import("../src/source-content.ts"), "readSourceContent");
  assert.equal(typeof reader, "function", "readSourceContent API must be exported");
  if (typeof reader !== "function") throw new Error("readSourceContent API is unavailable");
  const result: unknown = await Reflect.apply(reader, undefined, [libraryDir, item]);
  assert.ok(Array.isArray(result), "reader returns a file array");
  return result as ReadContent;
}

test("pure v2 file fixture reads current source bytes/SHA without rewriting the old descriptor", async (t) => {
  const box = await sandbox(t);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const library = box.libraryDir;
  const target = path.join(library, "sources", id, "origin.md");
  await mkdir(path.dirname(target), { recursive: true });
  const initial = Buffer.from("saved descriptor bytes\n");
  const edited = Buffer.from("manual current bytes\n");
  await writeFile(target, edited);
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(v2Catalog({ kind: "file", path: `sources/${id}/origin.md` }, [{ path: "origin.md", mode: 0o644, sha256: digest(initial) }]), null, 2)}\n`);

  const stored = parseStoredCatalog(JSON.parse(await readFile(path.join(library, "catalog.json"), "utf8")) as unknown);
  assert.equal(stored.version, 2);
  const descriptor = stored.items[0]!.files[0]!.sha256;
  const file = (await readPureSourceContent(library, stored.items[0]!))[0]!;
  assert.deepEqual(file.bytes, edited);
  assert.equal(file.sha256, digest(edited));
  assert.equal(file.mode, 0o644);
  assert.equal(stored.items[0]!.files[0]!.sha256, descriptor);
  assert.equal(descriptor, digest(initial));
  assert.deepEqual(await readFile(path.join(library, "catalog.json")), Buffer.from(`${JSON.stringify(v2Catalog({ kind: "file", path: `sources/${id}/origin.md` }, [{ path: "origin.md", mode: 0o644, sha256: descriptor }]), null, 2)}\n`));
});

test("pure v2 tree fixture tracks additions/removals and exclusions while retaining registered mode", async (t) => {
  const box = await sandbox(t);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const library = box.libraryDir;
  const root = path.join(library, "sources", id);
  await mkdir(path.join(root, "docs"), { recursive: true });
  const skill = Buffer.from("manual SKILL bytes\n");
  const initial = Buffer.from("original SKILL bytes\n");
  await writeFile(path.join(root, "SKILL.md"), skill, { mode: 0o755 });
  await writeFile(path.join(root, "docs", "removed.md"), "will disappear\n");
  await rm(path.join(root, "docs", "removed.md"));
  await writeFile(path.join(root, "added.sh"), "#!/bin/sh\n", { mode: 0o751 });
  await writeFile(path.join(root, ".envrc"), "SECRET=excluded\n");
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(v2Catalog({ kind: "tree", path: `sources/${id}` }, [
    { path: "SKILL.md", mode: 0o644, sha256: digest(initial) },
    { path: "docs/removed.md", mode: 0o600, sha256: digest(Buffer.from("will disappear\n")) },
  ], "skill"), null, 2)}\n`);

  const stored = parseStoredCatalog(JSON.parse(await readFile(path.join(library, "catalog.json"), "utf8")) as unknown);
  const files = await readPureSourceContent(library, stored.items[0]!);
  assert.deepEqual(files.map((file) => file.path), ["added.sh", "SKILL.md"]);
  const newFile = files.find((file) => file.path === "added.sh")!;
  const skillFile = files.find((file) => file.path === "SKILL.md")!;
  assert.deepEqual(skillFile.bytes, skill);
  assert.equal(skillFile.sha256, digest(skill));
  assert.equal(skillFile.mode, 0o644, "registered descriptor mode does not follow an unreviewed inode mode edit");
  assert.equal(newFile.mode, (await lstat(path.join(root, "added.sh"))).mode & 0o777);
  assert.ok(!files.some((file) => file.path.includes(".env")));
});

test("pure v2 reader refuses source-root symlink substitution and missing SKILL.md", async (t) => {
  const box = await sandbox(t);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const library = box.libraryDir;
  const source = path.join(library, "sources", id);
  const outside = path.join(box.root, "outside");
  await mkdir(source, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(source, "SKILL.md"), "safe\n");
  await writeFile(path.join(outside, "SKILL.md"), "outside\n");
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(v2Catalog({ kind: "tree", path: `sources/${id}` }, [{ path: "SKILL.md", mode: 0o644, sha256: "0".repeat(64) }], "skill"), null, 2)}\n`);
  const stored = parseStoredCatalog(JSON.parse(await readFile(path.join(library, "catalog.json"), "utf8")) as unknown);
  await rm(source, { recursive: true });
  await symlink(outside, source);
  await assert.rejects(readPureSourceContent(library, stored.items[0]!), /symbolic|symlink|unsafe/i);
  await rm(source);
  await mkdir(source);
  await assert.rejects(readPureSourceContent(library, stored.items[0]!), /SKILL\\.md|missing|required/i);
});

test("file content reads current bytes and SHA from sources after origin removal without rewriting descriptor", async (t) => {
  const box = await sandbox(t);
  const origin = path.join(box.sourceRoot, "instructions.md");
  const original = Buffer.from("Original instructions\n");
  await writeFile(origin, original);
  const item = await importResource(box.libraryDir, {
    id: "reader-file", kind: "instruction", source: "test-origin", scope: "project",
    sourceRoot: box.sourceRoot, sourcePath: origin, name: "Instructions",
    destination: { kind: "project", path: "AGENTS.md" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const location = item.content;
  assert.equal(location.kind, "file");
  assert.match(location.path, /^sources\/[0-9a-f-]+\/instructions\.md$/i);
  const storedPath = path.join(box.libraryDir, ...location.path.split("/"));
  assert.deepEqual(await readFile(storedPath), original);

  const edited = Buffer.from("Directly edited canonical bytes\n");
  await writeFile(storedPath, edited);
  await rm(origin);
  const current = await readSnapshotFiles(box.libraryDir, item);
  assert.equal(current.length, 1);
  assert.deepEqual(current[0]!.bytes, edited);
  assert.equal(current[0]!.sha256, digest(edited));
  assert.equal(item.files[0]!.sha256, digest(original), "direct edits must not silently rewrite the confirmed descriptor");
});

test("tree content tracks current included files, preserves registered modes, and requires SKILL.md", async (t) => {
  const box = await sandbox(t);
  const origin = path.join(box.sourceRoot, "portable");
  await mkdir(path.join(origin, "docs"), { recursive: true });
  await writeFile(path.join(origin, "SKILL.md"), "# Original skill\n");
  await writeFile(path.join(origin, "docs", "old.md"), "old\n");
  const item = await importResource(box.libraryDir, {
    id: "reader-tree", kind: "skill", source: "test-origin", scope: "project",
    sourceRoot: box.sourceRoot, sourcePath: origin, name: "Portable",
    destination: { kind: "project", path: ".pi/skills/portable" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const location = item.content;
  assert.equal(location.kind, "tree");
  const storedRoot = path.join(box.libraryDir, ...location.path.split("/"));
  const registered = item.files.find((file) => file.path === "SKILL.md")!;
  const currentSkill = Buffer.from("Direct edit\n");
  await writeFile(path.join(storedRoot, "SKILL.md"), currentSkill);
  await chmod(path.join(storedRoot, "SKILL.md"), 0o700);
  await rm(path.join(storedRoot, "docs", "old.md"));
  await writeFile(path.join(storedRoot, "new.sh"), "#!/bin/sh\n", { mode: 0o751 });
  await writeFile(path.join(storedRoot, ".envrc"), "SECRET=not-readable\n");
  await writeFile(path.join(storedRoot, ".cache"), "excluded\n");

  const files = await readSnapshotFiles(box.libraryDir, item);
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const newFile = files.find((file) => file.path === "new.sh");
  assert.ok(skillFile);
  assert.ok(newFile);
  assert.deepEqual(skillFile.bytes, currentSkill);
  assert.equal(skillFile.sha256, digest(currentSkill));
  assert.equal(skillFile.mode, registered.mode);
  assert.equal(item.files.find((file) => file.path === "SKILL.md")!.sha256, registered.sha256);
  assert.equal(newFile.mode, (await lstat(path.join(storedRoot, "new.sh"))).mode & 0o777);

  await rm(path.join(storedRoot, "SKILL.md"));
  await assert.rejects(readSnapshotFiles(box.libraryDir, item), /SKILL\.md|missing|required/i);
});

test("reader rejects same-inode source edits during byte reading", async (t) => {
  const box = await sandbox(t);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const target = path.join(box.libraryDir, "sources", id, "origin.md");
  await mkdir(path.dirname(target), { recursive: true });
  const beforeBytes = Buffer.from("before-read\n");
  const changedBytes = Buffer.from("after-read!\n");
  assert.equal(changedBytes.length, beforeBytes.length);
  await writeFile(target, beforeBytes);
  const parsed = parseStoredCatalog(v2Catalog({ kind: "file", path: `sources/${id}/origin.md` }, [
    { path: "origin.md", mode: 0o644, sha256: digest(beforeBytes) },
  ]));
  assert.equal(parsed.version, 2);
  const item = parsed.items[0]!;

  const originalStat = await lstat(target, { bigint: true });
  const handle = await open(target, "r");
  const prototype: object = Object.getPrototypeOf(handle);
  const method = Object.getOwnPropertyDescriptor(prototype, "readFile");
  assert.ok(method && typeof method.value === "function");
  const originalRead = method.value as (...args: unknown[]) => Promise<Buffer>;
  let changed = false;
  Object.defineProperty(prototype, "readFile", {
    ...method,
    value: async function (this: object, ...args: unknown[]): Promise<Buffer> {
      const bytes = await Reflect.apply(originalRead, this, args) as Buffer;
      if (!changed) {
        changed = true;
        await writeFile(target, changedBytes);
      }
      return bytes;
    },
  });
  try {
    await assert.rejects(readPureSourceContent(box.libraryDir, item), /changed|modified|consistent|stable/i);
  } finally {
    Object.defineProperty(prototype, "readFile", method);
    await handle.close();
  }
  assert.equal(changed, true);
  const finalStat = await lstat(target, { bigint: true });
  assert.equal(finalStat.dev, originalStat.dev, "the injected write keeps the original device");
  assert.equal(finalStat.ino, originalStat.ino, "the injected write keeps the original inode");
});

test("reader accepts one canonical content path alias on a case-insensitive filesystem", async (t) => {
  const box = await sandbox(t);
  const library = box.libraryDir;
  const target = path.join(library, "sources", "CaseProbe", "origin.md");
  await mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from("canonical content\n");
  await writeFile(target, bytes);
  const alias = path.join(library, "sources", "caseprobe", "origin.md");
  if (!await isCaseInsensitiveAlias(target, alias)) {
    t.skip("requires a case-insensitive filesystem to exercise path aliases");
    return;
  }
  const catalog = v2Catalog({ kind: "file", path: "sources/caseprobe/origin.md" }, [
    { path: "origin.md", mode: 0o644, sha256: digest(bytes) },
  ]);
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  const loaded = await loadCatalog(library);
  assert.equal(loaded.version, 2);
  const files = await readSnapshotFiles(library, loaded.items[0]!);
  assert.deepEqual(files[0]!.bytes, bytes);
  assert.equal(files[0]!.sha256, digest(bytes));
});

test("catalog runtime validation rejects distinct path spellings for one physical source", async (t) => {
  const box = await sandbox(t);
  const library = box.libraryDir;
  const target = path.join(library, "sources", "CaseProbe", "origin.md");
  await mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from("one physical source\n");
  await writeFile(target, bytes);
  const alias = path.join(library, "sources", "caseprobe", "origin.md");
  if (!await isCaseInsensitiveAlias(target, alias)) {
    t.skip("requires a case-insensitive filesystem to exercise path aliases");
    return;
  }
  const catalog = v2Catalog({ kind: "file", path: "sources/CaseProbe/origin.md" }, [
    { path: "origin.md", mode: 0o644, sha256: digest(bytes) },
  ]);
  const duplicate = structuredClone(catalog.items[0]!);
  duplicate.id = randomUUID();
  duplicate.name = "Physical alias";
  duplicate.content = { kind: "file", path: "sources/caseprobe/origin.md" };
  catalog.items.push(duplicate);
  assert.equal(parseStoredCatalog(catalog).version, 2, "the pure parser stays independent of filesystem semantics");
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(loadCatalog(library), /duplicate|overlap|physical|content/i);
});

test("catalog runtime validation rejects hard-linked content locations", async (t) => {
  const box = await sandbox(t);
  const library = box.libraryDir;
  const originalPath = path.join(library, "sources", "First", "origin.md");
  const linkedPath = path.join(library, "sources", "Second", "origin.md");
  await mkdir(path.dirname(originalPath), { recursive: true });
  await mkdir(path.dirname(linkedPath), { recursive: true });
  const bytes = Buffer.from("one inode, two paths\n");
  await writeFile(originalPath, bytes);
  await link(originalPath, linkedPath);
  assert.notEqual(await realpath(originalPath), await realpath(linkedPath));
  const originalStat = await lstat(originalPath, { bigint: true });
  const linkedStat = await lstat(linkedPath, { bigint: true });
  assert.equal(linkedStat.dev, originalStat.dev);
  assert.equal(linkedStat.ino, originalStat.ino);

  const catalog = v2Catalog({ kind: "file", path: "sources/First/origin.md" }, [
    { path: "origin.md", mode: 0o644, sha256: digest(bytes) },
  ]);
  const duplicate = structuredClone(catalog.items[0]!);
  duplicate.id = randomUUID();
  duplicate.name = "Hard-linked content";
  duplicate.content = { kind: "file", path: "sources/Second/origin.md" };
  catalog.items.push(duplicate);
  assert.equal(parseStoredCatalog(catalog).version, 2);
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  await assert.rejects(loadCatalog(library), /duplicate|overlap|physical|content/i);
});

test("saveCatalog rejects physical content aliases before writing", async (t) => {
  const box = await sandbox(t);
  const library = box.libraryDir;
  const target = path.join(library, "sources", "CaseProbe", "origin.md");
  await mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from("one physical source\n");
  await writeFile(target, bytes);
  const alias = path.join(library, "sources", "caseprobe", "origin.md");
  if (!await isCaseInsensitiveAlias(target, alias)) {
    t.skip("requires a case-insensitive filesystem to exercise path aliases");
    return;
  }
  const catalogPath = path.join(library, "catalog.json");
  const original = v2Catalog({ kind: "file", path: "sources/CaseProbe/origin.md" }, [
    { path: "origin.md", mode: 0o644, sha256: digest(bytes) },
  ]);
  await mkdir(library, { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(original, null, 2)}\n`);
  const loaded = await loadCatalog(library);
  assert.equal(loaded.version, 2);
  if (loaded.version !== 2) throw new Error("Expected a v2 fixture catalog.");
  const duplicate = structuredClone(loaded.items[0]!);
  duplicate.id = randomUUID();
  duplicate.name = "Physical alias";
  duplicate.content = { kind: "file", path: "sources/caseprobe/origin.md" };
  loaded.items.push(duplicate);
  const before = await readFile(catalogPath);

  await assert.rejects(saveCatalog(library, loaded), /duplicate|overlap|physical/i);
  assert.deepEqual(await readFile(catalogPath), before);
});

test("content roots and registered files refuse symlink substitution", async (t) => {
  const box = await sandbox(t);
  const origin = path.join(box.sourceRoot, "guide.md");
  await writeFile(origin, "safe\n");
  const item = await importResource(box.libraryDir, {
    id: "reader-link", kind: "instruction", source: "test-origin", scope: "project",
    sourceRoot: box.sourceRoot, sourcePath: origin, name: "Guide",
    destination: { kind: "project", path: "AGENTS.md" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const location = item.content;
  const target = path.join(box.libraryDir, ...location.path.split("/"));
  const outside = path.join(box.root, "outside.md");
  await writeFile(outside, "outside\n");
  await rm(target);
  await symlink(outside, target);
  await assert.rejects(readSnapshotFiles(box.libraryDir, item), /symbolic|symlink|unsafe/i);
});
