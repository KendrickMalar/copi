import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { loadCatalog } from "../src/catalog.ts";
import { makeLegacyItem, createLegacyLibrary, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const secret1 = "SYNTHETIC_LATE_CHECKPOINT_SECRET_921735";
const secret2 = "SYNTHETIC_FRESH_GENERATION_SECRET_392841";

async function fixture() {
  const box = await createLegacyLibrary();
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", Buffer.from("original included source\n"), 0o640);
  await mkdir(path.join(box.root, "sources/current/empty-probe"), { mode: 0o755 });
  await writeBytes(box.root, "sources/current/.env-baseline", Buffer.from("excluded baseline bytes\n"), 0o600);
  await writeBytes(box.root, "root-loose.txt", Buffer.from("baseline loose bytes\n"), 0o600);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

type EditKind = "A" | "B" | "C";
async function fixtureForEdit(kind: EditKind) {
  if (kind === "A") return { ...(await fixture()), kind };
  const box = await createLegacyLibrary();
  const skillRoot = path.join(box.root, "sources/skill");
  const skillBytes = Buffer.from("# Checkpoint matrix skill\n");
  const removableBytes = Buffer.from("baseline helper file\n");
  const skillPath = await writeBytes(box.root, "sources/skill/SKILL.md", skillBytes, 0o640);
  const removablePath = await writeBytes(box.root, "sources/skill/remove-me.md", removableBytes, 0o600);
  const item = makeLegacyItem({ kind: "skill", sourcePath: skillRoot, files: [
    { path: "SKILL.md", mode: 0o640, sha256: sha256(skillBytes) },
    { path: "remove-me.md", mode: 0o600, sha256: sha256(removableBytes) },
  ] });
  await writeLegacyCatalog(box.root, [item]);
  await writeLegacySnapshot(box.root, skillBytes, `items/${item.id}/files/SKILL.md`, 0o640);
  await writeLegacySnapshot(box.root, removableBytes, `items/${item.id}/files/remove-me.md`, 0o600);
  return { ...box, kind, sourcePath: kind === "B" ? skillPath : removablePath, skillPath, removablePath, skillRoot, skillBytes };
}

async function applyAllowedEdit(box: Awaited<ReturnType<typeof fixtureForEdit>>): Promise<void> {
  if (box.kind === "A") await writeFile(box.sourcePath, Buffer.from("editor replacement after catalog switch\n"));
  else if (box.kind === "B") await writeBytes(box.root, "sources/skill/new-helper.md", Buffer.from("new helper at arbitrary mode\n"), 0o751);
  else await unlink(box.removablePath);
}

async function assertResolutionCompleted(box: Awaited<ReturnType<typeof fixtureForEdit>>): Promise<void> {
  if (box.kind === "A") assert.deepEqual(await readFile(box.sourcePath), Buffer.from("editor replacement after catalog switch\n"));
  else if (box.kind === "B") {
    const added = path.join(box.root, "sources/skill/new-helper.md");
    assert.deepEqual(await readFile(added), Buffer.from("new helper at arbitrary mode\n"));
    assert.equal((await lstat(added)).mode & 0o777, 0o751);
    assert.deepEqual(await readFile(box.skillPath), box.skillBytes);
  } else {
    await assert.rejects(readFile(box.removablePath), { code: "ENOENT" });
    assert.deepEqual(await readFile(box.skillPath), box.skillBytes);
  }
  assert.equal((await loadCatalog(box.root)).version, 2);
  for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
    await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
  }
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

async function replaceWithSameBytes(target: string): Promise<void> {
  const bytes = await readFile(target);
  const stat = await import("node:fs/promises").then(({ lstat }) => lstat(target));
  const temp = `${target}.independent-probe`;
  await writeFile(temp, bytes, { mode: stat.mode & 0o777 });
  await chmod(temp, stat.mode & 0o777);
  await rename(temp, target);
}

async function mutateJournal(root: string, update: (journal: Record<string, unknown>) => void): Promise<void> {
  const lock = path.join(root, ".copi-transaction");
  const journalPath = path.join(lock, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
  update(journal);
  const raw = Buffer.from(JSON.stringify(journal));
  await writeFile(journalPath, raw);
  await writeFile(path.join(lock, "journal.digest"), Buffer.from(sha256(raw), "ascii"));
}

async function assertReadonlyBlocked(root: string, label: string): Promise<void> {
  const before = await treeSnapshot(root);
  const plan = await prepareMigrationResolution(root);
  const view = readMigrationResolution(plan);
  assert.equal(view.status, "blocked", `${label}: ${view.conflicts.join("; ")}`);
  assert.ok(view.conflicts.length > 0, `${label}: blocked status must explain why`);
  assert.equal(await treeSnapshot(root), before, `${label}: prepare/read changed filesystem state`);
}

test("prepare/read stay readonly for missing, v1, v5-ready and completed v2 states", async () => {
  const box = await fixture();
  try {
    const missing = path.join(box.root, "not-created");
    const beforeParent = await treeSnapshot(box.root);
    const missingPlan = await prepareMigrationResolution(missing);
    assert.equal(readMigrationResolution(missingPlan).status, "not-needed");
    assert.equal(await treeSnapshot(box.root), beforeParent, "missing-library review must not create the root");

    const v1Before = await treeSnapshot(box.root);
    const v1Plan = await prepareMigrationResolution(box.root);
    assert.equal(readMigrationResolution(v1Plan).status, "not-needed");
    assert.equal(await treeSnapshot(box.root), v1Before, "unlocked v1 inspection must not create migration metadata");

    crashMigrationAtCatalogSwitch(box.root);
    await writeFile(box.sourcePath, Buffer.from("allowed source edit\n"));
    const v5Before = await treeSnapshot(box.root);
    const v5Plan = await prepareMigrationResolution(box.root);
    assert.equal(readMigrationResolution(v5Plan).status, "ready");
    assert.equal(await treeSnapshot(box.root), v5Before, "v5 prepare and detached read must preserve every node");
    const v5Again = await prepareMigrationResolution(box.root);
    assert.equal(readMigrationResolution(v5Again).status, "ready");
    assert.equal(await treeSnapshot(box.root), v5Before, "repeated v5 prepare must remain readonly");
    const v5View = readMigrationResolution(v5Again);
    await commitMigrationResolution(v5Again, { reviewId: v5View.reviewId, confirmed: true, approvedSensitivePaths: [...v5View.sensitivePaths] });

    const v2Before = await treeSnapshot(box.root);
    const v2Plan = await prepareMigrationResolution(box.root);
    assert.equal(readMigrationResolution(v2Plan).status, "not-needed");
    assert.equal(await treeSnapshot(box.root), v2Before, "already-v2 resolution inspection must not write");
  } finally { await box.dispose(); }
});

test("unmanaged root mutations during resolution are ignored and preserved", async (t) => {
  for (const kind of ["bytes", "addition", "same-byte inode replacement", "hardlink alias"] as const) await t.test(kind, async () => {
    const box = await fixture();
    const loosePath = path.join(box.root, kind === "addition" ? "new-root-loose.txt" : kind === "hardlink alias" ? "source-alias" : "root-loose.txt");
    try {
      crashMigrationAtCatalogSwitch(box.root);
      await writeFile(box.sourcePath, Buffer.from("approved source edit after catalog switch\n"));
      const beforeLoose = await lstat(loosePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (kind === "bytes") await writeFile(loosePath, "external replacement\n");
      else if (kind === "addition") await writeBytes(box.root, "new-root-loose.txt", Buffer.from("unregistered\n"), 0o600);
      else if (kind === "same-byte inode replacement") await replaceWithSameBytes(loosePath);
      else await link(box.sourcePath, loosePath);
      const expectedBytes = kind === "bytes" ? Buffer.from("external replacement\n")
        : kind === "addition" ? Buffer.from("unregistered\n")
          : kind === "hardlink alias" ? Buffer.from("approved source edit after catalog switch\n")
            : Buffer.from("baseline loose bytes\n");
      const afterLoose = await lstat(loosePath);
      const plan = await prepareMigrationResolution(box.root);
      const view = readMigrationResolution(plan);
      assert.equal(view.status, "ready", `${kind}: ${view.conflicts.join("; ")}`);
      await commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      assert.deepEqual(await readFile(loosePath), expectedBytes, `${kind}: unrelated root data must be retained`);
      if (kind === "same-byte inode replacement") assert.notEqual(afterLoose.ino, beforeLoose!.ino);
      if (kind === "hardlink alias") assert.equal(afterLoose.ino, (await lstat(box.sourcePath)).ino);
      assert.equal((await loadCatalog(box.root)).version, 2);
      for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
        await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
      }
    } finally { await box.dispose(); }
  });
});

test("managed payload and journal mutations block resolution and preserve every observed node", async (t) => {
  const cases: Array<{ name: string; mutate: (root: string, sourcePath: string) => Promise<void | (() => Promise<void>)> }> = [
    { name: "items file same-byte inode replacement", mutate: async (root) => { await replaceWithSameBytes(path.join(root, "items/123e4567-e89b-42d3-a456-426614174000/files/AGENTS.md")); } },
    { name: "adjacent unregistered source addition", mutate: async (root) => { await writeBytes(root, "sources/current/neighbor.md", Buffer.from("not adopted\n"), 0o600); } },
    { name: "empty directory removal", mutate: async (root) => { await rmdir(path.join(root, "sources/current/empty-probe")); } },
    { name: "empty directory mode change", mutate: async (root) => { await chmod(path.join(root, "sources/current/empty-probe"), 0o700); } },
    { name: "excluded entry addition", mutate: async (root) => { await writeBytes(root, "sources/current/.env-new", Buffer.from("excluded\n"), 0o600); } },
    { name: "excluded entry deletion", mutate: async (root) => { await unlink(path.join(root, "sources/current/.env-baseline")); } },
    { name: "excluded entry bytes change", mutate: async (root) => { await writeFile(path.join(root, "sources/current/.env-baseline"), "changed excluded bytes\n"); } },
    { name: "new symlink", mutate: async (root) => { await symlink("/tmp/not-copi-target", path.join(root, "sources/current/new-link")); } },
    { name: "FIFO", mutate: async (root) => {
      const target = path.join(root, "sources/current/new-fifo");
      const result = spawnSync("mkfifo", [target], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    } },
    { name: "Unix socket", mutate: async (root) => {
      const target = path.join(root, "sources/current/new-socket");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(target, resolve); });
      return async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await unlink(target).catch(() => undefined); };
    } },
    { name: "adopted file replaced by directory", mutate: async (_root, sourcePath) => { await unlink(sourcePath); await mkdir(sourcePath); } },
    { name: "catalog same-byte inode replacement", mutate: async (root) => { await replaceWithSameBytes(path.join(root, "catalog.json")); } },
    { name: "catalog bytes change", mutate: async (root) => { await writeFile(path.join(root, "catalog.json"), "not the switched catalog\\n"); } },
    { name: "missing switched catalog", mutate: async (root) => { await unlink(path.join(root, "catalog.json")); } },
    { name: "PM-specific item subtree addition", mutate: async (root) => { await writeBytes(root, "items/pm-diff/private.json", Buffer.from("PM-owned content\\n"), 0o600); } },
    { name: "old-catalog stage inode replacement", mutate: async (root) => { await replaceWithSameBytes(path.join(root, ".copi-transaction/old-catalog")); } },
    { name: "journal digest mode change", mutate: async (root) => { await chmod(path.join(root, ".copi-transaction/journal.digest"), 0o640); } },
    { name: "backup manifest bytes changed", mutate: async (root) => {
      const parent = path.join(root, ".migration-backups");
      const [name] = await import("node:fs/promises").then(({ readdir }) => readdir(parent));
      await writeFile(path.join(parent, name!, "manifest.json"), Buffer.from("changed manifest\n"));
    } },
    { name: "backup manifest mode changed", mutate: async (root) => {
      const parent = path.join(root, ".migration-backups");
      const [name] = await import("node:fs/promises").then(({ readdir }) => readdir(parent));
      await chmod(path.join(parent, name!, "manifest.json"), 0o640);
    } },
    { name: "backup payload bytes changed", mutate: async (root) => {
      const parent = path.join(root, ".migration-backups");
      const [name] = await import("node:fs/promises").then(({ readdir }) => readdir(parent));
      await writeFile(path.join(parent, name!, "files/items/123e4567-e89b-42d3-a456-426614174000/files/AGENTS.md"), Buffer.from("tampered backup payload\\n"));
    } },
    { name: "backup payload mode changed", mutate: async (root) => {
      const parent = path.join(root, ".migration-backups");
      const [name] = await import("node:fs/promises").then(({ readdir }) => readdir(parent));
      await chmod(path.join(parent, name!, "files/items/123e4567-e89b-42d3-a456-426614174000/files/AGENTS.md"), 0o644);
    } },
    { name: "backup UUID extra child", mutate: async (root) => {
      const parent = path.join(root, ".migration-backups");
      const [name] = await import("node:fs/promises").then(({ readdir }) => readdir(parent));
      await writeBytes(root, `.migration-backups/${name}/unowned-extra`, Buffer.from("unowned\n"), 0o600);
    } },
    { name: "unknown-host migration owner", mutate: async (root) => {
      const ownerPath = path.join(root, ".copi-transaction/owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      owner.host = "independent-probe-unknown-host";
      await writeFile(ownerPath, JSON.stringify(owner));
    } },
    { name: "active migration owner", mutate: async (root) => {
      const ownerPath = path.join(root, ".copi-transaction/owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      owner.host = os.hostname(); owner.pid = process.pid;
      await writeFile(ownerPath, JSON.stringify(owner));
    } },
    { name: "migration owner token mismatch", mutate: async (root) => {
      const ownerPath = path.join(root, ".copi-transaction/owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      owner.token = "123e4567-e89b-42d3-a456-426614174999";
      await writeFile(ownerPath, JSON.stringify(owner));
    } },
    { name: "rollback marker / unknown lock child", mutate: async (root) => { await writeBytes(root, ".copi-transaction/rollback.json", Buffer.from("{}\n"), 0o600); } },
    { name: "missing old catalog stage", mutate: async (root) => { await unlink(path.join(root, ".copi-transaction/old-catalog")); } },
    { name: "ownerless recovery claim", mutate: async (root) => { await mkdir(path.join(root, ".copi-transaction-recovery"), { mode: 0o700 }); } },
    { name: "unknown resolution temp", mutate: async (root) => { await writeBytes(root, ".copi-migration-resolution.unknown.tmp", Buffer.from("partial\n"), 0o600); } },
    { name: "unsupported journal version", mutate: async (root) => { await mutateJournal(root, (journal) => { journal.version = 99; }); } },
    { name: "v5 journal additions are rejected", mutate: async (root) => {
      await mutateJournal(root, (journal) => { journal.operations = [{ itemId: "123e4567-e89b-42d3-a456-426614174111", target: "sources/new", kind: "file", oldTree: null, newTree: "0".repeat(64) }]; });
    } },
    { name: "v4 journal has no resolution baseline", mutate: async (root) => {
      await mutateJournal(root, (journal) => { delete journal.startInventory; journal.version = 4; });
    } },
  ];

  for (const entry of cases) await t.test(entry.name, async () => {
    const box = await fixture();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      crashMigrationAtCatalogSwitch(box.root);
      const afterMutation = await entry.mutate(box.root, box.sourcePath);
      cleanup = typeof afterMutation === "function" ? afterMutation : undefined;
      await assertReadonlyBlocked(box.root, entry.name);
    } finally {
      await cleanup?.();
      await box.dispose();
    }
  });
});

test("cleanup re-edit after journal/owner/lock/claim-owner/claim loss needs a fresh generation and exact secrets", async (t) => {
  for (const actionIndex of [4, 5, 6, 7, 8]) await t.test(`cleanup action ${actionIndex}`, async () => {
    const box = await fixture();
    try {
      crashMigrationAtCatalogSwitch(box.root);
      await writeFile(box.sourcePath, Buffer.from("first reviewed edit\n"));
      await crashResolutionAt(box.root, "after-action-unlink", actionIndex);

      const stalePlan = await prepareMigrationResolution(box.root);
      const staleView = readMigrationResolution(stalePlan);
      assert.equal(staleView.status, "ready", staleView.conflicts.join("; "));
      const recordPath = path.join(box.root, ".copi-migration-resolution.json");
      const predecessorRaw = await readFile(recordPath);
      const predecessorHash = sha256(predecessorRaw);
      const changed = Buffer.from(`apiKey = "${secret1}"\napiKey = "${secret2}"\nfresh editor bytes\n`);
      await writeFile(box.sourcePath, changed);

      const beforeStaleCommit = await treeSnapshot(box.root);
      await assert.rejects(commitMigrationResolution(stalePlan, {
        reviewId: staleView.reviewId, confirmed: true, approvedSensitivePaths: [...staleView.sensitivePaths],
      }), /changed|fresh review|review/i);
      assert.equal(await treeSnapshot(box.root), beforeStaleCommit, "stale generation approval must not write");
      assert.deepEqual(await readFile(box.sourcePath), changed);

      const freshPlan = await prepareMigrationResolution(box.root);
      const freshView = readMigrationResolution(freshPlan);
      assert.equal(freshView.status, "ready", freshView.conflicts.join("; "));
      const sourceSecretPath = "123e4567-e89b-42d3-a456-426614174000/AGENTS.md";
      assert.deepEqual(freshView.sensitivePaths, [sourceSecretPath]);
      await crashResolutionAt(box.root, "after-generation-root-sync");
      const generation = JSON.parse(await readFile(recordPath, "utf8")) as {
        generation: number; predecessorHash: string | null; reviewId: string; sensitivePaths: string[]; confirmed: boolean;
      };
      assert.equal(generation.generation, 2);
      assert.equal(generation.predecessorHash, predecessorHash);
      assert.notEqual(generation.reviewId, staleView.reviewId);
      assert.deepEqual(generation.sensitivePaths, freshView.sensitivePaths);
      assert.equal(generation.confirmed, true);

      const resume = await prepareMigrationResolution(box.root);
      const resumeView = readMigrationResolution(resume);
      assert.equal(resumeView.status, "ready", resumeView.conflicts.join("; "));
      await commitMigrationResolution(resume, {
        reviewId: resumeView.reviewId, confirmed: true, approvedSensitivePaths: [...resumeView.sensitivePaths],
      });

      const finalCatalog = JSON.parse(await readFile(path.join(box.root, "catalog.json"), "utf8")) as { version: number };
      assert.equal(finalCatalog.version, 2);
      assert.deepEqual(await readFile(box.sourcePath), changed);
      await assert.rejects(readFile(recordPath), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(box.root, ".copi-transaction-recovery/owner.json")), { code: "ENOENT" });
    } finally { await box.dispose(); }
  });
});

test("a cleanup artifact that reappears after its completed prefix is rejected without repair", async () => {
  const box = await fixture();
  try {
    crashMigrationAtCatalogSwitch(box.root);
    await crashResolutionAt(box.root, "after-action-progress-root-sync");
    const lock = path.join(box.root, ".copi-transaction");
    const sourceStage = path.join(lock, "old-catalog");
    const completedStage = path.join(lock, "held-catalog");
    await link(sourceStage, completedStage);
    const beforePrepare = await treeSnapshot(box.root);
    const plan = await prepareMigrationResolution(box.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    assert.match(view.conflicts.join("\n"), /reappear|completed|cleanup/i);
    assert.equal(await treeSnapshot(box.root), beforePrepare);
    const record = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
      progress: { completed: number; pending: number | null };
    };
    assert.deepEqual(record.progress, { phase: "artifacts", completed: 1, pending: null });
  } finally { await box.dispose(); }
});

interface ControlledChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: string;
  readonly errors: string;
  waitFor(marker: string, timeoutMs?: number): Promise<void>;
  send(line: string): void;
  terminate(): void;
}
function controlledChild(script: string, root: string): ControlledChild {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: ["pipe", "pipe", "pipe"] });
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
    child,
    get output() { return output; },
    get errors() { return errors; },
    waitFor(marker, timeoutMs = 5_000) {
      if (output.includes(marker)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.marker === marker && waiter.resolve === resolve);
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
function resolverGateScript(): string {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  return `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    resolution.setMigrationResolutionCheckpointForTests(async (point) => {
      if (point === "lease-acquired") {
        process.stdout.write("LEASED\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
      }
    });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigrationResolution(process.argv[1]);
    const view = api.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    process.stdout.write("READY\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdout.write("ATTEMPTING\\n");
    try {
      await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      process.stdout.write("OUTCOME:ok\\n");
    } catch (error) {
      process.stderr.write(String(error) + "\\n");
      process.stdout.write("OUTCOME:error\\n");
    }
  `;
}

test("two independent resolver processes serialize the full mutation path under the root lease", async () => {
  const box = await fixture();
  const children: ControlledChild[] = [];
  try {
    crashMigrationAtCatalogSwitch(box.root);
    const first = controlledChild(resolverGateScript(), box.root);
    const second = controlledChild(resolverGateScript(), box.root);
    children.push(first, second);
    await Promise.all(children.map((child) => child.waitFor("READY")));
    first.send("GO\n"); second.send("GO\n");
    await Promise.all(children.map((child) => child.waitFor("ATTEMPTING")));
    const winner = await Promise.race(children.map(async (child) => { await child.waitFor("LEASED"); return child; }));
    await delay(150);
    assert.equal(children.filter((child) => child.output.includes("LEASED")).length, 1, "only one resolver may enter its mutation lease");
    winner.send("RELEASE\n");
    const loser = winner === first ? second : first;
    await loser.waitFor("LEASED", 6_000);
    await winner.waitFor("OUTCOME:ok", 6_000);
    loser.send("RELEASE\n");
    await loser.waitFor("OUTCOME:error", 6_000);
    const catalog = await (await import("../src/catalog.ts")).loadCatalog(box.root);
    assert.equal(catalog.version, 2);
    for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
      await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(path.join(box.root, internal))), { code: "ENOENT" });
    }
  } finally {
    for (const child of children) child.terminate();
    await box.dispose();
  }
});

