import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { renameSavedItem } from "../src/catalog.ts";
import { projectMigrationInventory, scanMigrationInventory } from "../src/migration-inventory.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange } from "../src/resource-mutations.ts";
import { makeLegacyItem, createLegacyLibrary, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const itemId = "123e4567-e89b-42d3-a456-426614174000";
const sourceRelative = "sources/current/AGENTS.md";
const actionPoints = ["after-action-intent-root-sync", "after-action-unlink"] as const;

async function fixture() {
  const box = await createLegacyLibrary();
  const sourcePath = await writeBytes(box.root, sourceRelative, Buffer.from("original included source\n"), 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

async function replaceByRename(target: string, bytes: Buffer): Promise<{ dev: string; ino: string; mode: number; bytesHash: string }> {
  const before = await lstat(target, { bigint: true });
  assert.ok(before.isFile());
  const temporary = `${target}.editor-${randomUUID()}`;
  const mode = Number(before.mode & 0o7777n);
  await writeFile(temporary, bytes, { mode });
  await chmod(temporary, mode);
  await rename(temporary, target);
  const after = await lstat(target, { bigint: true });
  assert.ok(after.isFile());
  assert.notEqual(after.ino, before.ino, "editor-style rename replacement must install a different inode");
  return { dev: after.dev.toString(), ino: after.ino.toString(), mode: Number(after.mode & 0o7777n), bytesHash: digest(bytes) };
}

function crashMigrationAtCatalogSwitch(root: string): void {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const script = `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation) });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigration(process.argv[1]);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
}

async function crashResolutionAt(root: string, point: string, occurrence = 0): Promise<void> {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  const script = `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    let seen = 0;
    resolution.setMigrationResolutionCheckpointForTests((at) => {
      if (at === ${JSON.stringify(point)} && seen++ === ${occurrence}) process.kill(process.pid, "SIGKILL");
    });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigrationResolution(process.argv[1]);
    const view = api.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", `${point}#${occurrence}: ${child.stdout}\n${child.stderr}`);
}

async function tuple(target: string) {
  const [stat, bytes] = await Promise.all([lstat(target, { bigint: true }), readFile(target)]);
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o7777n), bytesHash: digest(bytes), bytes };
}

async function assertFinalInventory(root: string, approvedInventory: { hash: string; nodes: unknown[] }): Promise<void> {
  const current = await scanMigrationInventory(root);
  const withoutBackup = projectMigrationInventory(current, [".migration-backups"]);
  assert.equal(withoutBackup.hash, approvedInventory.hash, "final payload inventory hash must match the durable approved inventory");
  assert.deepEqual(withoutBackup.nodes, approvedInventory.nodes, "final payload inventory nodes must match the durable approved inventory");
}

async function assertFinalized(box: Awaited<ReturnType<typeof fixture>>, expectedSource: { dev: string; ino: string; mode: number; bytesHash: string }, values: {
  catalog: Awaited<ReturnType<typeof tuple>>;
  backupSnapshot: string;
  itemsSnapshot: string;
  sourcesSnapshot: string;
  approvedInventory: { hash: string; nodes: unknown[] };
  backupDir: string;
}): Promise<void> {
  const catalog = await tuple(path.join(box.root, "catalog.json"));
  assert.deepEqual({ ...catalog, bytes: undefined }, { ...values.catalog, bytes: undefined }, "resolution must not rewrite or replace the current v2 catalog");
  assert.equal(await treeSnapshot(path.join(box.root, ".migration-backups")), values.backupSnapshot, "permanent backup custody must remain unchanged");
  assert.equal(await treeSnapshot(path.join(box.root, "items")), values.itemsSnapshot, "legacy payload tree must remain unchanged");
  assert.equal(await treeSnapshot(path.join(box.root, "sources")), values.sourcesSnapshot, "approved source payload must remain unchanged after its editor replacement");
  const source = await tuple(box.sourcePath);
  assert.deepEqual({ dev: source.dev, ino: source.ino, mode: source.mode, bytesHash: source.bytesHash }, expectedSource);
  assert.deepEqual(source.bytes, await readFile(box.sourcePath));
  assert.deepEqual(await readFile(path.join(box.root, values.backupDir, "files/sources/current/AGENTS.md")), Buffer.from("original included source\n"));
  for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
    await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
  }
  await assertFinalInventory(box.root, values.approvedInventory);
}

