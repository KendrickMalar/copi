import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitMigration, prepareMigration, readMigration, type PreparedMigration } from "../src/migration.ts";
import type { ChangeApproval } from "../src/resource-mutations.ts";
import { buildMigrationBackupManifest, parseMigrationBackupManifest, verifyMigrationBackup } from "../src/migration-backup.ts";
import { scanMigrationInventory } from "../src/migration-inventory.ts";
import { canonicalStorageJournalJson } from "../src/storage-journal.ts";
import { prepareLegacyMigrationReview, storageTransactions, StorageTransactions, type LegacyMigrationReview, type StorageSession } from "../src/storage-transaction.ts";
import {
  createLegacyLibrary,
  legacyFileBytes,
  makeLegacyItem,
  treeSnapshot,
  writeBytes,
  writeLegacyCatalog,
  writeLegacySnapshot,
} from "./helpers/legacy-library.ts";
import type { LegacyCatalog } from "../src/types.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const issueMigrationReview = prepareLegacyMigrationReview as unknown as (...args: unknown[]) => Promise<LegacyMigrationReview>;

async function migrationTreeCommitment(root: string, relativeRoot: "items" | "sources"): Promise<string> {
  const target = path.join(root, relativeRoot);
  const entries: Array<{ path: string; kind: "directory" | "file"; value: string; mode: number; dev: number; ino: number }> = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stat = await lstat(absolute, { bigint: true });
    const identity = { dev: Number(stat.dev), ino: Number(stat.ino) };
    if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", value: "", mode: Number(stat.mode & 0o777n), ...identity });
      const prefix = relative === "." ? "" : `${relative}/`;
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), `${prefix}${name}`);
    } else if (stat.isFile()) {
      entries.push({ path: relative, kind: "file", value: digest(await readFile(absolute)), mode: Number(stat.mode & 0o777n), ...identity });
    } else {
      throw new Error(`Unexpected migration fixture node: ${absolute}`);
    }
  };
  await visit(target, ".");
  return digest(Buffer.from(JSON.stringify(entries)));
}

async function migrationInputFiles(root: string, relativeRoot: "items" | "sources"): Promise<string[]> {
  const result: string[] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const name of (await readdir(absolute)).sort()) {
      const childRelative = `${relative}/${name}`;
      const child = path.join(absolute, name);
      const stat = await lstat(child, { bigint: true });
      if (stat.isDirectory()) await visit(child, childRelative);
      else if (stat.isFile()) result.push(childRelative);
      else throw new Error(`Unexpected migration fixture node: ${child}`);
    }
  };
  const target = path.join(root, relativeRoot);
  await visit(target, relativeRoot);
  return result;
}

function catalogWithUnknownField(value: unknown, area: "top" | "item" | "file" | "group"): Record<string, unknown> {
  const catalog = structuredClone(value) as Record<string, unknown>;
  if (area === "top") {
    catalog.unrecognizedTopField = "synthetic-extra";
  } else if (area === "item") {
    const items = catalog.items as Array<Record<string, unknown>>;
    items[0]!.unrecognizedItemField = "synthetic-extra";
  } else if (area === "file") {
    const items = catalog.items as Array<Record<string, unknown>>;
    const files = items[0]!.files as Array<Record<string, unknown>>;
    files[0]!.unrecognizedFileField = "synthetic-extra";
  } else {
    const groups = catalog.groups as Array<Record<string, unknown>>;
    if (groups.length === 0) groups.push({ id: "223e4567-e89b-42d3-a456-426614174001", name: "Synthetic group", itemIds: ["123e4567-e89b-42d3-a456-426614174000"] });
    groups[0]!.unrecognizedGroupField = "synthetic-extra";
  }
  return catalog;
}