test("ordinary catalog reader waits for an active resolver and sees only the completed v2 state", async () => {
  const box = await fixture();
  let resolver: ControlledChild | undefined;
  let reader: ControlledChild | undefined;
  try {
    crashMigrationAtCatalogSwitch(box.root);
    resolver = controlledChild(resolverGateScript(), box.root);
    await resolver.waitFor("READY");
    resolver.send("GO\n");
    await resolver.waitFor("LEASED");
    const catalogUrl = new URL("../src/catalog.js", import.meta.url).href;
    const readerScript = `
      const { loadCatalog } = await import(${JSON.stringify(catalogUrl)});
      const pendingCatalog = loadCatalog(process.argv[1]);
      process.stdout.write("READER_WAITING\\n");
      const catalog = await pendingCatalog;
      process.stdout.write("READER_VERSION:" + catalog.version + "\\n");
    `;
    reader = controlledChild(readerScript, box.root);
    await reader.waitFor("READER_WAITING");
    await delay(150);
    assert.equal(reader.output.includes("READER_VERSION:"), false, "ordinary reader must not enter while resolver owns the root lease");
    resolver.send("RELEASE\n");
    await resolver.waitFor("OUTCOME:ok");
    await reader.waitFor("READER_VERSION:2", 6_000);
    assert.equal(reader.output.includes("READER_VERSION:1"), false);
  } finally {
    resolver?.terminate();
    reader?.terminate();
    await box.dispose();
  }
});

