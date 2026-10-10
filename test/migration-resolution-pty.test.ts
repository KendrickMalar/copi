import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { box as guardedBox } from "./helpers/issue3-acceptance.ts";
import { cli, pty, plain, runCli, type Step } from "./helpers/issue6-acceptance.ts";
import { commitMigration, prepareMigration, readMigration } from "../src/migration.ts";
import { StorageTransactions, storageTransactions } from "../src/storage-transaction.ts";
import { makeLegacyItem, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const editedSecret = Buffer.from('apiKey = "SYNTHETIC_RESOLUTION_EDITED_SECRET_493821"\nordinary edited source body\n');
const sourceBytes = Buffer.from('apiKey = "SYNTHETIC_RESOLUTION_ORIGINAL_SECRET_938271"\noriginal source body\n');
const wholePrompt = "この masked diff をすべて確認し、解消手順の対象としてよいですか。";
const finalPrompt = "確認した sources の編集をそのまま保持し、移行終了を確定しますか。";
const sensitivePrompt = "秘密情報候補 [internal reference]/AGENTS.md を個別に確認しましたか。内容は表示されません。";
const uuidPattern = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
async function fileState(target: string) {
  const stat = await lstat(target, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o7777n), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), sha256: digest(await readFile(target)) };
}

async function createLegacyHomeFixture() {
  const box = await guardedBox();
  await mkdir(box.library, { recursive: true, mode: 0o700 });
  const sourcePath = await writeBytes(box.library, "sources/current/AGENTS.md", sourceBytes, 0o640);
  const item = makeLegacyItem({
    sourcePath,
    files: [{ path: "AGENTS.md", mode: 0o640, sha256: digest(sourceBytes) }],
  });
  await writeLegacyCatalog(box.library, [item]);
  await writeLegacySnapshot(box.library, sourceBytes);
  return { box, sourcePath };
}

