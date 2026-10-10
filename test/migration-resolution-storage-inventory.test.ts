import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { makeLegacyItem, createLegacyLibrary, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

async function fixture() {
  const box = await createLegacyLibrary();
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", Buffer.from("original included source\n"), 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

function crashMigrationAtCatalogSwitch(root: string): void {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const script = `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation, { requiresNativePlacement: false }) });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

function crashResolutionAfterRecordSync(root: string): void {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  const script = `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    resolution.setMigrationResolutionCheckpointForTests((point) => { if (point === "after-record-root-sync") process.kill(process.pid, "SIGKILL"); });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigrationResolution(process.argv[1]);
    const view = api.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

async function leaveInstalledResolutionRecord(root: string): Promise<Record<string, unknown>> {
  crashMigrationAtCatalogSwitch(root);
  crashResolutionAfterRecordSync(root);
  return JSON.parse(await readFile(path.join(root, ".copi-migration-resolution.json"), "utf8")) as Record<string, unknown>;
}

test("record backupInventory uses library-root-relative paths and scopes custody to this backup UUID", async () => {
  const box = await fixture();
  try {
    const record = await leaveInstalledResolutionRecord(box.root);
    const backupDir = record.backupDir as string;
    const backupInventory = record.backupInventory as { nodes: Array<{ path: string }> };
    const paths = backupInventory.nodes.map((node) => node.path);
    assert.ok(paths.some((nodePath) => nodePath === ".migration-backups"), `the backup parent path must be relative to the library root; actual paths=${JSON.stringify(paths)}`);
    assert.ok(paths.some((nodePath) => nodePath === backupDir), `the owned UUID subtree must be recorded at its library-root-relative path; actual paths=${JSON.stringify(paths)}`);
    assert.ok(!paths.some((nodePath) => nodePath === path.posix.basename(backupDir)), `backup paths must not be rebased to the backup parent directory; actual paths=${JSON.stringify(paths)}`);
  } finally { await box.dispose(); }
});

test("approvedInventory separates the protocol-owned backup UUID tree into backupInventory", async () => {
  const box = await fixture();
  try {
    const record = await leaveInstalledResolutionRecord(box.root);
    const backupDir = record.backupDir as string;
    const approvedInventory = record.approvedInventory as { nodes: Array<{ path: string }> };
    const backupPayloadNodes = approvedInventory.nodes.map((node) => node.path).filter((nodePath) => nodePath === backupDir || nodePath.startsWith(`${backupDir}/`));
    assert.deepEqual(backupPayloadNodes, [], "the generated backup tree has its own backupInventory custody proof, not an approved payload proof");
  } finally { await box.dispose(); }
});