function gatedResolutionScript(point: string, occurrence = 0): string {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  const marker = `PAUSED:${point}:${occurrence}`;
  return `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    let seen = 0;
    resolution.setMigrationResolutionCheckpointForTests(async (at) => {
      if (at === ${JSON.stringify(point)} && seen++ === ${occurrence}) {
        process.stdout.write(${JSON.stringify(marker)} + String.fromCharCode(10));
        await new Promise((resolve) => process.stdin.once("data", resolve));
      }
    });
    const api = await import(${JSON.stringify(migrationUrl)});
    const plan = await api.prepareMigrationResolution(process.argv[1]);
    const view = api.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    process.stdout.write("READY" + String.fromCharCode(10));
    await new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdout.write("ATTEMPTING" + String.fromCharCode(10));
    try {
      await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      process.stdout.write("OUTCOME:ok" + String.fromCharCode(10));
    } catch (error) {
      process.stderr.write(String(error) + String.fromCharCode(10));
      process.stdout.write("OUTCOME:error" + String.fromCharCode(10));
    }
  `;
}

for (const kind of ["B", "C"] as const) test(`${kind} skill edits resume across all actions and representative write/sync boundaries`, async (t) => {
  const actionIndices = Array.from({ length: 9 }, (_, index) => index);
  const cells: Array<{ point: string; occurrence: number; blocked: boolean }> = [
    ...actionIndices.flatMap((occurrence) => [
      { point: "after-action-intent-root-sync", occurrence, blocked: false },
      { point: "after-action-unlink", occurrence, blocked: false },
    ]),
    ...[0, 4, 8].flatMap((occurrence) => [
      "before-action-intent", "after-action-intent-temp-write", "after-action-intent-temp-sync", "after-action-intent-install",
      "before-action-parent-sync", "after-action-parent-sync", "after-action-progress-temp-write", "after-action-progress-temp-sync",
      "after-action-progress-install", "after-action-progress-root-sync",
    ].map((point) => ({ point, occurrence, blocked: ["before-action-intent", "after-action-intent-temp-write", "after-action-intent-temp-sync",
      "after-action-progress-temp-write", "after-action-progress-temp-sync"].includes(point) }))),
  ];
  for (const { point, occurrence, blocked } of cells) await t.test(`${point} action=${occurrence}`, async () => {
    const box = await fixtureForEdit(kind);
    try {
      crashMigrationAtCatalogSwitch(box.root);
      await applyAllowedEdit(box);
      await crashResolutionAt(box.root, point, occurrence);
      const beforePrepare = await treeSnapshot(box.root);
      const plan = await prepareMigrationResolution(box.root);
      const view = readMigrationResolution(plan);
      if (blocked) {
        assert.equal(view.status, "blocked", `${point} action ${occurrence} must preserve a partial record temp`);
        assert.match(view.conflicts.join("; "), /temporary|record/i);
        assert.equal(await treeSnapshot(box.root), beforePrepare, "blocked partial-temp inspection must remain readonly");
        return;
      }
      assert.equal(view.status, "ready", `${point} action ${occurrence}: ${view.conflicts.join("; ")}`);
      assert.equal(await treeSnapshot(box.root), beforePrepare, "readonly resume prepare must preserve every node");
      await commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
      await assertResolutionCompleted(box);
    } finally { await box.dispose(); }
  });
});

