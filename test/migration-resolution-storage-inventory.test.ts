import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { projectMigrationInventory, scanMigrationInventory } from "../src/migration-inventory.ts";
import { commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { makeLegacyItem, createLegacyLibrary, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const controlNames = [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"] as const;
const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("fixture value is not canonical JSON");
  return encoded;
}

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

test("ordinary reader rejects post-record source edits even if the record approval inventory is rewritten", async () => {
  const box = await fixture();
  try {
    const record = await leaveInstalledResolutionRecord(box.root);
    const edited = Buffer.from("unreviewed editor change after durable resolution record\n");
    await writeFile(box.sourcePath, edited);

    const tempName = (await readdir(box.root)).find((name) => name.startsWith(".copi-migration-resolution.") && name.endsWith(".tmp"));
    assert.ok(tempName, "record-install crash must leave its known completed temp alias");
    const excluded = [...controlNames, tempName];
    const actual = await scanMigrationInventory(box.root, { excludedPrefixes: excluded });
    record.approvedInventory = projectMigrationInventory(actual, excluded);
    // Leave privateRevisionHash unchanged: the strict record codec must detect that this reviewed commitment was altered.
    await writeFile(path.join(box.root, ".copi-migration-resolution.json"), canonicalJson(record));

    let readerResult: Awaited<ReturnType<typeof loadCatalog>> | undefined;
    let readerError: unknown;
    try { readerResult = await loadCatalog(box.root); } catch (error) { readerError = error; }
    assert.ok(readerError, `ordinary reader must reject tampered record commitments; it returned catalogVersion=${readerResult?.version}, source=${(await readFile(box.sourcePath)).toString()}, recordExists=${(await readdir(box.root)).includes(".copi-migration-resolution.json")}`);
    assert.match(readerError instanceof Error ? readerError.message : String(readerError), /record|commitment|approval|review|changed/i);
    assert.deepEqual(await readFile(box.sourcePath), edited);
    assert.ok((await readdir(box.root)).includes(".copi-migration-resolution.json"));
    assert.ok((await readdir(path.join(box.root, ".copi-transaction"))).includes("journal.json"));
  } finally { await box.dispose(); }
});