test("A editor-style rename replacement resumes across all nine cleanup actions at intent-sync and unlink", async (t) => {
  for (const point of actionPoints) {
    for (let action = 0; action < 9; action += 1) {
      await t.test(`${point} action=${action}`, async () => {
        const box = await fixture();
        try {
          crashMigrationAtCatalogSwitch(box.root);
          const editedBytes = Buffer.from(`editor rename replacement action ${action} ${point}\n`);
          const editedSource = await replaceByRename(box.sourcePath, editedBytes);
          const catalog = await tuple(path.join(box.root, "catalog.json"));
          const backupSnapshot = await treeSnapshot(path.join(box.root, ".migration-backups"));
          const itemsSnapshot = await treeSnapshot(path.join(box.root, "items"));
          const sourcesSnapshot = await treeSnapshot(path.join(box.root, "sources"));

          await crashResolutionAt(box.root, point, action);
          const record = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
            approvedInventory: { hash: string; nodes: unknown[] }; backupDir: string; currentCatalog: { dev: string; ino: string; bytesHash: string };
          };
          const recordCatalog = record.currentCatalog;
          assert.deepEqual(recordCatalog, { kind: "file", mode: catalog.mode, dev: catalog.dev, ino: catalog.ino, bytesHash: catalog.bytesHash });
          const beforePrepare = await treeSnapshot(box.root);
          const plan = await prepareMigrationResolution(box.root);
          const view = readMigrationResolution(plan);
          assert.equal(view.status, "ready", view.conflicts.join("; "));
          assert.equal(await treeSnapshot(box.root), beforePrepare, "resolution prepare/read must be readonly at each crash point");
          await commitMigrationResolution(plan, {
            reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths],
          });

          await assertFinalized(box, editedSource, {
            catalog, backupSnapshot, itemsSnapshot, sourcesSnapshot,
            approvedInventory: record.approvedInventory, backupDir: record.backupDir,
          });
        } finally { await box.dispose(); }
      });
    }
  }
});

test("A action-4 fresh generation rejects an old plan after rename replacement and resumes with exact current inventory", async () => {
  const box = await fixture();
  try {
    crashMigrationAtCatalogSwitch(box.root);
    const firstBytes = Buffer.from("first editor rename replacement\n");
    await replaceByRename(box.sourcePath, firstBytes);
    const catalog = await tuple(path.join(box.root, "catalog.json"));
    const backupSnapshot = await treeSnapshot(path.join(box.root, ".migration-backups"));
    const itemsSnapshot = await treeSnapshot(path.join(box.root, "items"));
    await crashResolutionAt(box.root, "after-action-unlink", 4);

    const predecessorBytes = await readFile(path.join(box.root, ".copi-migration-resolution.json"));
    const stalePlan = await prepareMigrationResolution(box.root);
    const staleView = readMigrationResolution(stalePlan);
    assert.equal(staleView.status, "ready", staleView.conflicts.join("; "));

    const freshBytes = Buffer.from('apiKey = "SYNTHETIC_R4_FRESH_GENERATION_SECRET_318742"\nnew editor inode\n');
    const beforeFreshSource = await tuple(box.sourcePath);
    const freshSource = await replaceByRename(box.sourcePath, freshBytes);
    assert.notEqual(freshSource.ino, beforeFreshSource.ino);
    const freshSourcesSnapshot = await treeSnapshot(path.join(box.root, "sources"));
    const beforeStaleCommit = await treeSnapshot(box.root);
    await assert.rejects(commitMigrationResolution(stalePlan, {
      reviewId: staleView.reviewId, confirmed: true, approvedSensitivePaths: [...staleView.sensitivePaths],
    }), /changed|fresh|review|resolution/i);
    assert.equal(await treeSnapshot(box.root), beforeStaleCommit, "old generation plan must not mutate the replaced source or cleanup state");
    assert.deepEqual((await tuple(box.sourcePath)).bytes, freshBytes);

    const freshPlan = await prepareMigrationResolution(box.root);
    const freshView = readMigrationResolution(freshPlan);
    assert.equal(freshView.status, "ready", freshView.conflicts.join("; "));
    assert.deepEqual(freshView.sensitivePaths, [`${itemId}/AGENTS.md`]);
    await crashResolutionAt(box.root, "after-generation-root-sync");
    const recordPath = path.join(box.root, ".copi-migration-resolution.json");
    const generationRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
      generation: number; predecessorHash: string | null; reviewId: string; sensitivePaths: string[]; confirmed: boolean;
      approvedInventory: { hash: string; nodes: unknown[] }; backupDir: string;
    };
    assert.equal(generationRecord.generation, 2);
    assert.equal(generationRecord.predecessorHash, digest(predecessorBytes));
    assert.notEqual(generationRecord.reviewId, staleView.reviewId);
    assert.deepEqual(generationRecord.sensitivePaths, freshView.sensitivePaths);
    assert.equal(generationRecord.confirmed, true);

    const node = generationRecord.approvedInventory.nodes.find((entry) => (entry as { path?: string }).path === sourceRelative) as {
      kind: string; dev: string; ino: string; mode: number; bytesHash: string;
    } | undefined;
    assert.ok(node, "generation approvedInventory must retain the current adopted source node");
    assert.deepEqual(node, { path: sourceRelative, kind: "file", dev: freshSource.dev, ino: freshSource.ino, mode: freshSource.mode, bytesHash: freshSource.bytesHash });
    const currentWithoutOwnedArtifacts = await scanMigrationInventory(box.root, {
      excludedPrefixes: [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json", ".migration-backups"],
    });
    assert.equal(currentWithoutOwnedArtifacts.hash, generationRecord.approvedInventory.hash);
    assert.deepEqual(currentWithoutOwnedArtifacts.nodes, generationRecord.approvedInventory.nodes);

    const resumePlan = await prepareMigrationResolution(box.root);
    const resumeView = readMigrationResolution(resumePlan);
    assert.equal(resumeView.status, "ready", resumeView.conflicts.join("; "));
    await commitMigrationResolution(resumePlan, {
      reviewId: resumeView.reviewId, confirmed: true, approvedSensitivePaths: [...resumeView.sensitivePaths],
    });
    await assertFinalized(box, freshSource, {
      catalog, backupSnapshot, itemsSnapshot, sourcesSnapshot: freshSourcesSnapshot,
      approvedInventory: generationRecord.approvedInventory, backupDir: generationRecord.backupDir,
    });
    assert.deepEqual((await tuple(box.sourcePath)).bytes, freshBytes);
  } finally { await box.dispose(); }
});