for (const kind of ["B", "C"] as const) test(`${kind} cleanup re-edit uses start-inventory classification across a fresh generation`, async () => {
  const box = await fixtureForEdit(kind);
  try {
    crashMigrationAtCatalogSwitch(box.root);
    await applyAllowedEdit(box);
    await crashResolutionAt(box.root, "after-action-unlink", 4);
    const predecessor = await readFile(path.join(box.root, ".copi-migration-resolution.json"));
    let freshBytes: Buffer;
    let freshPath: string;
    if (box.kind === "B") {
      freshPath = path.join(box.root, "sources/skill/new-helper.md");
      freshBytes = Buffer.from(`apiKey = "${secret1}"\nnew generation bytes\n`);
      await writeFile(freshPath, freshBytes);
      await chmod(freshPath, 0o715);
    } else if (box.kind === "C") {
      freshPath = box.skillPath;
      freshBytes = Buffer.from(`apiKey = "${secret2}"\nupdated required skill body\n`);
      await writeFile(freshPath, freshBytes);
    } else assert.fail(`unexpected fixture kind ${box.kind}`);
    const freshPlan = await prepareMigrationResolution(box.root);
    const freshView = readMigrationResolution(freshPlan);
    assert.equal(freshView.status, "ready", freshView.conflicts.join("; "));
    assert.ok(freshView.sensitivePaths.some((entry) => entry.endsWith(box.kind === "B" ? "new-helper.md" : "SKILL.md")));
    await crashResolutionAt(box.root, "after-generation-root-sync");
    const record = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
      generation: number; predecessorHash: string | null; sensitivePaths: string[]; approvedInventory: { nodes: Array<{ path: string; mode: number }> };
    };
    assert.equal(record.generation, 2);
    assert.equal(record.predecessorHash, sha256(predecessor));
    assert.deepEqual(record.sensitivePaths, freshView.sensitivePaths);
    if (box.kind === "B") assert.equal(record.approvedInventory.nodes.find((node) => node.path.endsWith("/new-helper.md"))?.mode, 0o715);
    const resume = await prepareMigrationResolution(box.root);
    const resumeView = readMigrationResolution(resume);
    assert.equal(resumeView.status, "ready", resumeView.conflicts.join("; "));
    await commitMigrationResolution(resume, { reviewId: resumeView.reviewId, confirmed: true, approvedSensitivePaths: [...resumeView.sensitivePaths] });
    assert.deepEqual(await readFile(freshPath), freshBytes);
    if (box.kind === "B") assert.equal((await lstat(freshPath)).mode & 0o777, 0o715);
    else assert.equal((await lstat(freshPath)).mode & 0o777, 0o640);
    assert.equal((await loadCatalog(box.root)).version, 2);
    for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
      await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
    }
  } finally { await box.dispose(); }
});