async function legacyReviewRequest(
  root: string,
  plan: PreparedMigration,
  oldCatalogBytes: Buffer,
  nextCatalog: { version: 2; items: Array<LegacyCatalog["items"][number] & { content: { kind: "file" | "tree"; path: string } }>; groups: LegacyCatalog["groups"] },
): Promise<Record<string, unknown>> {
  const paths = ["catalog.json", ...await migrationInputFiles(root, "items"), ...await migrationInputFiles(root, "sources")].sort();
  const inputs = await Promise.all(paths.map(async (inputPath) => {
    const target = path.join(root, ...inputPath.split("/"));
    const stat = await lstat(target, { bigint: true });
    const bytes = await readFile(target);
    return { path: inputPath, bytes, mode: Number(stat.mode & 0o777n), sha256: digest(bytes), dev: stat.dev.toString(), ino: stat.ino.toString() };
  }));
  const catalogStat = await lstat(path.join(root, "catalog.json"), { bigint: true });
  return {
    root,
    startInventory: await scanMigrationInventory(root),
    oldCatalogBytes: Buffer.from(oldCatalogBytes),
    oldCatalogIdentity: `${catalogStat.dev}:${catalogStat.ino}`,
    catalogBytes: Buffer.from(`${JSON.stringify(nextCatalog, null, 2)}\n`),
    itemsTree: await migrationTreeCommitment(root, "items"),
    sourcesTree: await migrationTreeCommitment(root, "sources"),
    rootEntries: (await readdir(root)).sort(),
    inputs,
    backupDir: `.migration-backups/${randomUUID()}`,
    backupManifestBytes: buildMigrationBackupManifest(inputs.map(({ path: originalPath, sha256, mode }) => ({ originalPath, sha256, mode }))),
    reviewId: plan.reviewId,
    sensitivePaths: [...readMigration(plan).sensitivePaths],
  };
}

function approvalFor(plan: PreparedMigration): ChangeApproval {
  const view = readMigration(plan);
  return { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] };
}

test("writes a canonical v5 journal containing the complete read-only migration-start inventory", async () => {
  const fixture = await createLegacyLibrary();
  let rawJournal: string | undefined;
  let journal: Record<string, unknown> | undefined;
  try {
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("fixed source\n"), 0o644);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    await mkdir(path.join(fixture.root, "items", "empty-inventory-directory"), { mode: 0o711 });
    await writeBytes(fixture.root, "root-unregistered-inventory.txt", Buffer.from("must stay committed\n"), 0o640);
    const plan = await prepareMigration(fixture.root);
    Object.defineProperty(storageTransactions, "run", {
      configurable: true,
      value: <T>(root: string, create: boolean, operation: (session: StorageSession | undefined) => Promise<T>) =>
        new StorageTransactions({ checkpoint: async (point) => {
          if (point === "journal") {
            rawJournal = await readFile(path.join(root, ".copi-transaction", "journal.json"), "utf8");
            journal = JSON.parse(rawJournal) as Record<string, unknown>;
          }
        } }).run(root, create, operation, { requiresNativePlacement: false }),
    });
    try {
      await commitMigration(plan, approvalFor(plan));
    } finally { Reflect.deleteProperty(storageTransactions, "run"); }
    assert.ok(rawJournal);
    assert.ok(journal);
    assert.equal(journal.version, 5);
    assert.equal(rawJournal, canonicalStorageJournalJson(journal));
    const inventory = journal.startInventory as { hash: string; nodes: Array<{ path: string; kind: string }> };
    const paths = inventory.nodes.map((node) => node.path);
    assert.ok(paths.includes("."));
    assert.ok(paths.includes("catalog.json"));
    assert.ok(paths.includes("items/empty-inventory-directory"));
    assert.ok(paths.includes("root-unregistered-inventory.txt"));
    assert.ok(inventory.hash.length === 64);
  } finally {
    Reflect.deleteProperty(storageTransactions, "run");
    await fixture.dispose();
  }
});

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

