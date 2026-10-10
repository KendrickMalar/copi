import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { commitMigration, prepareMigration, readMigration, commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { makeLegacyItem, createLegacyLibrary, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const fixtureItemId = "123e4567-e89b-42d3-a456-426614174000";
const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;

type EditKind = "A-same-inode" | "A-editor-replacement" | "B-skill-addition" | "C-skill-deletion";
type Checkpoint = "stage-write" | "stage-sync" | "journal" | "before-catalog" | "catalog-held" | "catalog-renamed" | "directory-sync" | "committed";
const migrationCheckpoints: readonly Checkpoint[] = [
  "stage-write", "stage-sync", "journal", "before-catalog", "catalog-held", "catalog-renamed", "directory-sync", "committed",
];
const rollbackCheckpoints = ["rollback-started", "rollback-catalog-held", "rollback-restored", "rollback-finalized"] as const;

interface Fixture {
  root: string;
  dispose: () => Promise<void>;
  sourcePath: string;
  skillRoot?: string;
  removablePath?: string;
}

async function fixture(kind: EditKind = "A-same-inode"): Promise<Fixture> {
  const box = await createLegacyLibrary();
  if (kind === "B-skill-addition" || kind === "C-skill-deletion") {
    const skillRoot = path.join(box.root, "sources/skill");
    const skillBytes = Buffer.from("# S8 adopted skill\noriginal body\n");
    const removableBytes = Buffer.from("baseline included helper\n");
    const sourcePath = await writeBytes(box.root, "sources/skill/SKILL.md", skillBytes, 0o640);
    const removablePath = await writeBytes(box.root, "sources/skill/remove-me.md", removableBytes, 0o600);
    const item = makeLegacyItem({
      kind: "skill",
      sourcePath: skillRoot,
      files: [
        { path: "SKILL.md", mode: 0o640, sha256: sha256(skillBytes) },
        { path: "remove-me.md", mode: 0o600, sha256: sha256(removableBytes) },
      ],
    });
    await writeLegacyCatalog(box.root, [item]);
    await writeLegacySnapshot(box.root, skillBytes, `items/${fixtureItemId}/files/SKILL.md`, 0o640);
    await writeLegacySnapshot(box.root, removableBytes, `items/${fixtureItemId}/files/remove-me.md`, 0o600);
    return { ...box, sourcePath, skillRoot, removablePath };
  }
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", Buffer.from("original adopted source\n"), 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

async function nodeState(target: string): Promise<Record<string, unknown>> {
  try {
    const stat = await lstat(target, { bigint: true });
    const base = { exists: true, dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o7777n), size: Number(stat.size) };
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const bytes = await readFile(target);
      return { ...base, kind: "file", bytesHash: sha256(bytes), bytes: bytes.length };
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const snapshot = await treeSnapshot(target);
      return { ...base, kind: "directory", treeHash: sha256(snapshot), rows: snapshot ? snapshot.split("\n").length : 0 };
    }
    return { ...base, kind: stat.isSymbolicLink() ? "symlink" : "special" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function inventory(target: string, relative = "."): Promise<Array<Record<string, unknown>>> {
  const stat = await lstat(target, { bigint: true });
  const base: Record<string, unknown> = {
    path: relative,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode & 0o7777n),
    size: Number(stat.size),
  };
  if (stat.isFile() && !stat.isSymbolicLink()) {
    base.kind = "file";
    base.bytesHash = sha256(await readFile(target));
    return [base];
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ ...base, kind: stat.isSymbolicLink() ? "symlink" : "special" }];
  base.kind = "directory";
  const result = [base];
  for (const name of (await readdir(target)).sort()) result.push(...await inventory(path.join(target, name), relative === "." ? name : `${relative}/${name}`));
  return result;
}

async function artifactInventory(root: string): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(root)).filter((name) =>
    name === ".copi-transaction" || name === ".copi-transaction-recovery" || name === ".copi-migration-resolution.json" ||
    name.startsWith(".copi-migration-resolution.") || name === ".migration-backups").sort();
  const result: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const rows = await inventory(path.join(root, name));
    result.push({ name, treeHash: sha256(JSON.stringify(rows)), rows });
  }
  return result;
}