test("PM-specific baseline payload edits remain blocked and readonly", async () => {
  const box = await fixture();
  try {
    const pmPath = await writeBytes(box.root, "items/pm-specific/private.json", Buffer.from("initial PM bytes\n"), 0o600);
    crashMigrationAtCatalogSwitch(box.root);
    const changed = Buffer.from("changed PM bytes\n");
    await writeFile(pmPath, changed);
    await assertReadonlyBlocked(box.root, "PM-specific payload mutation");
    assert.deepEqual(await readFile(pmPath), changed);
  } finally { await box.dispose(); }
});

for (const mutation of ["active typed claim", "unknown-host typed claim"] as const) test(`${mutation} blocks readonly resolution without rewriting its claim`, async () => {
  const box = await fixture();
  try {
    crashMigrationAtCatalogSwitch(box.root);
    await writeFile(box.sourcePath, Buffer.from("approved edit before record\n"));
    await crashResolutionAt(box.root, "after-record-root-sync");
    const ownerPath = path.join(box.root, ".copi-transaction-recovery/owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    if (mutation === "active typed claim") { owner.host = os.hostname(); owner.pid = process.pid; }
    else owner.host = "independent-probe-unknown-host";
    await writeFile(ownerPath, JSON.stringify(owner));
    await assertReadonlyBlocked(box.root, mutation);
  } finally { await box.dispose(); }
});

test("generation update cannot race a competing resume against the same durable record", async () => {
  const box = await fixture();
  const children: ControlledChild[] = [];
  try {
    crashMigrationAtCatalogSwitch(box.root);
    await writeFile(box.sourcePath, Buffer.from("first reviewed edit\n"));
    await crashResolutionAt(box.root, "after-action-unlink", 4);
    const predecessor = await readFile(path.join(box.root, ".copi-migration-resolution.json"));
    await writeFile(box.sourcePath, Buffer.from(`apiKey = "${secret1}"\nfresh generation bytes\n`));
    const updater = controlledChild(gatedResolutionScript("after-generation-root-sync"), box.root);
    children.push(updater);
    await updater.waitFor("READY");
    updater.send("GO\n");
    await updater.waitFor("ATTEMPTING");
    await updater.waitFor("PAUSED:after-generation-root-sync:0");
    const generation = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
      generation: number; predecessorHash: string | null;
    };
    assert.equal(generation.generation, 2);
    assert.equal(generation.predecessorHash, sha256(predecessor));

    const resume = controlledChild(resolverGateScript(), box.root);
    children.push(resume);
    await resume.waitFor("READY");
    resume.send("GO\n");
    await resume.waitFor("ATTEMPTING");
    await delay(150);
    assert.equal(resume.output.includes("LEASED"), false, "resume must wait while generation update owns the root lease");
    updater.send("RELEASE\n");
    await updater.waitFor("OUTCOME:ok", 6_000);
    await resume.waitFor("LEASED", 6_000);
    resume.send("RELEASE\n");
    await resume.waitFor("OUTCOME:error", 6_000);
    assert.deepEqual(await readFile(box.sourcePath), Buffer.from(`apiKey = "${secret1}"\nfresh generation bytes\n`));
    assert.equal((await loadCatalog(box.root)).version, 2);
    for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
      await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
    }
  } finally {
    for (const child of children) child.terminate();
    await box.dispose();
  }
});