test("does not authorize a raw review that redirects an items-only plan to unrelated sources", async () => {
  const fixture = await createLegacyLibrary();
  try {
    await writeLegacyCatalog(fixture.root);
    await writeLegacySnapshot(fixture.root);
    const unrelatedBytes = Buffer.from("unreviewed unrelated source bytes\n");
    await writeBytes(fixture.root, "sources/unrelated/AGENTS.md", unrelatedBytes, 0o755);
    const oldCatalog = await readFile(path.join(fixture.root, "catalog.json"));
    const plan = await prepareMigration(fixture.root);
    assert.equal(readMigration(plan).items[0]?.selection, "items");
    const legacy = JSON.parse(oldCatalog.toString("utf8")) as LegacyCatalog;
    const forgedNext = {
      version: 2 as const,
      items: legacy.items.map((item) => ({ ...item, content: { kind: "file" as const, path: "sources/unrelated/AGENTS.md" } })),
      groups: legacy.groups,
    };
    const rawRequest = await legacyReviewRequest(fixture.root, plan, oldCatalog, forgedNext);

    await assert.rejects(issueMigrationReview(rawRequest), /opaque|prepared|plan|review/i);
    await assert.rejects(issueMigrationReview(plan, rawRequest), /fixed prepared plan|selected sources plan|selecting existing sources/i);
    const copiedReview = Object.freeze({ reviewId: plan.reviewId }) as LegacyMigrationReview;
    await assert.rejects(storageTransactions.run(fixture.root, false, async (session) => {
      assert.ok(session);
      await session.commitLegacyMigration(copiedReview, {
        reviewId: plan.reviewId,
        confirmed: true,
        approvedSensitivePaths: [],
      });
    }, { requiresNativePlacement: false }), /issued|invalid|review/i);
    let expiredSession: StorageSession | undefined;
    await storageTransactions.run(fixture.root, false, async (session) => { expiredSession = session; }, { requiresNativePlacement: false });
    assert.ok(expiredSession);
    await assert.rejects(expiredSession.commitLegacyMigration(copiedReview, {
      reviewId: plan.reviewId,
      confirmed: true,
      approvedSensitivePaths: [],
    }), /expired|invalid|lease/i);

    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), oldCatalog);
    assert.deepEqual(await readFile(path.join(fixture.root, "sources/unrelated/AGENTS.md")), unrelatedBytes);
    assert.equal((await readdir(fixture.root)).includes(".copi-transaction"), false);
    assert.equal((await readdir(fixture.root)).includes(".migration-backups"), false);
  } finally {
    await fixture.dispose();
  }
});

test("binds a source-adopted target to the exact opaque preview selection", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const selectedBytes = Buffer.from("preview-selected source bytes\n");
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", selectedBytes, 0o640);
    const unrelatedBytes = Buffer.from("unreviewed unrelated source bytes\n");
    await writeBytes(fixture.root, "sources/unrelated/AGENTS.md", unrelatedBytes, 0o755);
    const oldCatalog = await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    const view = readMigration(plan);
    assert.equal(view.status, "ready");
    assert.equal(view.items[0]?.selection, "sources");
    assert.equal(view.items[0]?.target, "sources/current/AGENTS.md");
    const legacy = JSON.parse(oldCatalog.toString("utf8")) as LegacyCatalog;
    const forgedNext = {
      version: 2 as const,
      items: legacy.items.map((item) => ({ ...item, content: { kind: "file" as const, path: "sources/unrelated/AGENTS.md" } })),
      groups: legacy.groups,
    };
    const rawRequest = await legacyReviewRequest(fixture.root, plan, oldCatalog, forgedNext);
    const before = await treeSnapshot(fixture.root);

    await assert.rejects(issueMigrationReview(plan, rawRequest), /fixed prepared plan|selected sources plan/i);
    assert.equal(await treeSnapshot(fixture.root), before);
    assert.deepEqual(await readFile(sourcePath), selectedBytes);
    assert.deepEqual(await readFile(path.join(fixture.root, "sources/unrelated/AGENTS.md")), unrelatedBytes);
  } finally {
    await fixture.dispose();
  }
});