function crashMigrationAtCatalogSwitch(root: string): ReturnType<typeof spawnSync> {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const script = `
    const transaction = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(transaction.storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new transaction.StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation, { requiresNativePlacement: false }) });
    const migration = await import(${JSON.stringify(migrationUrl)});
    const plan = await migration.prepareMigration(process.argv[1]);
    const view = migration.readMigration(plan);
    if (view.status !== "ready") throw new Error("migration fixture blocked: " + JSON.stringify(view.conflicts));
    await migration.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
}

// Set COPI_TEST_TRACE=1 to print each recorded case for diagnosis.
function traceRecord(label: string, record: unknown): void {
  if (process.env.COPI_TEST_TRACE) console.log(`R4 resolution CLI ${label} ${JSON.stringify(record)}`);
}

async function snapshotHome(box: Awaited<ReturnType<typeof guardedBox>>) {
  return treeSnapshot(box.home);
}

test("README hold-stop route: actual CLI dry-run points to resolve, then PTY confirms safe resolution", async () => {
  const { box, sourcePath } = await createLegacyHomeFixture();
  const checkpoint = crashMigrationAtCatalogSwitch(box.library);
  assert.equal(checkpoint.signal, "SIGKILL", `${checkpoint.stdout}\n${checkpoint.stderr}`);
  await writeFile(sourcePath, editedSecret);
  const sourcesBefore = await treeSnapshot(path.join(box.library, "sources"));
  const itemsBefore = await treeSnapshot(path.join(box.library, "items"));
  const catalogBefore = await fileState(path.join(box.library, "catalog.json"));
  const backupBefore = await treeSnapshot(path.join(box.library, ".migration-backups"));
  const homeBeforeDryRuns = await snapshotHome(box);

  const ordinaryPreview = runCli(box, ["migrate", "--dry-run"]);
  assert.equal(ordinaryPreview.status, 1, ordinaryPreview.stderr);
  assert.match(plain(ordinaryPreview.stdout), /Legacy migration: blocked/);
  assert.match(ordinaryPreview.stdout, /copi migrate --resolve --dry-run/);
  assert.match(ordinaryPreview.stdout, /内部 lock を手で削除しないでください/);
  assert.equal(await snapshotHome(box), homeBeforeDryRuns, "ordinary blocked dry-run must preserve the complete HOME");

  const resolverPreview = runCli(box, ["migrate", "--resolve", "--dry-run"]);
  assert.equal(resolverPreview.status, 0, resolverPreview.stderr);
  assert.match(plain(resolverPreview.stdout), /Migration resolution: ready/);
  assert.match(resolverPreview.stdout, /ordinary edited source body/);
  assert.equal(resolverPreview.stdout.includes(editedSecret.toString()), false, "secret bytes must stay masked in dry-run output");
  assert.equal(await snapshotHome(box), homeBeforeDryRuns, "resolver dry-run must be read-only across HOME");

  const beforeResolve = await snapshotHome(box);
  const steps: Step[] = [
    { wait: wholePrompt, text: "y\r", checkpoint: true },
    { wait: sensitivePrompt, text: "y\r", checkpoint: true },
    { wait: finalPrompt, text: "y\r", checkpoint: true },
  ];
  const resolved = await pty(box, [process.execPath, cli, "migrate", "--resolve"], steps, "tty", [38, 160]);
  assert.equal(resolved.timeout, false, resolved.output);
  assert.equal(resolved.code, 0, resolved.output);
  assert.equal(resolved.actions, steps.length, "whole, sensitive-path and final prompts must all be reached");
  assert.equal(resolved.exact, true, JSON.stringify({ before: resolved.before, after: resolved.after }));
  assert.doesNotMatch(resolved.output, uuidPattern, "normal output must mask internal UUIDs");
  assert.equal(resolved.output.includes(sourceBytes.toString()), false);
  assert.equal(resolved.output.includes(editedSecret.toString()), false);
  assert.match(resolved.output, /確認付き解消が完了しました/);
  assert.match(resolved.output, /検証済みバックアップ/);
  assert.equal((await readFile(sourcePath)).toString(), editedSecret.toString(), "resolution retains current source bytes without rewriting them");
  assert.equal(await treeSnapshot(path.join(box.library, "sources")), sourcesBefore);
  assert.equal(await treeSnapshot(path.join(box.library, "items")), itemsBefore);
  const catalogAfter = await fileState(path.join(box.library, "catalog.json"));
  assert.deepEqual(
    { dev: catalogAfter.dev, ino: catalogAfter.ino, mode: catalogAfter.mode, size: catalogAfter.size, mtimeNs: catalogAfter.mtimeNs, sha256: catalogAfter.sha256 },
    { dev: catalogBefore.dev, ino: catalogBefore.ino, mode: catalogBefore.mode, size: catalogBefore.size, mtimeNs: catalogBefore.mtimeNs, sha256: catalogBefore.sha256 },
    "resolution must not replace or rewrite catalog bytes or permissions",
  );
  assert.equal(await treeSnapshot(path.join(box.library, ".migration-backups")), backupBefore);
  for (const artifact of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
    await assert.rejects(lstat(path.join(box.library, artifact)), { code: "ENOENT" }, `${artifact} is an owned resolution leftover`);
  }
  const afterResolve = await snapshotHome(box);
  const next = runCli(box, ["migrate", "--dry-run"]);
  assert.equal(next.status, 0, next.stderr);
  assert.match(plain(next.stdout), /already-v2|すでに v2/);
  traceRecord("hold-stop-resolve", {
    library: box.library,
    itemIdMasked: "[internal reference]",
    editSha256: digest(editedSecret),
    crash: { signal: checkpoint.signal, output: checkpoint.stdout },
    ordinaryBlockedDryRun: { status: ordinaryPreview.status, stdout: ordinaryPreview.stdout, stderr: ordinaryPreview.stderr },
    resolverReadOnlyDryRun: { status: resolverPreview.status, stdout: resolverPreview.stdout, stderr: resolverPreview.stderr, before: homeBeforeDryRuns, after: await snapshotHome(box) },
    resolverPty: { code: resolved.code, actions: resolved.actions, timeline: resolved.timeline, output: resolved.output, tmpPath: resolved.log, statePath: resolved.statePath },
    payloadChecks: { sourcesUnchangedDuringResolve: true, itemsUnchanged: true, catalogBefore, catalogAfter, backupUnchanged: true, sourceEditSha256: digest(await readFile(sourcePath)) },
    leftoversRemoved: [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"],
    homeBeforeResolve: beforeResolve,
    homeAfterResolve: afterResolve,
    nextDryRun: { status: next.status, stdout: next.stdout },
    fixtureItemId: "[internal reference]",
  });
});

test("README rollback symptom: real ordinary migrate dry-run stays blocked by retained backup namespace", async () => {
  const { box, sourcePath } = await createLegacyHomeFixture();
  const plan = await prepareMigration(box.library);
  const view = readMigration(plan);
  assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
  const originalRun = storageTransactions.run;
  Object.defineProperty(storageTransactions, "run", {
    configurable: true,
    value: (root: string, create: boolean, operation: (session: import("../src/storage-transaction.ts").StorageSession | undefined) => Promise<unknown>) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") throw new Error("synthetic CLI rollback checkpoint"); } })
        .run(root, create, operation, { requiresNativePlacement: false }),
  });
  try {
    await assert.rejects(commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /synthetic CLI rollback checkpoint/);
  } finally {
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: originalRun });
    Reflect.deleteProperty(storageTransactions, "run");
  }
  const backupPath = path.join(box.library, ".migration-backups");
  const backupBefore = await treeSnapshot(backupPath);
  await assert.rejects(lstat(path.join(box.library, ".copi-transaction")), { code: "ENOENT" });
  const homeBefore = await snapshotHome(box);
  const blocked = runCli(box, ["migrate", "--dry-run"]);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(plain(blocked.stdout), /Legacy migration: blocked/);
  assert.match(blocked.stdout, /An existing migration backup namespace is preserved and is not adopted automatically/);
  assert.match(blocked.stdout, /not adopted automatically|not adopted|preserv/i);
  assert.equal(await snapshotHome(box), homeBefore, "blocked retry preview must be read-only");
  assert.equal(await treeSnapshot(backupPath), backupBefore, "rollback's backup namespace remains untouched");
  assert.equal(await (await import("node:fs/promises")).readFile(sourcePath).then(digest), digest(sourceBytes));
  traceRecord("rollback-backup-blocked", {
    command: "copi migrate --dry-run",
    status: blocked.status,
    stdout: blocked.stdout,
    stderr: blocked.stderr,
    homeBefore: homeBefore,
    homeAfter: await snapshotHome(box),
    backupNamespace: backupBefore,
    sourceBytesSha256: digest(await (await import("node:fs/promises")).readFile(sourcePath)),
    expectedUserAction: "preserve the backup namespace; do not retry, restore, move, or delete it",
  });
});
