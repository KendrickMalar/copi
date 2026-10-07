import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitMigration, prepareMigration, readMigration, type PreparedMigration } from "../src/migration.ts";
import type { ChangeApproval } from "../src/resource-mutations.ts";
import { parseMigrationBackupManifest, verifyMigrationBackup } from "../src/migration-backup.ts";
import { storageTransactions, StorageTransactions } from "../src/storage-transaction.ts";
import {
  createLegacyLibrary,
  legacyFileBytes,
  makeLegacyItem,
  treeSnapshot,
  writeBytes,
  writeLegacyCatalog,
  writeLegacySnapshot,
} from "./helpers/legacy-library.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function approvalFor(plan: PreparedMigration): ChangeApproval {
  const view = readMigration(plan);
  return { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] };
}

test("adopts only existing sources, preserves source custody, and keeps a verified permanent backup", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourceBytes = Buffer.from("adopted source bytes differ from the legacy snapshot\n");
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", sourceBytes, 0o755);
    const oldCatalog = await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const sourceBefore = await lstat(sourcePath, { bigint: true });
    const oldItemPath = path.join(fixture.root, "items", makeLegacyItem().id, "files", "AGENTS.md");
    const itemBefore = await lstat(oldItemPath, { bigint: true });

    const plan = await prepareMigration(fixture.root);
    const view = readMigration(plan);
    assert.equal(view.status, "ready");
    assert.deepEqual(view.items.map(({ selection }) => selection), ["sources"]);

    const result = await commitMigration(plan, approvalFor(plan));

    assert.equal(result.catalogVersion, 2);
    assert.ok(result.backupDir);
    const sourceAfter = await lstat(sourcePath, { bigint: true });
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.equal(sourceAfter.mode & 0o777n, sourceBefore.mode & 0o777n);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    const itemAfter = await lstat(oldItemPath, { bigint: true });
    assert.equal(itemAfter.dev, itemBefore.dev);
    assert.equal(itemAfter.ino, itemBefore.ino);
    assert.deepEqual(await readFile(oldItemPath), legacyFileBytes);

    const migrated = JSON.parse(await readFile(path.join(fixture.root, "catalog.json"), "utf8")) as {
      version: number;
      items: Array<Record<string, unknown> & { content?: { kind: string; path: string } }>;
    };
    assert.equal(migrated.version, 2);
    assert.equal(migrated.items[0]?.content?.path, "sources/current/AGENTS.md");
    assert.equal(migrated.items[0]?.name, makeLegacyItem().name);
    assert.equal(migrated.items[0]?.source, makeLegacyItem().source);

    const backupRoot = path.join(fixture.root, ...result.backupDir.split("/"));
    const manifestBytes = await readFile(path.join(backupRoot, "manifest.json"));
    const manifest = parseMigrationBackupManifest(manifestBytes);
    assert.deepEqual(manifest.entries.map(({ originalPath }) => originalPath), [
      "catalog.json",
      `items/${makeLegacyItem().id}/files/AGENTS.md`,
      "sources/current/AGENTS.md",
    ]);
    const sourceBackup = path.join(backupRoot, "files/sources/current/AGENTS.md");
    assert.deepEqual(await readFile(sourceBackup), sourceBytes);
    assert.equal((await lstat(sourceBackup)).mode & 0o777, 0o600);
    assert.equal((await lstat(backupRoot)).mode & 0o777, 0o700);
    assert.equal(manifest.entries.find(({ originalPath }) => originalPath === "catalog.json")?.sha256, digest(oldCatalog));
    await verifyMigrationBackup({
      libraryRoot: fixture.root,
      backupDir: result.backupDir,
      manifestBytes,
      manifestSha256: digest(manifestBytes),
      entries: manifest.entries.map(({ originalPath, sha256, mode }) => ({ originalPath, sha256, mode })),
    });
    assert.equal((await readdir(fixture.root)).includes(".copi-transaction"), false);
    const committedTree = await treeSnapshot(fixture.root);
    await assert.rejects(commitMigration(plan, approvalFor(plan)), /already|used|replay/i);
    assert.equal(await treeSnapshot(fixture.root), committedTree);
    const noOp = await prepareMigration(fixture.root);
    assert.equal(readMigration(noOp).status, "already-v2");
    assert.deepEqual(await commitMigration(noOp, approvalFor(noOp)), {
      catalogVersion: 2,
      backupDir: null,
      preservedPaths: [],
    });
    assert.equal(await treeSnapshot(fixture.root), committedTree);
  } finally {
    await fixture.dispose();
  }
});