test("rejects unknown fields in raw legacy and next catalogs before issuing a migration review", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourceBytes = Buffer.from("selected existing source\n");
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", sourceBytes, 0o640);
    const oldCatalog = await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    assert.equal(readMigration(plan).items[0]?.selection, "sources");
    const baseLegacy = JSON.parse(oldCatalog.toString("utf8")) as LegacyCatalog;
    const target = readMigration(plan).items[0]!.target;

    for (const area of ["top", "item", "file", "group"] as const) {
      const rawNext = {
        version: 2 as const,
        items: baseLegacy.items.map((item) => ({ ...item, content: { kind: "file" as const, path: target } })),
        groups: area === "group"
          ? [{ id: "223e4567-e89b-42d3-a456-426614174001", name: "Synthetic group", itemIds: [baseLegacy.items[0]!.id] }]
          : baseLegacy.groups,
      };
      const request = await legacyReviewRequest(fixture.root, plan, oldCatalog, rawNext);
      const rawCatalog = catalogWithUnknownField(rawNext, area);
      request.catalogBytes = Buffer.from(`${JSON.stringify(rawCatalog, null, 2)}\n`);
      await assert.rejects(issueMigrationReview(plan, request), /unknown|unsupported|canonical|stored fields/i, `next ${area} field must be rejected`);
    }

    for (const area of ["top", "item", "file", "group"] as const) {
      const rawCatalog = catalogWithUnknownField(baseLegacy, area);
      const oldBytes = Buffer.from(`${JSON.stringify(rawCatalog, null, 2)}\n`);
      await writeFile(path.join(fixture.root, "catalog.json"), oldBytes);
      const cleanLegacy = structuredClone(baseLegacy);
      if (area === "group") cleanLegacy.groups.push({
        id: "223e4567-e89b-42d3-a456-426614174001",
        name: "Synthetic group",
        itemIds: [baseLegacy.items[0]!.id],
      });
      const rawNext = {
        version: 2 as const,
        items: cleanLegacy.items.map((item) => ({ ...item, content: { kind: "file" as const, path: target } })),
        groups: cleanLegacy.groups,
      };
      const request = await legacyReviewRequest(fixture.root, plan, oldBytes, rawNext);
      await assert.rejects(issueMigrationReview(plan, request), /unknown|unsupported|canonical|stored fields/i, `old ${area} field must be rejected`);
    }
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
        } }).run(root, create, operation, { requiresNativePlacement: false }),
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
          .run(root, create, operation, { requiresNativePlacement: false }) });
      const { prepareMigration, readMigration, commitMigration } = await import(${JSON.stringify(migrationUrl)});
      const plan = await prepareMigration(process.argv[1]);
      const view = readMigration(plan);
      await commitMigration(plan, { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    `;
    const killed = spawnSync(process.execPath, ["-e", child, fixture.root], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.equal(await lstat(path.join(fixture.root, "catalog.json")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");

    const stagePath = path.join(fixture.root, ".copi-transaction", "next-catalog");
    const alteredNext = JSON.parse(await readFile(stagePath, "utf8")) as Record<string, unknown>;
    alteredNext.unrecognizedTopField = "synthetic-rehashed-stage-field";
    const alteredNextBytes = Buffer.from(`${JSON.stringify(alteredNext, null, 2)}\n`);
    await writeFile(stagePath, alteredNextBytes);
    const journalPath = path.join(fixture.root, ".copi-transaction", "journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.newCatalog = digest(alteredNextBytes);
    const journalBytes = Buffer.from(JSON.stringify(journal));
    await writeFile(journalPath, journalBytes);
    await writeFile(path.join(fixture.root, ".copi-transaction", "journal.digest"), Buffer.from(digest(journalBytes)));

    await assert.rejects(new StorageTransactions({ waitMilliseconds: 100 }).run(fixture.root, false, async () => undefined, { requiresNativePlacement: false }), /unknown|canonical|stored fields/i);
    assert.equal(await lstat(path.join(fixture.root, "catalog.json")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
    assert.deepEqual(await readFile(stagePath), alteredNextBytes);
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));

    const sourceAfter = await lstat(sourcePath, { bigint: true });
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.equal((await readdir(fixture.root)).includes(".copi-transaction"), true);
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
        } }).run(root, create, operation, { requiresNativePlacement: false }),
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

test("preserves and blocks a new backup sibling outside the journal-owned UUID", async () => {
  const fixture = await createLegacyLibrary();
  const siblingPath = ".migration-backups/123e4567-e89b-42d3-a456-426614174001/unowned.bin";
  const siblingBytes = Buffer.from("unknown backup sibling must be preserved\n");
  try {
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("reviewed source\n"), 0o755);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    const plan = await prepareMigration(fixture.root);
    Object.defineProperty(storageTransactions, "run", {
      configurable: true,
      value: <T>(root: string, create: boolean, operation: (session: StorageSession | undefined) => Promise<T>) =>
        new StorageTransactions({ checkpoint: async (point) => {
          if (point === "catalog-renamed") await writeBytes(root, siblingPath, siblingBytes, 0o600);
        } }).run(root, create, operation, { requiresNativePlacement: false }),
    });
    try {
      await assert.rejects(commitMigration(plan, approvalFor(plan)), /outside|changed|preserv|recovery/i);
    } finally { Reflect.deleteProperty(storageTransactions, "run"); }

    assert.deepEqual(await readFile(path.join(fixture.root, siblingPath)), siblingBytes);
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
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
