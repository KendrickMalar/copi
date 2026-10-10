import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import {
  commitMigration,
  commitMigrationResolution,
  prepareMigration,
  prepareMigrationResolution,
  readMigration,
  readMigrationResolution,
} from "../src/migration.ts";
import {
  listManagedMigrationRootEntries,
  scanMigrationInventory,
} from "../src/migration-inventory.ts";
import { setMigrationResolutionCheckpointForTests } from "../src/migration-resolution.ts";
import { treeSnapshot, createLegacyLibrary, makeLegacyItem, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";
import { StorageTransactions, storageTransactions, type StorageSession } from "../src/storage-transaction.ts";

const managedRootNames = new Set([
  "catalog.json", "items", "sources", ".migration-backups", ".copi-transaction",
  ".copi-transaction-recovery",
]);
const externalPath = ".pi/loops/session.log";
const checkpointNames = [
  "stage-write", "stage-sync", "journal", "before-catalog", "catalog-held", "catalog-renamed",
  "directory-sync", "committed",
] as const;
const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;

async function fixture() {
  const box = await createLegacyLibrary();
  const sourceBytes = Buffer.from("original managed source\n");
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", sourceBytes, 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath, sourceBytes };
}

function assertManagedPaths(nodes: readonly { path: string }[], label: string): void {
  const invalid = nodes.map(({ path: nodePath }) => nodePath).filter((nodePath) => {
    if (nodePath === ".") return false;
    const rootName = nodePath.split("/", 1)[0]!;
    return !managedRootNames.has(rootName) && !rootName.startsWith(".copi-migration-resolution");
  });
  assert.deepEqual(invalid, [], `${label} contains paths outside the approved managed root projection`);
}

function approval(plan: Awaited<ReturnType<typeof prepareMigration>>) {
  const view = readMigration(plan);
  assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
  return { reviewId: view.reviewId, confirmed: true as const, approvedSensitivePaths: [...view.sensitivePaths] };
}

function installMigrationCheckpoint(callback: (point: string, root: string) => Promise<void> | void): () => void {
  const originalRun = storageTransactions.run;
  Object.defineProperty(storageTransactions, "run", {
    configurable: true,
    value: <T>(root: string, create: boolean, operation: (session: StorageSession | undefined) => Promise<T>) =>
      new StorageTransactions({ checkpoint: callback }).run(root, create, operation, { requiresNativePlacement: false }),
  });
  return () => {
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: originalRun });
    Reflect.deleteProperty(storageTransactions, "run");
  };
}