interface ControlledChild {
  readonly output: string;
  readonly errors: string;
  waitFor(marker: string, timeoutMs?: number): Promise<void>;
  send(line: string): void;
  terminate(): void;
}
function controlledChild(script: string, root: string): ControlledChild {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  const waiters: Array<{ marker: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  const check = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (output.includes(waiter.marker)) { clearTimeout(waiter.timer); waiters.splice(index, 1); waiter.resolve(); }
    }
  };
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); check(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  child.once("exit", (code, signal) => {
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error(`Child exited (${code ?? signal}): ${output}\n${errors}`)); }
  });
  return {
    get output() { return output; },
    get errors() { return errors; },
    waitFor(marker, timeoutMs = 8_000) {
      if (output.includes(marker)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.marker === marker);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${marker}: ${output}\n${errors}`));
        }, timeoutMs);
        waiters.push({ marker, resolve, reject, timer });
      });
    },
    send(line) { child.stdin.write(line); },
    terminate() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
  };
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function finalizerScript(): string {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  return `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    resolution.setMigrationResolutionCheckpointForTests(async (point, root) => {
      if (point === "after-action-unlink" && root === process.argv[1] && seen++ === 8) {
        process.stdout.write("CLAIM_GONE_RECORD_PRESENT\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
      }
    });
    let seen = 0;
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigrationResolution(process.argv[1]);
    const view = api.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    process.stdout.write("FINALIZER_READY\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    try {
      await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      process.stdout.write("FINALIZER_DONE\\n");
    } catch (error) { process.stderr.write(String(error) + "\\n"); process.stdout.write("FINALIZER_ERROR\\n"); }
  `;
}
function ordinaryWriterScript(kind: "catalog" | "sources"): string {
  const catalogUrl = new URL("../src/catalog.js", import.meta.url).href;
  const mutationUrl = new URL("../src/resource-mutations.js", import.meta.url).href;
  if (kind === "catalog") return `
    const { renameSavedItem } = await import(${JSON.stringify(catalogUrl)});
    process.stdout.write("WRITER_STARTED\\n");
    const item = await renameSavedItem(process.argv[1], ${JSON.stringify(itemId)}, "ordinary catalog writer completed");
    process.stdout.write("WRITER_DONE:" + item.name + "\\n");
  `;
  return `
    const { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange } = await import(${JSON.stringify(mutationUrl)});
    process.stdout.write("WRITER_STARTED\\n");
    const edit = await prepareSavedEdit(process.argv[1], ${JSON.stringify(itemId)}, "AGENTS.md");
    const change = await prepareSavedChange(edit, Buffer.from("ordinary saved-source API edit\\n"));
    const view = readSavedChange(change);
    await commitSavedChange(change, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    process.stdout.write("WRITER_DONE:sources API\\n");
  `;
}

test("ordinary catalog mutation waits through action-8 claim removal, then stale resolution plan is rejected", async () => {
  const box = await fixture();
  const children: ControlledChild[] = [];
  try {
    crashMigrationAtCatalogSwitch(box.root);
    const stalePlan = await prepareMigrationResolution(box.root);
    const staleView = readMigrationResolution(stalePlan);
    assert.equal(staleView.status, "ready", staleView.conflicts.join("; "));

    const finalizer = controlledChild(finalizerScript(), box.root);
    children.push(finalizer);
    await finalizer.waitFor("FINALIZER_READY");
    finalizer.send("GO\n");
    await finalizer.waitFor("CLAIM_GONE_RECORD_PRESENT");
    await assert.rejects(lstat(path.join(box.root, ".copi-transaction-recovery")), { code: "ENOENT" });
    await lstat(path.join(box.root, ".copi-migration-resolution.json"));
    const catalogBefore = await tuple(path.join(box.root, "catalog.json"));
    const sourceBefore = await tuple(box.sourcePath);

    const writer = controlledChild(ordinaryWriterScript("catalog"), box.root);
    children.push(writer);
    await writer.waitFor("WRITER_STARTED");
    await delay(200);
    assert.equal(writer.output.includes("WRITER_DONE:"), false, "ordinary catalog API must wait while the final resolution record exists under the root lease");
    assert.deepEqual({ ...(await tuple(path.join(box.root, "catalog.json"))), bytes: undefined }, { ...catalogBefore, bytes: undefined });
    assert.deepEqual({ ...(await tuple(box.sourcePath)), bytes: undefined }, { ...sourceBefore, bytes: undefined });
    await lstat(path.join(box.root, ".copi-migration-resolution.json"));

    finalizer.send("RELEASE\n");
    await finalizer.waitFor("FINALIZER_DONE");
    await writer.waitFor("WRITER_DONE:ordinary catalog writer completed");
    await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    const catalogAfter = JSON.parse(await readFile(path.join(box.root, "catalog.json"), "utf8")) as { items: Array<{ name: string }> };
    assert.equal(catalogAfter.items[0]?.name, "ordinary catalog writer completed");
    const beforeStalePlan = await treeSnapshot(box.root);
    await assert.rejects(commitMigrationResolution(stalePlan, {
      reviewId: staleView.reviewId, confirmed: true, approvedSensitivePaths: [...staleView.sensitivePaths],
    }), /changed|fresh|review|not-needed|resolution/i);
    assert.equal(await treeSnapshot(box.root), beforeStalePlan, "old resolution plan must not alter the ordinary catalog write or payload");
  } finally {
    for (const child of children) child.terminate();
    await box.dispose();
  }
});

test("ordinary sources edit API waits through action-8 claim removal, then stale resolution plan is rejected", async () => {
  const box = await fixture();
  const children: ControlledChild[] = [];
  try {
    crashMigrationAtCatalogSwitch(box.root);
    const stalePlan = await prepareMigrationResolution(box.root);
    const staleView = readMigrationResolution(stalePlan);
    assert.equal(staleView.status, "ready", staleView.conflicts.join("; "));

    const finalizer = controlledChild(finalizerScript(), box.root);
    children.push(finalizer);
    await finalizer.waitFor("FINALIZER_READY");
    finalizer.send("GO\n");
    await finalizer.waitFor("CLAIM_GONE_RECORD_PRESENT");
    await assert.rejects(lstat(path.join(box.root, ".copi-transaction-recovery")), { code: "ENOENT" });
    await lstat(path.join(box.root, ".copi-migration-resolution.json"));
    const catalogBefore = await tuple(path.join(box.root, "catalog.json"));
    const sourceBefore = await tuple(box.sourcePath);

    const writer = controlledChild(ordinaryWriterScript("sources"), box.root);
    children.push(writer);
    await writer.waitFor("WRITER_STARTED");
    await delay(200);
    assert.equal(writer.output.includes("WRITER_DONE:"), false, "ordinary sources edit API must wait while the final resolution record exists under the root lease");
    assert.deepEqual({ ...(await tuple(path.join(box.root, "catalog.json"))), bytes: undefined }, { ...catalogBefore, bytes: undefined });
    assert.deepEqual({ ...(await tuple(box.sourcePath)), bytes: undefined }, { ...sourceBefore, bytes: undefined });
    await lstat(path.join(box.root, ".copi-migration-resolution.json"));

    finalizer.send("RELEASE\n");
    await finalizer.waitFor("FINALIZER_DONE");
    await writer.waitFor("WRITER_DONE:sources API");
    await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    assert.deepEqual(await readFile(box.sourcePath), Buffer.from("ordinary saved-source API edit\n"));
    const beforeStalePlan = await treeSnapshot(box.root);
    await assert.rejects(commitMigrationResolution(stalePlan, {
      reviewId: staleView.reviewId, confirmed: true, approvedSensitivePaths: [...staleView.sensitivePaths],
    }), /changed|fresh|review|not-needed|resolution/i);
    assert.equal(await treeSnapshot(box.root), beforeStalePlan, "old resolution plan must not alter the ordinary source API write");
  } finally {
    for (const child of children) child.terminate();
    await box.dispose();
  }
});
