import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMigrationBackupManifest,
  parseMigrationBackupManifest,
  verifyMigrationBackup,
  type MigrationBackupExpected,
  type MigrationBackupInputEntry,
} from "../src/migration-backup.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface OriginalFile extends MigrationBackupInputEntry {
  readonly bytes: Buffer;
}

function originalFiles(): OriginalFile[] {
  const itemBytes = Buffer.from("legacy item snapshot bytes\n");
  const catalog = Buffer.from(`${JSON.stringify({
    version: 1,
    items: [{
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "instruction",
      source: "synthetic-origin",
      scope: "project",
      sourcePath: "/synthetic/deleted/origin.md",
      destination: { kind: "project", path: "AGENTS.md" },
      name: "Legacy instruction",
      savedAt: "2026-10-05T00:00:00.000Z",
      files: [{ path: "README.md", mode: 0o644, sha256: digest(itemBytes) }],
    }],
    groups: [],
  })}\n`);
  return [
    { originalPath: "catalog.json", bytes: catalog, mode: 0o600, sha256: digest(catalog) },
    {
      originalPath: "items/123e4567-e89b-42d3-a456-426614174000/README.md",
      bytes: itemBytes,
      mode: 0o644,
      sha256: digest(itemBytes),
    },
    {
      originalPath: "items/pm-diff/private.json",
      bytes: Buffer.from('{"apiKey":"SYNTHETIC_NOT_A_REAL_SECRET_BACKUP_ONLY"}\n'),
      mode: 0o640,
      sha256: "",
    },
    {
      originalPath: "sources/.env.production",
      bytes: Buffer.from("TOKEN=synthetic-private-source\n"),
      mode: 0o751,
      sha256: "",
    },
    {
      originalPath: "sources/123e4567-e89b-42d3-a456-426614174000/SKILL.md",
      bytes: Buffer.from("# source bytes\n"),
      mode: 0o755,
      sha256: "",
    },
  ].map((file) => ({ ...file, sha256: file.sha256 || digest(file.bytes) }));
}

function inputEntries(files: readonly OriginalFile[]): MigrationBackupInputEntry[] {
  return files.map(({ originalPath, sha256, mode }) => ({ originalPath, sha256, mode }));
}