test("new resolver writer cannot enter the lease after claim removal and before record removal", async () => {
  const box = await fixture();
  const children: ControlledChild[] = [];
  try {
    crashMigrationAtCatalogSwitch(box.root);
    await writeFile(box.sourcePath, Buffer.from("source edit before claim window\n"));
    const finalizer = controlledChild(gatedResolutionScript("after-action-unlink", 8), box.root);
    children.push(finalizer);
    await finalizer.waitFor("READY");
    finalizer.send("GO\n");
    await finalizer.waitFor("ATTEMPTING");
    await finalizer.waitFor("PAUSED:after-action-unlink:8");
    await assert.rejects(lstat(path.join(box.root, ".copi-transaction-recovery")), { code: "ENOENT" });
    await lstat(path.join(box.root, ".copi-migration-resolution.json"));

    const competitor = controlledChild(resolverGateScript(), box.root);
    children.push(competitor);
    await competitor.waitFor("READY");
    competitor.send("GO\n");
    await competitor.waitFor("ATTEMPTING");
    await delay(150);
    assert.equal(competitor.output.includes("LEASED"), false, "the root record must remain exclusive after the claim disappears");
    finalizer.send("RELEASE\n");
    await finalizer.waitFor("OUTCOME:ok", 6_000);
    await competitor.waitFor("LEASED", 6_000);
    competitor.send("RELEASE\n");
    await competitor.waitFor("OUTCOME:error", 6_000);
    assert.equal((await loadCatalog(box.root)).version, 2);
    for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
      await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
    }
  } finally {
    for (const child of children) child.terminate();
    await box.dispose();
  }
});