async function applyEdit(box: Fixture, kind: EditKind): Promise<{ target: string; before: Record<string, unknown>; after: Record<string, unknown> }> {
  if (kind === "B-skill-addition") {
    const target = path.join(box.skillRoot!, "new-helper.md");
    const bytes = Buffer.from("ordinary included skill addition\n");
    await writeBytes(box.root, "sources/skill/new-helper.md", bytes, 0o751);
    return { target, before: { exists: false }, after: await nodeState(target) };
  }
  if (kind === "C-skill-deletion") {
    const target = box.removablePath!;
    const before = await nodeState(target);
    await unlink(target);
    return { target, before, after: await nodeState(target) };
  }
  const target = box.sourcePath;
  const before = await nodeState(target);
  const current = await lstat(target, { bigint: true });
  const bytes = Buffer.from(`ordinary ${kind} edit after migration checkpoint\n`);
  if (kind === "A-same-inode") {
    await writeFile(target, bytes);
    const after = await nodeState(target);
    assert.equal(after.ino, before.ino, "same-inode body edit must retain its source inode");
    return { target, before, after };
  }
  const temporary = path.join(path.dirname(target), `.editor-replacement-${randomUUID()}`);
  await writeFile(temporary, bytes, { mode: Number(current.mode & 0o777n) });
  await chmod(temporary, Number(current.mode & 0o777n));
  await rename(temporary, target);
  const after = await nodeState(target);
  assert.notEqual(after.ino, before.ino, "editor-style rename must install a different inode");
  return { target, before, after };
}

function childScriptForCheckpoint(point: string): string {
  return `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    const { writeSync } = await import("node:fs");
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (at) => {
        if (at === ${JSON.stringify(point)}) { writeSync(1, "S8_REACHED:${point}\\n"); process.kill(process.pid, "SIGKILL"); }
      } }).run(root, create, operation, { requiresNativePlacement: false }) });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error("prepare blocked: " + JSON.stringify(view.conflicts));
    writeSync(1, "S8_PREPARED:" + view.status + "\\n");
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
}

function crashAt(root: string, point: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "-e", childScriptForCheckpoint(point), root], { encoding: "utf8", timeout: 30_000 });
}

function scriptForInjectedOperation(operation: "backup-open-kill" | "backup-open-fail" | "stage-built-kill" | "journal-install-before" | "journal-install-after"): string {
  const common = `
    const { writeSync } = await import("node:fs");
    const { default: fs } = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error("prepare blocked: " + JSON.stringify(view.conflicts));
    writeSync(1, "S8_PREPARED:" + view.status + "\\n");
  `;
  if (operation === "backup-open-kill" || operation === "backup-open-fail") return `
    ${common}
    const originalOpen = fs.open.bind(fs);
    fs.open = async (target, ...args) => {
      const handle = await originalOpen(target, ...args);
      if (String(target).includes("/.migration-backups/") && String(target).includes("/files/")) {
        writeSync(1, "S8_REACHED:backup-generation-open\\n");
        if (${JSON.stringify(operation)} === "backup-open-kill") process.kill(process.pid, "SIGKILL");
        await handle.close();
        const fault = Object.assign(new Error("synthetic backup I/O failure"), { code: "EIO" });
        throw fault;
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      writeSync(1, "S8_UNEXPECTED:commit-returned\\n");
      process.exitCode = 70;
    } catch (error) {
      writeSync(1, "S8_BACKUP_FAILURE:" + String(error) + "\\n");
      process.exitCode = 41;
    }
  `;
  const linkKill = operation === "stage-built-kill" ? "old-catalog" : "journal.json";
  const phase = operation === "stage-built-kill" ? "stage-built-before-old-catalog-link" : `journal-install-${operation === "journal-install-before" ? "before" : "after"}`;
  return `
    ${common}
    const originalLink = fs.link.bind(fs);
    fs.link = async (source, target) => {
      if (String(target).endsWith("/.copi-transaction/${linkKill}")) {
        writeSync(1, "S8_REACHED:${phase}\\n");
        ${operation === "journal-install-after" ? "await originalLink(source, target);" : ""}
        process.kill(process.pid, "SIGKILL");
      }
      return originalLink(source, target);
    };
    syncBuiltinESMExports();
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
}

function runInjected(root: string, operation: Parameters<typeof scriptForInjectedOperation>[0]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "-e", scriptForInjectedOperation(operation), root], { encoding: "utf8", timeout: 30_000 });
}