test("rolls back a catalog-switch failure while retaining the permanent verified backup", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourceBytes = Buffer.from("source preserved across rollback\n");
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", sourceBytes, 0o755);
    const oldCatalog = await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const sourceBefore = await lstat(sourcePath, { bigint: true });
    const plan = await prepareMigration(fixture.root);
    const originalRun = storageTransactions.run;
    Object.defineProperty(storageTransactions, "run", {
      configurable: true,
      value: <T>(root: string, create: boolean, operation: (session: import("../src/storage-transaction.ts").StorageSession | undefined) => Promise<T>) =>
        new StorageTransactions({ checkpoint: (point) => {
          if (point === "catalog-renamed") throw new Error("synthetic catalog switch fault");
        } }).run(root, create, operation),
    });
    try {
      await assert.rejects(commitMigration(plan, approvalFor(plan)), /synthetic catalog switch fault/i);
    } finally {
      Object.defineProperty(storageTransactions, "run", { configurable: true, value: originalRun });
      Reflect.deleteProperty(storageTransactions, "run");
    }

    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), oldCatalog);
    assert.equal((await lstat(sourcePath, { bigint: true })).ino, sourceBefore.ino);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    const rootNames = await readdir(fixture.root);
    assert.equal(rootNames.includes(".copi-transaction"), false);
    assert.ok(rootNames.includes(".migration-backups"), "verified backup custody is permanent after rollback");
    const backupNames = await readdir(path.join(fixture.root, ".migration-backups"));
    assert.equal(backupNames.length, 1);
    const backupDir = `.migration-backups/${backupNames[0]}`;
    const backupRoot = path.join(fixture.root, backupDir);
    const manifestBytes = await readFile(path.join(backupRoot, "manifest.json"));
    const manifest = parseMigrationBackupManifest(manifestBytes);
    assert.equal(manifest.entries.find(({ originalPath }) => originalPath === "catalog.json")?.sha256, digest(oldCatalog));
    await verifyMigrationBackup({
      libraryRoot: fixture.root,
      backupDir,
      manifestBytes,
      manifestSha256: digest(manifestBytes),
      entries: manifest.entries.map(({ originalPath, sha256, mode }) => ({ originalPath, sha256, mode })),
    });
  } finally {
    Reflect.deleteProperty(storageTransactions, "run");
  }
});

test("requires the exact per-file secret approval for adopted source bytes", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const secret = Buffer.from('const apiKey = "SYNTHETIC_ADOPTED_SOURCE_SECRET_748215";\n');
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", secret, 0o640);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    const view = readMigration(plan);
    assert.ok(view.sensitivePaths.includes(`${makeLegacyItem().id}/AGENTS.md`));
    assert.equal(JSON.stringify(view).includes("SYNTHETIC_ADOPTED_SOURCE_SECRET_748215"), false);
    const before = await treeSnapshot(fixture.root);
    const approval = approvalFor(plan);

    await assert.rejects(commitMigration(plan, { ...approval, approvedSensitivePaths: [] }), /sensitive|approval/i);
    assert.equal(await treeSnapshot(fixture.root), before);
    assert.equal((await readdir(fixture.root)).includes(".migration-backups"), false);

    const result = await commitMigration(plan, approval);
    assert.ok(result.backupDir);
    assert.deepEqual(await readFile(sourcePath), secret);
  } finally {
    await fixture.dispose();
  }
});

test("recovers an adopt-only catalog hold after SIGKILL and keeps the permanent backup", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourceBytes = Buffer.from("source bytes survive process death\n");
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", sourceBytes, 0o755);
    const oldCatalog = await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const sourceBefore = await lstat(sourcePath, { bigint: true });
    const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
    const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
    const child = `
      const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
      Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
        new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-held") process.kill(process.pid, "SIGKILL"); } })
          .run(root, create, operation) });
      const { prepareMigration, readMigration, commitMigration } = await import(${JSON.stringify(migrationUrl)});
      const plan = await prepareMigration(process.argv[1]);
      const view = readMigration(plan);
      await commitMigration(plan, { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    `;
    const killed = spawnSync(process.execPath, ["-e", child, fixture.root], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.equal(await lstat(path.join(fixture.root, "catalog.json")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");

    await new StorageTransactions({ waitMilliseconds: 100 }).run(fixture.root, false, async () => undefined);

    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), oldCatalog);
    const sourceAfter = await lstat(sourcePath, { bigint: true });
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.equal((await readdir(fixture.root)).includes(".copi-transaction"), false);
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
  } finally {
    await fixture.dispose();
  }
});

test("stops and preserves the journal when an unrelated root entry changes after catalog switch", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("unchanged source\n"), 0o755);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    Object.defineProperty(storageTransactions, "run", {
      configurable: true,
      value: <T>(root: string, create: boolean, operation: (session: import("../src/storage-transaction.ts").StorageSession | undefined) => Promise<T>) =>
        new StorageTransactions({ checkpoint: async (point) => {
          if (point === "catalog-renamed") {
            await writeBytes(root, "unreviewed-root-entry.bin", Buffer.from("preserve this unrelated entry\n"), 0o600);
            throw new Error("synthetic external root edit");
          }
        } }).run(root, create, operation),
    });
    try {
      await assert.rejects(commitMigration(plan, approvalFor(plan)), /recover|root entries|external root edit/i);
    } finally {
      Reflect.deleteProperty(storageTransactions, "run");
    }

    assert.deepEqual(await readFile(path.join(fixture.root, "unreviewed-root-entry.bin")), Buffer.from("preserve this unrelated entry\n"));
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
    const catalog = JSON.parse(await readFile(path.join(fixture.root, "catalog.json"), "utf8")) as { version: number };
    assert.equal(catalog.version, 2);
  } finally {
    Reflect.deleteProperty(storageTransactions, "run");
    await fixture.dispose();
  }
});

test("rejects source edits after preview before creating the backup", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("reviewed source\n"), 0o755);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("edited after review\n"), 0o755);
    const changed = await treeSnapshot(fixture.root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|conflict/i);

    assert.equal(await treeSnapshot(fixture.root), changed);
    assert.equal((await readdir(fixture.root)).includes(".migration-backups"), false);
  } finally {
    await fixture.dispose();
  }
});

test("keeps items-only migrations fail-closed and writes no backup or catalog", async () => {
  const fixture = await createLegacyLibrary();
  try {
    await writeLegacyCatalog(fixture.root);
    await writeLegacySnapshot(fixture.root);
    const before = await treeSnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    assert.equal(readMigration(plan).items[0]?.selection, "items");

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /fail.closed|not implemented|adopt|existing sources/i);

    assert.equal(await treeSnapshot(fixture.root), before);
  } finally {
    await fixture.dispose();
  }
});