async function crashAtCatalogSwitch(root: string): Promise<void> {
  const childScript = `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation, { requiresNativePlacement: false }) });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error("prepare blocked: " + JSON.stringify(view.conflicts));
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript, root], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
}

test("inventory/root listing ignore unrelated symlink trees and direct children while root identity and mode stay fixed", async () => {
  const box = await fixture();
  const outside = path.join(path.dirname(box.root), `copi-outside-${path.basename(box.root)}`);
  try {
    await mkdir(path.join(box.root, "docs"), { recursive: true });
    await writeFile(outside, "outside bytes\n");
    await symlink(outside, path.join(box.root, "docs", "unrelated-link"));
    await mkdir(path.join(box.root, ".pi/loops"), { recursive: true });
    await writeFile(path.join(box.root, ".pi/loops/session.log"), "initial activity\n");
    await mkdir(path.join(box.root, ".codemogger"), { recursive: true });
    await writeFile(path.join(box.root, ".codemogger/state.json"), "{}\n");
    await mkdir(path.join(box.root, "backup-from-another-tool"), { recursive: true });
    await writeFile(path.join(box.root, "README.md"), "unmanaged root document\n");
    const beforeRoot = await lstat(box.root, { bigint: true });
    const before = await scanMigrationInventory(box.root);
    const rootEntries = await listManagedMigrationRootEntries(box.root);
    assert.deepEqual(rootEntries, ["catalog.json", "items", "sources"]);
    assert.deepEqual(before.nodes.map((node) => node.path), [
      ".", "catalog.json", "items", `items/${"123e4567-e89b-42d3-a456-426614174000"}`,
      `items/${"123e4567-e89b-42d3-a456-426614174000"}/files`,
      `items/${"123e4567-e89b-42d3-a456-426614174000"}/files/AGENTS.md`,
      "sources", "sources/current", "sources/current/AGENTS.md",
    ]);

    const originalMtime = beforeRoot.mtimeNs;
    await mkdir(path.join(box.root, "notes-directory"));
    await writeFile(path.join(box.root, "notes.md"), "outside the Copi managed scope\n");
    const addedRoot = await lstat(box.root, { bigint: true });
    assert.notEqual(addedRoot.mtimeNs, originalMtime, "unmanaged root additions should change the raw directory timestamp");
    assert.deepEqual(await scanMigrationInventory(box.root), before);
    await rm(path.join(box.root, "notes-directory"), { recursive: true });
    await unlink(path.join(box.root, "notes.md"));
    assert.deepEqual(await scanMigrationInventory(box.root), before, "unmanaged root removals should not change projected inventory");

    const afterRoot = await lstat(box.root, { bigint: true });
    assert.equal(afterRoot.dev, beforeRoot.dev);
    assert.equal(afterRoot.ino, beforeRoot.ino);
    assert.equal(afterRoot.mode, beforeRoot.mode);
    assert.deepEqual(await readFile(outside), Buffer.from("outside bytes\n"));
  } finally {
    await unlink(outside).catch(() => undefined);
    await box.dispose();
  }
});

test("v5 journal and root-entry commitment contain only managed root names", async () => {
  const box = await fixture();
  let observed = false;
  const rootBefore = await lstat(box.root, { bigint: true });
  try {
    await mkdir(path.join(box.root, "docs"));
    await symlink("missing", path.join(box.root, "docs/unmanaged-link"));
    await mkdir(path.join(box.root, ".pi/loops"), { recursive: true });
    await writeFile(path.join(box.root, ".pi/loops/session.log"), "activity\n");
    const plan = await prepareMigration(box.root);
    const view = readMigration(plan);
    assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
    const restore = installMigrationCheckpoint(async (point, root) => {
      if (point !== "journal") return;
      const journal = JSON.parse(await readFile(path.join(root, ".copi-transaction/journal.json"), "utf8")) as {
        version: number; startInventory: { nodes: Array<{ path: string }> };
      };
      const owner = JSON.parse(await readFile(path.join(root, ".copi-transaction/owner.json"), "utf8")) as {
        migrationRootEntries: string[];
      };
      assert.equal(journal.version, 5);
      assertManagedPaths(journal.startInventory.nodes, "journal.startInventory");
      assert.deepEqual(owner.migrationRootEntries, ["catalog.json", "items", "sources"]);
      assert.ok(owner.migrationRootEntries.every((name) => managedRootNames.has(name)));
      observed = true;
    });
    try {
      await commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    } finally { restore(); }
    assert.equal(observed, true, "the real journal checkpoint must have been reached");
    assert.equal((await loadCatalog(box.root)).version, 2);
    const rootAfter = await lstat(box.root, { bigint: true });
    assert.equal(rootAfter.dev, rootBefore.dev);
    assert.equal(rootAfter.ino, rootBefore.ino);
    assert.equal(rootAfter.mode, rootBefore.mode);
    assert.deepEqual(await readFile(path.join(box.root, ".pi/loops/session.log")), Buffer.from("activity\n"));
    assert.deepEqual(await readFile(path.join(box.root, "docs/unmanaged-link"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "dangling";
      throw error;
    }), "dangling");
  } finally { await box.dispose(); }
});

test("real public migration tolerates unmanaged .pi writes at every commit/recovery cleanup checkpoint", async (t) => {
  for (const point of checkpointNames) await t.test(point, async () => {
    const box = await fixture();
    const payloadBefore = {
      items: await treeSnapshot(path.join(box.root, "items")),
      sources: await treeSnapshot(path.join(box.root, "sources")),
    };
    const rootBefore = await lstat(box.root, { bigint: true });
    const externalBytes = Buffer.from(`independent external write at ${point}\n`);
    let injected = false;
    let restore: (() => void) | undefined;
    try {
      await mkdir(path.join(box.root, ".pi/loops"), { recursive: true });
      await writeFile(path.join(box.root, externalPath), "pre-existing external activity\n");
      const plan = await prepareMigration(box.root);
      const view = readMigration(plan);
      assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
      restore = installMigrationCheckpoint(async (current, root) => {
        if (!injected && current === point) {
          injected = true;
          await writeBytes(root, externalPath, externalBytes, 0o600);
        }
      });
      const result = await commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      assert.equal(result.catalogVersion, 2);
      assert.equal(injected, true, `${point} checkpoint was not reached`);
      assert.deepEqual(await readFile(path.join(box.root, externalPath)), externalBytes);
      assert.deepEqual(await treeSnapshot(path.join(box.root, "items")), payloadBefore.items);
      assert.deepEqual(await treeSnapshot(path.join(box.root, "sources")), payloadBefore.sources);
      assert.ok((await readdir(path.join(box.root, ".migration-backups"))).length > 0);
      await assert.rejects(lstat(path.join(box.root, ".copi-transaction")), { code: "ENOENT" });
      const rootAfter = await lstat(box.root, { bigint: true });
      assert.equal(rootAfter.dev, rootBefore.dev);
      assert.equal(rootAfter.ino, rootBefore.ino);
      assert.equal(rootAfter.mode, rootBefore.mode);
    } finally {
      restore?.();
      await box.dispose();
    }
  });
});

test("SIGKILL after catalog switch recovers normally despite an unmanaged edit during the crash gap", async () => {
  const box = await fixture();
  try {
    await mkdir(path.join(box.root, ".pi/loops"), { recursive: true });
    await writeFile(path.join(box.root, externalPath), "before crash\n");
    await crashAtCatalogSwitch(box.root);
    const duringCrash = Buffer.from("independent edit during recovery gap\n");
    await writeBytes(box.root, externalPath, duringCrash, 0o600);
    await storageTransactions.run(box.root, false, async () => undefined, { requiresNativePlacement: false });
    assert.equal((await loadCatalog(box.root)).version, 2);
    assert.deepEqual(await readFile(path.join(box.root, externalPath)), duringCrash);
    await assert.rejects(lstat(path.join(box.root, ".copi-transaction")), { code: "ENOENT" });
    assert.ok((await readdir(path.join(box.root, ".migration-backups"))).length > 0);
  } finally { await box.dispose(); }
});

test("resolution start and cleanup checkpoints ignore unmanaged writes; record inventories remain scoped", async (t) => {
  for (const phase of ["before-prepare", "during-cleanup"] as const) await t.test(phase, async () => {
    const box = await fixture();
    let recordObserved = false;
    let cleanupWriteObserved = false;
    try {
      await mkdir(path.join(box.root, ".pi/loops"), { recursive: true });
      await writeFile(path.join(box.root, externalPath), "initial activity\n");
      await crashAtCatalogSwitch(box.root);
      await writeFile(box.sourcePath, Buffer.from("approved source edit after switch\n"));
      if (phase === "before-prepare") await writeFile(path.join(box.root, externalPath), "changed before resolver prepare\n");

      const plan = await prepareMigrationResolution(box.root);
      const view = readMigrationResolution(plan);
      assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
      setMigrationResolutionCheckpointForTests(async (point, root) => {
        if (point === "after-record-root-sync" && !recordObserved) {
          const record = JSON.parse(await readFile(path.join(root, ".copi-migration-resolution.json"), "utf8")) as {
            approvedInventory: { nodes: Array<{ path: string }> };
            originalJournal: { rawBase64: string };
            originalOwner: { rawBase64: string };
          };
          assertManagedPaths(record.approvedInventory.nodes, "resolution.approvedInventory");
          const journal = JSON.parse(Buffer.from(record.originalJournal.rawBase64, "base64").toString("utf8")) as {
            startInventory: { nodes: Array<{ path: string }> };
          };
          assertManagedPaths(journal.startInventory.nodes, "resolution.originalJournal.startInventory");
          const owner = JSON.parse(Buffer.from(record.originalOwner.rawBase64, "base64").toString("utf8")) as {
            migrationRootEntries: string[];
          };
          assert.ok(owner.migrationRootEntries.every((name) => managedRootNames.has(name)));
          assert.equal(owner.migrationRootEntries.includes(".pi"), false);
          recordObserved = true;
        }
        if (phase === "during-cleanup" && point === "after-action-unlink" && !cleanupWriteObserved) {
          cleanupWriteObserved = true;
          await writeFile(path.join(root, externalPath), "changed during resolution cleanup\n");
        }
      });
      await commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      assert.equal(recordObserved, true);
      if (phase === "during-cleanup") assert.equal(cleanupWriteObserved, true);
      const expected = phase === "during-cleanup" ? "changed during resolution cleanup\n" : "changed before resolver prepare\n";
      assert.deepEqual(await readFile(path.join(box.root, externalPath)), Buffer.from(expected));
      assert.equal((await loadCatalog(box.root)).version, 2);
      for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
        await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
      }
    } finally {
      setMigrationResolutionCheckpointForTests(undefined);
      await box.dispose();
    }
  });
});

test("managed symlinks and special nodes remain blocked while unmanaged symlinks are ignored", async () => {
  const box = await fixture();
  const socketPath = path.join(box.root, "items/special.sock");
  const server = createServer();
  try {
    await symlink("missing", path.join(box.root, "items/managed-link"));
    await assert.rejects(scanMigrationInventory(box.root), /symbolic link|symlink/i);
    await unlink(path.join(box.root, "items/managed-link"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(scanMigrationInventory(box.root), /special filesystem node/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
    await box.dispose();
  }
});

test("changed managed payload after preview is rejected without creating or repairing artifacts", async () => {
  const box = await fixture();
  try {
    const plan = await prepareMigration(box.root);
    const view = readMigration(plan);
    assert.equal(view.status, "ready");
    const changed = Buffer.from("externally changed managed source\n");
    await writeFile(box.sourcePath, changed);
    const before = await treeSnapshot(box.root);
    await assert.rejects(commitMigration(plan, {
      reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths],
    }), /changed|revision|preview|conflict/i);
    assert.equal(await treeSnapshot(box.root), before, "refusal must not rewrite payload or repair transaction state");
    assert.deepEqual(await readFile(box.sourcePath), changed);
    for (const internal of [".migration-backups", ".copi-transaction", ".copi-transaction-recovery"]) {
      await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
    }
  } finally { await box.dispose(); }
});

test("unowned backup siblings and unknown managed internal nodes block without altering custody", async (t) => {
  for (const kind of ["backup sibling", "unknown transaction child"] as const) await t.test(kind, async () => {
    const box = await fixture();
    try {
      await crashAtCatalogSwitch(box.root);
      await writeFile(box.sourcePath, Buffer.from("approved source edit\n"));
      let unownedPath: string;
      if (kind === "backup sibling") {
        unownedPath = path.join(box.root, ".migration-backups", "unowned-sibling", "hold.txt");
        await mkdir(path.dirname(unownedPath), { recursive: true });
      } else {
        unownedPath = path.join(box.root, ".copi-transaction", "unknown-internal.txt");
      }
      const bytes = Buffer.from(`must remain untouched: ${kind}\n`);
      await writeFile(unownedPath, bytes, { mode: 0o600 });
      const before = await treeSnapshot(box.root);
      const plan = await prepareMigrationResolution(box.root);
      const view = readMigrationResolution(plan);
      assert.equal(view.status, "blocked", `${kind}: ${view.conflicts.join("; ")}`);
      assert.ok(view.conflicts.length > 0);
      assert.equal(await treeSnapshot(box.root), before, `${kind}: blocked resolution review must be read-only`);
      assert.deepEqual(await readFile(unownedPath), bytes);
    } finally { await box.dispose(); }
  });
});

test("unmanaged special nodes nested below an ignored root directory are not inspected", async () => {
  const box = await fixture();
  const socketPath = path.join(box.root, "docs/unrelated.sock");
  const server = createServer();
  try {
    await mkdir(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const plan = await prepareMigration(box.root);
    assert.equal(readMigration(plan).status, "ready");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
    await box.dispose();
  }
});