function childScriptForRollbackCheckpoint(point: string): string {
  return `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    const { writeSync } = await import("node:fs");
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (at) => {
        if (at === "catalog-renamed") throw new Error("S8 injected post-switch rollback");
        if (at === ${JSON.stringify(point)}) { writeSync(1, "S8_REACHED:${point}\\n"); process.kill(process.pid, "SIGKILL"); }
      } }).run(root, create, operation, { requiresNativePlacement: false }) });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error("prepare blocked: " + JSON.stringify(view.conflicts));
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
}

async function capture(root: string, payloadTarget: string) {
  const backupPath = path.join(root, ".migration-backups");
  return {
    payload: await nodeState(payloadTarget),
    catalog: await nodeState(path.join(root, "catalog.json")),
    backup: await nodeState(backupPath),
    backupRows: await lstat(backupPath).then(() => inventory(backupPath)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)),
    artifacts: await artifactInventory(root),
  };
}

// Set COPI_TEST_TRACE=1 to print each matrix cell for diagnosis.
function logCell(value: Record<string, unknown>): void {
  if (process.env.COPI_TEST_TRACE) console.log(`S8-CELL ${JSON.stringify(value)}`);
}

function approval(view: ReturnType<typeof readMigrationResolution>) {
  return { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] };
}

async function recordNextPrepare(root: string) {
  const plan = await prepareMigration(root);
  const view = readMigration(plan);
  return { status: view.status, conflicts: [...view.conflicts], preservedPaths: [...view.preservedPaths] };
}

test("S8: prepare is read-only and a post-prepare same-inode/editor change invalidates only the old review", async (t) => {
  for (const kind of ["A-same-inode", "A-editor-replacement"] as const) await t.test(kind, async () => {
    const box = await fixture(kind);
    try {
      const before = await capture(box.root, box.sourcePath);
      const plan = await prepareMigration(box.root);
      const view = readMigration(plan);
      assert.equal(view.status, "ready");
      assert.deepEqual(await capture(box.root, box.sourcePath), before, "public prepare/read must write nothing");
      const edit = await applyEdit(box, kind);
      const afterEdit = await capture(box.root, box.sourcePath);
      await assert.rejects(commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /changed|revision|preview|conflict/i);
      assert.deepEqual(await capture(box.root, box.sourcePath), afterEdit, "stale commit must not create backup, journal or overwrite the edit");
      const fresh = await prepareMigration(box.root);
      assert.equal(readMigration(fresh).status, "ready");
      logCell({ case: "prepare-then-edit", edit: kind, reachedCheckpoint: "public prepare/read only", exit: { rejected: true, message: "expected stale-plan rejection" }, originalPayload: edit.before, editedPayload: edit.after, catalog: afterEdit.catalog, backup: afterEdit.backupRows, artifactInventory: afterEdit.artifacts, nextPrepare: "fresh preview ready; no implicit commit" });
    } finally { await box.dispose(); }
  });
});

test("S8: all public migration checkpoints recover or safely retain A/B/C ordinary edits", async (t) => {
  const editKinds: readonly EditKind[] = ["A-same-inode", "A-editor-replacement", "B-skill-addition", "C-skill-deletion"];
  for (const point of migrationCheckpoints) for (const kind of editKinds) await t.test(`${point}/${kind}`, async () => {
    const box = await fixture(kind);
    const editTarget = kind === "B-skill-addition" ? path.join(box.skillRoot!, "new-helper.md") : kind === "C-skill-deletion" ? box.removablePath! : box.sourcePath;
    try {
      const killed = crashAt(box.root, point);
      assert.equal(killed.signal, "SIGKILL", `${point}: ${killed.stdout}\n${killed.stderr}`);
      assert.match(String(killed.stdout), new RegExp(`S8_REACHED:${point}`));
      assert.match(String(killed.stdout), /S8_PREPARED:ready/);
      const edit = await applyEdit(box, kind);
      const atCrash = await capture(box.root, editTarget);
      let recovery: { outcome: "returned"; version: number } | { outcome: "safe-stop"; message: string };
      try {
        const loaded = await loadCatalog(box.root);
        recovery = { outcome: "returned", version: loaded.version };
      } catch (error) {
        recovery = { outcome: "safe-stop", message: error instanceof Error ? error.message : String(error) };
      }
      const afterRecovery = await capture(box.root, editTarget);
      assert.deepEqual(afterRecovery.payload, atCrash.payload, `${point}/${kind}: recovery must preserve the ordinary edit`);
      assert.deepEqual(afterRecovery.backupRows, atCrash.backupRows, `${point}/${kind}: recovery must preserve exact backup custody`);
      let resolution: Record<string, unknown> = { status: "not-applicable" };
      let final = afterRecovery;
      let nextPrepare: Record<string, unknown>;
      if (point === "catalog-renamed" || point === "directory-sync" || point === "committed") {
        assert.equal(recovery.outcome, "safe-stop", `${point}/${kind}: ordinary recovery must not silently adopt a post-switch edit`);
        const plan = await prepareMigrationResolution(box.root);
        const view = readMigrationResolution(plan);
        assert.equal(view.status, "ready", `${point}/${kind}: ${view.conflicts.join("; ")}`);
        const result = await commitMigrationResolution(plan, approval(view));
        final = await capture(box.root, editTarget);
        assert.deepEqual(final.payload, edit.after, `${point}/${kind}: confirmed resolution must preserve exact edited inode/bytes/mode`);
        assert.deepEqual(final.catalog, afterRecovery.catalog, `${point}/${kind}: resolution must not rewrite or replace current catalog`);
        assert.deepEqual(final.backupRows, atCrash.backupRows, `${point}/${kind}: resolution must not rewrite/delete verified backup`);
        assert.equal(final.artifacts.some((entry) => [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"].includes(entry.name as string)), false);
        resolution = { status: view.status, result };
        nextPrepare = await recordNextPrepare(box.root);
        assert.equal(nextPrepare.status, "already-v2");
      } else {
        nextPrepare = await recordNextPrepare(box.root);
        assert.equal(nextPrepare.status, "blocked", `${point}/${kind}: retained backup namespace or transaction must block retry`);
        assert.deepEqual((await capture(box.root, editTarget)).payload, edit.after, `${point}/${kind}: prepare must preserve edited bytes and inode`);
        const beforeResolve = await capture(box.root, editTarget);
        const resolverPlan = await prepareMigrationResolution(box.root);
        const resolverView = readMigrationResolution(resolverPlan);
        assert.notEqual(resolverView.status, "ready", `${point}/${kind}: pre-switch migration state is outside resolution eligibility`);
        const afterResolve = await capture(box.root, editTarget);
        assert.deepEqual(afterResolve, beforeResolve, "blocked/not-needed resolve prepare must remain readonly");
        resolution = { status: resolverView.status, conflicts: [...resolverView.conflicts] };
        final = afterResolve;
      }
      logCell({
        case: "migration-checkpoint-edit", checkpoint: point, reachedCheckpoint: point,
        childExit: { code: killed.status, signal: killed.signal }, edit: kind,
        originalPayload: edit.before, editedPayload: edit.after, payloadAfterNormalRecovery: afterRecovery.payload, payloadFinal: final.payload,
        catalogBeforeRecovery: atCrash.catalog, catalogAfterRecovery: afterRecovery.catalog, catalogFinal: final.catalog,
        backupInventory: { beforeRecovery: atCrash.backupRows, afterRecovery: afterRecovery.backupRows, final: final.backupRows },
        artifactInventory: { atCrash: atCrash.artifacts, afterRecovery: afterRecovery.artifacts, final: final.artifacts },
        normalRecovery: recovery, resolution, nextPrepare,
      });
    } finally { await box.dispose(); }
  });
});

test("S8: no-edit SIGKILL at every migration checkpoint uses normal recovery; retained backup blocks retry", async (t) => {
  for (const point of migrationCheckpoints) await t.test(point, async () => {
    const box = await fixture();
    try {
      const killed = crashAt(box.root, point);
      assert.equal(killed.signal, "SIGKILL", `${point}: ${killed.stdout}\n${killed.stderr}`);
      assert.match(String(killed.stdout), new RegExp(`S8_REACHED:${point}`));
      const beforeRecovery = await capture(box.root, box.sourcePath);
      const loaded = await loadCatalog(box.root);
      assert.ok(loaded.version === 1 || loaded.version === 2);
      const afterRecovery = await capture(box.root, box.sourcePath);
      assert.deepEqual(afterRecovery.payload, beforeRecovery.payload);
      assert.deepEqual(afterRecovery.backupRows, beforeRecovery.backupRows, "normal recovery must never remove the permanent backup");
      const next = await recordNextPrepare(box.root);
      assert.equal(next.status, loaded.version === 1 ? "blocked" : "already-v2");
      logCell({ case: "migration-checkpoint-no-edit", checkpoint: point, reachedCheckpoint: point, childExit: { code: killed.status, signal: killed.signal }, originalPayload: beforeRecovery.payload, catalogBeforeRecovery: beforeRecovery.catalog, catalogAfterRecovery: afterRecovery.catalog, backupInventory: { before: beforeRecovery.backupRows, after: afterRecovery.backupRows }, artifactInventory: { before: beforeRecovery.artifacts, after: afterRecovery.artifacts }, normalRecovery: { outcome: "returned", version: loaded.version }, nextPrepare: next });
    } finally { await box.dispose(); }
  });
});

test("S8: kill during backup creation and retain partial custody; do not hand-clean or auto-retry", async (t) => {
  for (const operation of ["backup-open-kill", "backup-open-fail"] as const) await t.test(operation, async () => {
    const box = await fixture();
    try {
      const child = runInjected(box.root, operation);
      if (operation === "backup-open-kill") {
        assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
        assert.match(String(child.stdout), /S8_REACHED:backup-generation-open/);
      } else {
        assert.equal(child.status, 41, `${child.stdout}\n${child.stderr}`);
        assert.match(String(child.stdout), /S8_BACKUP_FAILURE/);
        assert.match(String(child.stdout), /synthetic backup I\/O failure|EIO/);
      }
      const beforeRecovery = await capture(box.root, box.sourcePath);
      assert.equal(beforeRecovery.catalog.exists, true);
      assert.equal(beforeRecovery.catalog.bytesHash, sha256(await readFile(path.join(box.root, "catalog.json"))));
      assert.ok(beforeRecovery.backupRows.length > 0, "partial backup namespace must be recorded and retained");
      const recovered = await loadCatalog(box.root);
      assert.equal(recovered.version, 1);
      const afterRecovery = await capture(box.root, box.sourcePath);
      assert.deepEqual(afterRecovery.payload, beforeRecovery.payload);
      assert.deepEqual(afterRecovery.backupRows, beforeRecovery.backupRows, "normal recovery preserves partial backup nodes byte-for-byte and inode-for-inode");
      const next = await recordNextPrepare(box.root);
      assert.equal(next.status, "blocked");
      assert.ok(next.conflicts.some((entry) => /backup|preserv|exist/i.test(entry)), next.conflicts.join("; "));
      logCell({ case: operation, checkpoint: "backup-generation-open", reachedCheckpoint: "backup files open before first payload write", childExit: { code: child.status, signal: child.signal }, originalPayload: beforeRecovery.payload, catalog: { beforeRecovery: beforeRecovery.catalog, afterRecovery: afterRecovery.catalog }, partialBackupInventory: { beforeRecovery: beforeRecovery.backupRows, afterRecovery: afterRecovery.backupRows }, artifactInventory: { beforeRecovery: beforeRecovery.artifacts, afterRecovery: afterRecovery.artifacts }, normalRecovery: { outcome: "returned", version: recovered.version }, nextPrepare: next, userAction: "keep the partial backup and stop; do not delete backup or journal artifacts; use reviewed operator recovery" });
    } finally { await box.dispose(); }
  });
});

test("S8: explicit stage and journal installation boundaries preserve incomplete artifacts", async (t) => {
  const cases = [
    ["stage-built-kill", "stage-built-before-old-catalog-link"],
    ["journal-install-before", "journal-install-before"],
    ["journal-install-after", "journal-install-after"],
  ] as const;
  for (const [operation, checkpoint] of cases) await t.test(operation, async () => {
    const box = await fixture();
    try {
      const child = runInjected(box.root, operation);
      assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
      assert.match(String(child.stdout), new RegExp(`S8_REACHED:${checkpoint}`));
      const before = await capture(box.root, box.sourcePath);
      await assert.rejects(loadCatalog(box.root), /journal|integrity|unknown|stage|recovery/i);
      const after = await capture(box.root, box.sourcePath);
      assert.deepEqual(after.payload, before.payload);
      assert.deepEqual(after.catalog, before.catalog, "catalog must remain the original v1 inode and bytes");
      assert.deepEqual(after.backupRows, before.backupRows);
      assert.deepEqual(after.artifacts, before.artifacts, "unknown/partial transaction artifact inventory must not be repaired or deleted");
      const next = await recordNextPrepare(box.root);
      assert.equal(next.status, "blocked");
      logCell({ case: operation, checkpoint, reachedCheckpoint: checkpoint, childExit: { code: child.status, signal: child.signal }, originalPayload: before.payload, catalog: { beforeRecovery: before.catalog, afterRecovery: after.catalog }, backupInventory: before.backupRows, artifactInventory: { beforeRecovery: before.artifacts, afterRecovery: after.artifacts }, normalRecovery: { outcome: "safe-stop; artifacts preserved" }, nextPrepare: next });
    } finally { await box.dispose(); }
  });
});

test("S8: rollback failure restores old catalog but keeps backup namespace and blocks another prepare", async () => {
  const box = await fixture();
  try {
    const originalCatalog = await nodeState(path.join(box.root, "catalog.json"));
    const originalCatalogBytes = await readFile(path.join(box.root, "catalog.json"));
    const sourceBefore = await nodeState(box.sourcePath);
    const plan = await prepareMigration(box.root);
    const view = readMigration(plan);
    assert.equal(view.status, "ready");
    const { storageTransactions, StorageTransactions } = await import("../src/storage-transaction.ts");
    const originalRun = storageTransactions.run;
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root: string, create: boolean, operation: (session: import("../src/storage-transaction.ts").StorageSession | undefined) => Promise<unknown>) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") throw new Error("S8 synthetic catalog switch fault"); } }).run(root, create, operation, { requiresNativePlacement: false }) });
    try {
      await assert.rejects(commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /S8 synthetic catalog switch fault/i);
    } finally { Object.defineProperty(storageTransactions, "run", { configurable: true, value: originalRun }); Reflect.deleteProperty(storageTransactions, "run"); }
    const rolledBackCatalog = await nodeState(path.join(box.root, "catalog.json"));
    assert.deepEqual(rolledBackCatalog, originalCatalog);
    assert.deepEqual(await readFile(path.join(box.root, "catalog.json")), originalCatalogBytes);
    assert.deepEqual(await nodeState(box.sourcePath), sourceBefore);
    const backup = await inventory(path.join(box.root, ".migration-backups"));
    assert.ok(backup.length > 0);
    const next = await recordNextPrepare(box.root);
    assert.equal(next.status, "blocked");
    assert.ok(next.conflicts.some((entry) => /backup|preserv|exist/i.test(entry)), next.conflicts.join("; "));
    logCell({ case: "catalog-switch-failure-rollback-and-retry", checkpoint: "catalog-renamed fault -> rollback", reachedCheckpoint: "rollback completed", originalPayload: sourceBefore, editedPayload: sourceBefore, catalog: { before: originalCatalog, afterRollback: rolledBackCatalog }, backupInventory: backup, artifactInventory: await artifactInventory(box.root), rollback: "catalog v1 bytes+inode restored; permanent backup retained", nextPrepare: next, userAction: "preserve verified backup; prepare remains blocked; no manual deletion or journal rewrite" });
  } finally { Reflect.deleteProperty((await import("../src/storage-transaction.ts")).storageTransactions, "run"); await box.dispose(); }
});

test("S8: SIGKILL at every rollback checkpoint re-runs normal recovery without deleting backup", async (t) => {
  for (const point of rollbackCheckpoints) await t.test(point, async () => {
    const box = await fixture();
    try {
      const originalCatalog = await nodeState(path.join(box.root, "catalog.json"));
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScriptForRollbackCheckpoint(point), box.root], { encoding: "utf8", timeout: 30_000 });
      assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
      assert.match(String(child.stdout), new RegExp(`S8_REACHED:${point}`));
      const beforeRecovery = await capture(box.root, box.sourcePath);
      const result = await loadCatalog(box.root);
      assert.equal(result.version, 1);
      const afterRecovery = await capture(box.root, box.sourcePath);
      assert.deepEqual(afterRecovery.payload, beforeRecovery.payload);
      assert.deepEqual(afterRecovery.backupRows, beforeRecovery.backupRows);
      assert.deepEqual(afterRecovery.catalog, originalCatalog);
      const next = await recordNextPrepare(box.root);
      assert.equal(next.status, "blocked");
      logCell({ case: "rollback-checkpoint", checkpoint: point, reachedCheckpoint: point, childExit: { code: child.status, signal: child.signal }, originalPayload: beforeRecovery.payload, catalog: { beforeRecovery: beforeRecovery.catalog, afterRecovery: afterRecovery.catalog }, backupInventory: { beforeRecovery: beforeRecovery.backupRows, afterRecovery: afterRecovery.backupRows }, artifactInventory: { beforeRecovery: beforeRecovery.artifacts, afterRecovery: afterRecovery.artifacts }, normalRecovery: { outcome: "returned", version: result.version }, nextPrepare: next });
    } finally { await box.dispose(); }
  });
});

test("S8: ordinary edits during every rollback phase stay preserved and require safety hold", async (t) => {
  const editKinds: readonly EditKind[] = ["A-same-inode", "A-editor-replacement", "B-skill-addition", "C-skill-deletion"];
  for (const point of rollbackCheckpoints) for (const kind of editKinds) await t.test(`${point}/${kind}`, async () => {
    const box = await fixture(kind);
    const editTarget = kind === "B-skill-addition" ? path.join(box.skillRoot!, "new-helper.md") : kind === "C-skill-deletion" ? box.removablePath! : box.sourcePath;
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScriptForRollbackCheckpoint(point), box.root], { encoding: "utf8", timeout: 30_000 });
      assert.equal(child.signal, "SIGKILL", `${child.stdout}\\n${child.stderr}`);
      assert.match(String(child.stdout), new RegExp(`S8_REACHED:${point}`));
      const edit = await applyEdit(box, kind);
      const beforeRecovery = await capture(box.root, editTarget);
      await assert.rejects(loadCatalog(box.root), /changed|external|rollback|recovery|preserv/i);
      const afterRecovery = await capture(box.root, editTarget);
      assert.deepEqual(afterRecovery.payload, beforeRecovery.payload, `${point}/${kind}: rollback recovery must not overwrite external edit`);
      assert.deepEqual(afterRecovery.catalog, beforeRecovery.catalog, `${point}/${kind}: recovery must not move or replace the catalog after detecting edit`);
      assert.deepEqual(afterRecovery.backupRows, beforeRecovery.backupRows, `${point}/${kind}: backup custody remains exact`);
      const next = await recordNextPrepare(box.root);
      assert.equal(next.status, "blocked", `${point}/${kind}: rollback marker/transaction must keep retry blocked`);
      const resolvePlan = await prepareMigrationResolution(box.root);
      const resolveView = readMigrationResolution(resolvePlan);
      assert.notEqual(resolveView.status, "ready", `${point}/${kind}: rollback/old-catalog state is outside resolution eligibility`);
      logCell({ case: "rollback-checkpoint-edit", checkpoint: point, reachedCheckpoint: point, childExit: { code: child.status, signal: child.signal }, edit: kind, originalPayload: edit.before, editedPayload: edit.after, payloadAfterRecovery: afterRecovery.payload, catalogBeforeRecovery: beforeRecovery.catalog, catalogAfterRecovery: afterRecovery.catalog, backupInventory: { beforeRecovery: beforeRecovery.backupRows, afterRecovery: afterRecovery.backupRows }, artifactInventory: { beforeRecovery: beforeRecovery.artifacts, afterRecovery: afterRecovery.artifacts }, normalRecovery: "safe-stop; rollback marker/journal retained", resolution: { status: resolveView.status, conflicts: [...resolveView.conflicts] }, nextPrepare: next });
    } finally { await box.dispose(); }
  });
});

test("S8: unknown child inside a managed transaction artifact is preserved and keeps resolution blocked", async () => {
  const box = await fixture();
  try {
    const child = crashAt(box.root, "catalog-renamed");
    assert.equal(child.signal, "SIGKILL");
    const unknownPath = path.join(box.root, ".copi-transaction/unknown-operator-artifact.bin");
    const unknownBytes = Buffer.from("unowned internal artifact: never remove or rewrite\n");
    await writeFile(unknownPath, unknownBytes, { mode: 0o600 });
    const before = await capture(box.root, box.sourcePath);
    await assert.rejects(loadCatalog(box.root), /changed|unknown|preserv|journal|recovery/i);
    const plan = await prepareMigrationResolution(box.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    const after = await capture(box.root, box.sourcePath);
    assert.deepEqual(after, before, "neither recovery nor read-only resolver may rewrite/delete unknown managed internals");
    assert.deepEqual(await readFile(unknownPath), unknownBytes);
    logCell({ case: "unknown-managed-internal-preservation", checkpoint: "catalog-renamed", childExit: { code: child.status, signal: child.signal }, unknownArtifact: await nodeState(unknownPath), catalog: before.catalog, backupInventory: before.backupRows, artifactInventory: { before, after }, normalRecovery: "safe-stop", resolution: { status: view.status, conflicts: [...view.conflicts] }, nextPrepare: await recordNextPrepare(box.root), userAction: "leave the unknown internal artifact, backup and journal untouched; investigate before any retry" });
  } finally { await box.dispose(); }
});