async function treeSnapshot(root: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (target: string, relative: string): Promise<void> => {
    const stat = await lstat(target, { bigint: true });
    const metadata = `${relative || "."}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stat.isSymbolicLink()) entries.push(`L:${metadata}:${await readlink(target)}`);
    else if (stat.isDirectory()) {
      entries.push(`D:${metadata}`);
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push(`F:${metadata}:${digest(await readFile(target))}`);
    else entries.push(`S:${metadata}`);
  };
  await visit(root, "");
  return entries.join("\n");
}

async function backupFixture(t: test.TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "copi-migration-backup-"));
  const libraryRoot = await realpath(temporary);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const backupDir = `.migration-backups/${randomUUID()}`;
  const backupRoot = path.join(libraryRoot, ...backupDir.split("/"));
  const filesRoot = path.join(backupRoot, "files");
  const files = originalFiles();
  const entries = inputEntries(files);
  const manifestBytes = buildMigrationBackupManifest(entries);
  const manifestSha256 = digest(manifestBytes);

  await mkdir(path.join(libraryRoot, ".migration-backups"), { mode: 0o700 });
  await chmod(path.join(libraryRoot, ".migration-backups"), 0o700);
  await mkdir(backupRoot, { mode: 0o700 });
  await chmod(backupRoot, 0o700);
  await mkdir(filesRoot, { mode: 0o700 });
  await chmod(filesRoot, 0o700);
  for (const file of files) {
    const target = path.join(filesRoot, ...file.originalPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.bytes, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  const directories = new Set<string>([path.join(libraryRoot, ".migration-backups"), backupRoot, filesRoot]);
  for (const file of files) {
    let directory = path.dirname(path.join(filesRoot, ...file.originalPath.split("/")));
    while (directory.startsWith(filesRoot)) {
      directories.add(directory);
      if (directory === filesRoot) break;
      directory = path.dirname(directory);
    }
  }
  for (const directory of directories) await chmod(directory, 0o700);
  const manifestPath = path.join(backupRoot, "manifest.json");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  await chmod(manifestPath, 0o600);

  const expected: MigrationBackupExpected = { libraryRoot, backupDir, manifestBytes, manifestSha256, entries };
  return { libraryRoot, backupDir, backupRoot, filesRoot, files, entries, manifestPath, manifestBytes, expected };
}

test("builds and parses fixed sorted manifest bytes without embedding original contents", () => {
  const files = originalFiles();
  const unsorted = [files[4]!, files[2]!, files[0]!, files[3]!, files[1]!];
  const actual = buildMigrationBackupManifest(inputEntries(unsorted));
  const expected = Buffer.from(
    `{"version":1,"entries":[{"originalPath":"catalog.json","backupPath":"files/catalog.json","sha256":"${digest(files[0]!.bytes)}","mode":384},{"originalPath":"items/123e4567-e89b-42d3-a456-426614174000/README.md","backupPath":"files/items/123e4567-e89b-42d3-a456-426614174000/README.md","sha256":"${digest(files[1]!.bytes)}","mode":420},{"originalPath":"items/pm-diff/private.json","backupPath":"files/items/pm-diff/private.json","sha256":"${digest(files[2]!.bytes)}","mode":416},{"originalPath":"sources/.env.production","backupPath":"files/sources/.env.production","sha256":"${digest(files[3]!.bytes)}","mode":489},{"originalPath":"sources/123e4567-e89b-42d3-a456-426614174000/SKILL.md","backupPath":"files/sources/123e4567-e89b-42d3-a456-426614174000/SKILL.md","sha256":"${digest(files[4]!.bytes)}","mode":493}]}\n`,
  );
  assert.deepEqual(actual, expected);
  assert.ok(!actual.includes(Buffer.from("SYNTHETIC_NOT_A_REAL_SECRET_BACKUP_ONLY")));
  assert.ok(!actual.includes(Buffer.from("TOKEN=synthetic-private-source")));
  assert.deepEqual(parseMigrationBackupManifest(actual), {
    version: 1,
    entries: [
      { originalPath: "catalog.json", backupPath: "files/catalog.json", sha256: digest(files[0]!.bytes), mode: 0o600 },
      { originalPath: "items/123e4567-e89b-42d3-a456-426614174000/README.md", backupPath: "files/items/123e4567-e89b-42d3-a456-426614174000/README.md", sha256: digest(files[1]!.bytes), mode: 0o644 },
      { originalPath: "items/pm-diff/private.json", backupPath: "files/items/pm-diff/private.json", sha256: digest(files[2]!.bytes), mode: 0o640 },
      { originalPath: "sources/.env.production", backupPath: "files/sources/.env.production", sha256: digest(files[3]!.bytes), mode: 0o751 },
      { originalPath: "sources/123e4567-e89b-42d3-a456-426614174000/SKILL.md", backupPath: "files/sources/123e4567-e89b-42d3-a456-426614174000/SKILL.md", sha256: digest(files[4]!.bytes), mode: 0o755 },
    ],
  });
});

test("rejects invalid input coverage, paths, order, hashes, modes, and manifest keys", () => {
  const valid = originalFiles();
  const entries = inputEntries(valid);
  const catalog = entries[0]!;
  assert.throws(() => buildMigrationBackupManifest(entries.slice(1)), /catalog|manifest|entry/i);
  assert.throws(() => buildMigrationBackupManifest([catalog, catalog]), /duplicate|overlap|entry/i);
  assert.throws(() => buildMigrationBackupManifest([
    catalog,
    { originalPath: "items/a", sha256: digest(Buffer.from("a")), mode: 0o600 },
    { originalPath: "items/a/child", sha256: digest(Buffer.from("b")), mode: 0o600 },
  ]), /duplicate|overlap|entry/i);
  for (const originalPath of [
    "/items/absolute", "items/../escape", "items\\windows", "sources//empty", "sources/./dot", "elsewhere/file", "items/bad\0name", "items",
  ]) {
    assert.throws(() => buildMigrationBackupManifest([
      catalog,
      { originalPath, sha256: digest(Buffer.from("x")), mode: 0o600 },
    ]), /unsafe|invalid|path|entry/i, originalPath);
  }
  for (const mode of [-1, 0o1000, 1.5, Number.NaN]) {
    assert.throws(() => buildMigrationBackupManifest([{ ...catalog, mode }]), /mode|entry|manifest/i);
  }
  assert.throws(() => buildMigrationBackupManifest([{ ...catalog, sha256: "A".repeat(64) }]), /hash|sha|entry|manifest/i);
  assert.throws(() => buildMigrationBackupManifest([
    catalog,
    { ...entries[1]!, unexpected: true } as unknown as MigrationBackupInputEntry,
  ]), /field|entry|manifest/i);

  const bytes = buildMigrationBackupManifest(entries);
  const parsed = parseMigrationBackupManifest(bytes);
  const reversed = Buffer.from(`${JSON.stringify({ version: 1, entries: [...parsed.entries].reverse() })}\n`);
  const extraTopLevel = Buffer.from(bytes.toString("utf8").replace('{"version":1,', '{"version":1,"extra":true,'));
  const extraEntry = Buffer.from(bytes.toString("utf8").replace('"mode":384}', '"mode":384,"extra":true}'));
  const wrongMapping = parsed.entries.map((entry, index) => index === 0 ? { ...entry, backupPath: "files/items/rebound" } : entry);
  const badHash = parsed.entries.map((entry, index) => index === 0 ? { ...entry, sha256: "A".repeat(64) } : entry);
  const badMode = parsed.entries.map((entry, index) => index === 0 ? { ...entry, mode: 0o1000 } : entry);
  const unsafePath = parsed.entries.map((entry, index) => index === 0
    ? { ...entry, originalPath: "items/../catalog.json", backupPath: "files/items/../catalog.json" }
    : entry);
  const overlap = [...parsed.entries, {
    ...parsed.entries[1]!,
    originalPath: "items/123e4567-e89b-42d3-a456-426614174000",
    backupPath: "files/items/123e4567-e89b-42d3-a456-426614174000",
  }].sort((left, right) => left.originalPath < right.originalPath ? -1 : left.originalPath > right.originalPath ? 1 : 0);
  const malformedEntries = [wrongMapping, badHash, badMode, unsafePath, overlap].map((entries) =>
    Buffer.from(`${JSON.stringify({ version: 1, entries })}\n`));
  for (const malformed of [Buffer.from("not json"), reversed, extraTopLevel, extraEntry, ...malformedEntries]) {
    assert.throws(() => parseMigrationBackupManifest(malformed), /invalid|manifest|entry|canonical|order|unsafe|mode|hash|SHA/i);
  }
});

test("verifies synthetic catalog/items/sources backup privately and leaves every inode and byte unchanged", async (t) => {
  const fixture = await backupFixture(t);
  const before = await treeSnapshot(fixture.libraryRoot);
  assert.equal(await verifyMigrationBackup(fixture.expected), undefined);
  assert.equal(await treeSnapshot(fixture.libraryRoot), before);
  assert.equal((await lstat(fixture.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(fixture.manifestPath))).mode & 0o777, 0o700);
  for (const file of fixture.files) {
    const stored = path.join(fixture.filesRoot, ...file.originalPath.split("/"));
    assert.deepEqual(await readFile(stored), file.bytes);
    assert.equal((await lstat(stored)).mode & 0o777, 0o600, "backup data is private even when its original mode differs");
    assert.equal(fixture.manifestBytes.includes(file.bytes), false, "manifest carries only path, digest, and original mode");
  }
});

test("rejects changed manifests, recomputed unknown coverage, and recalculated unbound files", async (t) => {
  const fixture = await backupFixture(t);
  const altered = Buffer.from(JSON.stringify({
    version: 1,
    entries: [
      ...parseMigrationBackupManifest(fixture.manifestBytes).entries,
      { originalPath: "sources/unknown-extra", backupPath: "files/sources/unknown-extra", sha256: digest(Buffer.from("extra")), mode: 0o600 },
    ],
  }) + "\n");
  await writeFile(fixture.manifestPath, altered);
  const before = await treeSnapshot(fixture.libraryRoot);
  await assert.rejects(verifyMigrationBackup(fixture.expected), /manifest|fixed|commit|coverage|entry/i);
  assert.equal(await treeSnapshot(fixture.libraryRoot), before);

  const modifiedExpected: MigrationBackupExpected = {
    ...fixture.expected,
    manifestBytes: altered,
    manifestSha256: digest(altered),
  };
  await assert.rejects(verifyMigrationBackup(modifiedExpected), /coverage|input|entry|manifest/i);

  const dataFixture = await backupFixture(t);
  const data = path.join(dataFixture.filesRoot, "items/pm-diff/private.json");
  await writeFile(data, Buffer.from("recalculated unknown file\n"), { mode: 0o600 });
  const dataBefore = await treeSnapshot(dataFixture.libraryRoot);
  await assert.rejects(verifyMigrationBackup(dataFixture.expected), /sha|hash|digest|changed|commit|entry/i);
  assert.equal(await treeSnapshot(dataFixture.libraryRoot), dataBefore);
});

test("rejects missing and extra backup nodes without modifying existing custody", async (t) => {
  const missing = await backupFixture(t);
  const missingFile = path.join(missing.filesRoot, "sources/.env.production");
  await unlink(missingFile);
  const missingBefore = await treeSnapshot(missing.libraryRoot);
  await assert.rejects(verifyMigrationBackup(missing.expected), /missing|entry|file|backup|manifest/i);
  assert.equal(await treeSnapshot(missing.libraryRoot), missingBefore);

  const extra = await backupFixture(t);
  const extraFile = path.join(extra.filesRoot, "sources/unlisted.bin");
  await writeFile(extraFile, Buffer.from("unknown extra\n"), { mode: 0o600 });
  const extraBefore = await treeSnapshot(extra.libraryRoot);
  await assert.rejects(verifyMigrationBackup(extra.expected), /extra|unknown|entry|backup|manifest/i);
  assert.equal(await treeSnapshot(extra.libraryRoot), extraBefore);
});

test("rejects symlink files and directories while preserving outside bytes and inode", async (t) => {
  const fileCase = await backupFixture(t);
  const outsideFile = path.join(path.dirname(fileCase.libraryRoot), `outside-${randomUUID()}.bin`);
  t.after(() => rm(outsideFile, { force: true }));
  await writeFile(outsideFile, Buffer.from("outside custody bytes\n"), { mode: 0o600 });
  const outsideBefore = await treeSnapshot(outsideFile);
  const targetFile = path.join(fileCase.filesRoot, "catalog.json");
  await unlink(targetFile);
  await symlink(outsideFile, targetFile);
  const linkedFileBefore = await lstat(outsideFile, { bigint: true });
  await assert.rejects(verifyMigrationBackup(fileCase.expected), /symbolic|symlink|unsafe|file|backup/i);
  const linkedFileAfter = await lstat(outsideFile, { bigint: true });
  assert.equal(linkedFileAfter.dev, linkedFileBefore.dev);
  assert.equal(linkedFileAfter.ino, linkedFileBefore.ino);
  assert.equal(await treeSnapshot(outsideFile), outsideBefore);

  const dirCase = await backupFixture(t);
  const outsideDir = path.join(path.dirname(dirCase.libraryRoot), `outside-dir-${randomUUID()}`);
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  await mkdir(outsideDir, { mode: 0o700 });
  const outsideDirFile = path.join(outsideDir, "private.json");
  await writeFile(outsideDirFile, Buffer.from("outside directory bytes\n"), { mode: 0o600 });
  const outsideDirBefore = await treeSnapshot(outsideDir);
  const sourceDir = path.join(dirCase.filesRoot, "sources");
  await rm(sourceDir, { recursive: true });
  await symlink(outsideDir, sourceDir);
  const outsideDirIdentity = await lstat(outsideDir, { bigint: true });
  await assert.rejects(verifyMigrationBackup(dirCase.expected), /symbolic|symlink|unsafe|directory|backup/i);
  const outsideDirAfter = await lstat(outsideDir, { bigint: true });
  assert.equal(outsideDirAfter.dev, outsideDirIdentity.dev);
  assert.equal(outsideDirAfter.ino, outsideDirIdentity.ino);
  assert.equal(await treeSnapshot(outsideDir), outsideDirBefore);
});

test("rejects wrong private modes, noncanonical or symlinked roots, and backup path escape", async (t) => {
  const modes = await backupFixture(t);
  await chmod(path.join(modes.filesRoot, "sources"), 0o755);
  await assert.rejects(verifyMigrationBackup(modes.expected), /mode|private|directory|backup/i);
  const fileMode = await backupFixture(t);
  await chmod(path.join(fileMode.filesRoot, "catalog.json"), 0o644);
  await assert.rejects(verifyMigrationBackup(fileMode.expected), /mode|private|file|backup/i);
  const manifestMode = await backupFixture(t);
  await chmod(manifestMode.manifestPath, 0o644);
  await assert.rejects(verifyMigrationBackup(manifestMode.expected), /mode|private|manifest/i);
  const specialMode = await backupFixture(t);
  await chmod(path.join(specialMode.filesRoot, "catalog.json"), 0o4600);
  await assert.rejects(verifyMigrationBackup(specialMode.expected), /mode|private|file|backup/i);

  const canonical = await backupFixture(t);
  const alias = path.join(path.dirname(canonical.libraryRoot), `root-alias-${randomUUID()}`);
  t.after(() => rm(alias, { force: true }));
  await symlink(canonical.libraryRoot, alias);
  await assert.rejects(verifyMigrationBackup({ ...canonical.expected, libraryRoot: alias }), /canonical|symbolic|symlink|root/i);
  await assert.rejects(verifyMigrationBackup({
    ...canonical.expected,
    backupDir: path.join(path.dirname(canonical.libraryRoot), "outside-backup"),
  }), /backup|canonical|path|escape/i);
});

test("detects a same-inode edit between no-follow open and post-read identity checks", async (t) => {
  const fixture = await backupFixture(t);
  const target = path.join(fixture.filesRoot, "catalog.json");
  const before = await lstat(target, { bigint: true });
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  const prototype: object = Object.getPrototypeOf(handle);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "readFile");
  assert.ok(descriptor && typeof descriptor.value === "function");
  const originalRead = descriptor.value as (...args: unknown[]) => Promise<Buffer>;
  let reads = 0;
  Object.defineProperty(prototype, "readFile", {
    ...descriptor,
    value: async function (this: object, ...args: unknown[]): Promise<Buffer> {
      const bytes = await Reflect.apply(originalRead, this, args) as Buffer;
      reads += 1;
      if (reads === 1) await writeFile(target, Buffer.from("same inode changed after no-follow read\n"));
      return bytes;
    },
  });
  try {
    await assert.rejects(verifyMigrationBackup(fixture.expected), /changed|modified|stable|identity|hash|digest/i);
  } finally {
    Object.defineProperty(prototype, "readFile", descriptor);
    await handle.close();
  }
  assert.ok(reads >= 1, "backup bytes were read through a real file handle before the injected same-inode edit");
  const after = await lstat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});
