import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { makeLegacyItem, createLegacyLibrary, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const secret = "SYNTHETIC_NEW_GENERATION_SECRET_384915";
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const box = await createLegacyLibrary();
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", Buffer.from("original approved source\n"), 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

function childAt(root: string, script: string): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root], { stdio: "pipe" });
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let killed = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Timed out waiting for resolution checkpoint: ${output} ${errors}`)); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!killed && output.includes("R4_RESOLUTION_CHECKPOINT\n")) { killed = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (_code, signal) => {
      clearTimeout(timeout);
      if (!output.includes("R4_RESOLUTION_CHECKPOINT\n")) reject(new Error(`Child exited before checkpoint (${signal ?? "no signal"}): ${output} ${errors}`));
      else if (signal !== "SIGKILL") reject(new Error(`Expected parent-issued SIGKILL, got ${signal ?? "no signal"}: ${errors}`));
      else resolve();
    });
  });
}
function urls() {
  return {
    migration: new URL("../src/migration.js", import.meta.url).href,
    resolution: new URL("../src/migration-resolution.js", import.meta.url).href,
  };
}
async function interruptResolutionAt(root: string, point: string, occurrence: number): Promise<void> {
  const { migration, resolution } = urls();
  const script = `
    const resolution = await import(${JSON.stringify(resolution)});
    let seen = 0;
    resolution.setMigrationResolutionCheckpointForTests(async (at) => {
      if (at === ${JSON.stringify(point)} && seen++ === ${occurrence}) {
        process.stdout.write("R4_RESOLUTION_CHECKPOINT\\n");
        await new Promise(() => {});
      }
    });
    const migration = await import(${JSON.stringify(migration)});
    const plan = await migration.prepareMigrationResolution(process.argv[1]);
    const view = migration.readMigrationResolution(plan);
    if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
    await migration.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  await childAt(root, script);
}
async function interruptMigration(root: string): Promise<void> {
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const migrationUrl = urls().migration;
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
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

for (const [point, label] of [
  ["after-claim-root-sync", "claim installed without a completed record"],
  ["after-record-root-sync", "durable record installed before cleanup"],
] as const) test(`${label} has the specified crash boundary`, async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    const { migration, resolution } = urls();
    const setup = `
      const resolution = await import(${JSON.stringify(resolution)});
      resolution.setMigrationResolutionCheckpointForTests(async (at) => {
        if (at === ${JSON.stringify(point)}) {
          process.stdout.write("R4_RESOLUTION_CHECKPOINT\\n");
          await new Promise(() => {});
        }
      });
      const migration = await import(${JSON.stringify(migration)});
    `;
    const operation = `
      const plan = await migration.prepareMigrationResolution(process.argv[1]);
      const view = migration.readMigrationResolution(plan);
      if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
      await migration.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    `;
    await childAt(box.root, `${setup}\n${operation}`);

    if (point === "after-claim-root-sync") {
      const viewPlan = await (await import("../src/migration.ts")).prepareMigrationResolution(box.root);
      const view = (await import("../src/migration.ts")).readMigrationResolution(viewPlan);
      assert.equal(view.status, "blocked");
      assert.match(view.conflicts.join("\n"), /claim|record/i);
      assert.equal((await readdir(path.join(box.root, ".copi-transaction-recovery"))).join("|"), "owner.json");
      await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
      await assert.rejects(loadCatalog(box.root), /claim|temporary|record/i);
      assert.ok((await readdir(path.join(box.root, ".copi-transaction"))).includes("journal.json"));
    } else {
      const record = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as { generation: number; progress: { completed: number; pending: number | null } };
      assert.equal(record.generation, 1);
      assert.deepEqual(record.progress, { phase: "artifacts", completed: 0, pending: null });
      const catalog = await loadCatalog(box.root);
      assert.equal(catalog.version, 2);
      for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
        await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
      }
    }
  } finally { await box.dispose(); }
});

test("all nine write-ahead action intents and unlinks resume only their recorded prefix", async () => {
  for (const checkpoint of ["after-action-intent-root-sync", "after-action-unlink"] as const) {
    for (let action = 0; action < 9; action += 1) {
      const box = await fixture();
      try {
        await interruptMigration(box.root);
        await interruptResolutionAt(box.root, checkpoint, action);
        const stored = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
          progress: { completed: number; pending: number | null };
        };
        assert.deepEqual(stored.progress, { phase: action <= 2 ? "artifacts" : action <= 4 ? "journal" : action === 5 ? "owner" : action === 6 ? "lock" : action === 7 ? "claim-owner" : "claim", completed: action, pending: action });
        const api = await import("../src/migration.ts");
        const plan = await api.prepareMigrationResolution(box.root);
        const view = api.readMigrationResolution(plan);
        assert.equal(view.status, "ready", `${checkpoint} action ${action}: ${view.conflicts.join("; ")}`);
        await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
        assert.equal((await loadCatalog(box.root)).version, 2);
        for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
          await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
        }
      } finally { await box.dispose(); }
    }
  }
});

for (const point of ["lease-acquired", "before-claim-mkdir"] as const) test(`${point} SIGKILL leaves no library-side resolution artifact`, async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    await interruptResolutionAt(box.root, point, 0);
    await assert.rejects(lstat(path.join(box.root, ".copi-transaction-recovery")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    const api = await import("../src/migration.ts");
    const plan = await api.prepareMigrationResolution(box.root);
    const view = api.readMigrationResolution(plan);
    assert.equal(view.status, "ready");
    await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  } finally { await box.dispose(); }
});

for (const point of ["after-claim-mkdir", "after-claim-owner-temp-write", "after-claim-owner-temp-sync", "after-claim-owner-install",
  "after-claim-directory-sync", "after-claim-temp-unlink", "after-claim-root-sync"] as const) test(`${point} SIGKILL preserves a pre-record claim and blocks adoption`, async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    await interruptResolutionAt(box.root, point, 0);
    await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    const claimDirectory = await lstat(path.join(box.root, ".copi-transaction-recovery"));
    assert.ok(claimDirectory.isDirectory());
    const claimNames = await readdir(path.join(box.root, ".copi-transaction-recovery"));
    const api = await import("../src/migration.ts");
    const plan = await api.prepareMigrationResolution(box.root);
    const view = api.readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    await assert.rejects(api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /blocked/i);
    assert.deepEqual(await readdir(path.join(box.root, ".copi-transaction-recovery")), claimNames);
    assert.ok((await readdir(path.join(box.root, ".copi-transaction"))).includes("journal.json"));
  } finally { await box.dispose(); }
});

for (const [point, status] of [
  ["before-record-temp-write", "blocked"], ["after-record-temp-write", "blocked"], ["after-record-temp-sync", "blocked"],
  ["after-record-install", "ready"], ["after-record-root-sync", "ready"], ["after-record-temp-unlink", "ready"], ["after-record-temp-root-sync", "ready"],
  ["before-action-intent", "blocked"], ["after-action-intent-temp-write", "blocked"], ["after-action-intent-temp-sync", "blocked"],
  ["after-action-intent-install", "ready"], ["after-action-intent-root-sync", "ready"],
  ["after-action-progress-temp-write", "blocked"], ["after-action-progress-temp-sync", "blocked"],
  ["after-action-progress-install", "ready"], ["after-action-progress-root-sync", "ready"],
  ["before-action-parent-sync", "ready"], ["after-action-parent-sync", "ready"],
  ["after-terminal-update", "ready"], ["before-record-unlink", "ready"],
  ["after-record-unlink", "not-needed"], ["after-record-unlink-root-sync", "not-needed"],
] as const) test(`${point} SIGKILL preserves the old or installed complete record as appropriate`, async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    await interruptResolutionAt(box.root, point, 0);
    const api = await import("../src/migration.ts");
    const plan = await api.prepareMigrationResolution(box.root);
    const view = api.readMigrationResolution(plan);
    assert.equal(view.status, status, JSON.stringify(view.conflicts));
    if (status === "ready") {
      await api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    } else if (status === "blocked") {
      await assert.rejects(api.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /blocked/i);
      assert.ok((await readdir(path.join(box.root, ".copi-transaction"))).includes("journal.json"));
    }
    if (status === "blocked") await assert.rejects(loadCatalog(box.root), /claim|temporary|record/i);
    else assert.equal((await loadCatalog(box.root)).version, 2);
    if (status !== "blocked") {
      for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
        await assert.rejects(lstat(path.join(box.root, internal)), { code: "ENOENT" });
      }
    }
  } finally { await box.dispose(); }
});

test("unknown record fields are preserved and block both explicit resolution and ordinary writers", async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    await interruptResolutionAt(box.root, "after-record-root-sync", 0);
    const recordPath = path.join(box.root, ".copi-migration-resolution.json");
    const changed = { ...JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>, unexpected: true };
    const raw = Buffer.from(JSON.stringify(changed));
    await writeFile(recordPath, raw);
    const plan = await (await import("../src/migration.ts")).prepareMigrationResolution(box.root);
    const view = (await import("../src/migration.ts")).readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    assert.match(view.conflicts.join("\\n"), /exact keys|record|malformed/i);
    await assert.rejects(loadCatalog(box.root), /exact keys|record|malformed/i);
    assert.deepEqual(await readFile(recordPath), raw);
    assert.ok((await readdir(path.join(box.root, ".copi-transaction"))).includes("journal.json"));
  } finally { await box.dispose(); }
});

test("cleanup re-edit requires a fresh generation and predecessor hash; old approval cannot replay", async () => {
  const box = await fixture();
  try {
    await interruptMigration(box.root);
    const { migration, resolution } = urls();
    const firstScript = `
      const resolution = await import(${JSON.stringify(resolution)});
      resolution.setMigrationResolutionCheckpointForTests(async (at) => {
        if (at === "after-action-unlink") { process.stdout.write("R4_RESOLUTION_CHECKPOINT\\n"); await new Promise(() => {}); }
      });
      const migration = await import(${JSON.stringify(migration)});
      const plan = await migration.prepareMigrationResolution(process.argv[1]);
      const view = migration.readMigrationResolution(plan);
      await migration.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    `;
    await childAt(box.root, firstScript);
    const initialRaw = await readFile(path.join(box.root, ".copi-migration-resolution.json"));
    const priorHash = sha256(initialRaw);
    const priorPlan = await (await import("../src/migration.ts")).prepareMigrationResolution(box.root);
    const priorView = (await import("../src/migration.ts")).readMigrationResolution(priorPlan);
    assert.deepEqual(priorView.sensitivePaths, []);

    const replacement = Buffer.from(`apiKey = \"${secret}\"\nre-edited after cleanup began\n`);
    await writeFile(box.sourcePath, replacement);
    const stalePlan = await (await import("../src/migration.ts")).prepareMigrationResolution(box.root);
    const staleView = (await import("../src/migration.ts")).readMigrationResolution(stalePlan);
    assert.equal(staleView.status, "ready", JSON.stringify(staleView.conflicts));
    assert.ok(staleView.sensitivePaths.includes(`${makeLegacyItem().id}/AGENTS.md`));
    await assert.rejects((await import("../src/migration.ts")).commitMigrationResolution(stalePlan, {
      reviewId: priorView.reviewId, confirmed: true, approvedSensitivePaths: [...priorView.sensitivePaths],
    }), /review|approval/i);
    assert.deepEqual(await readFile(path.join(box.root, ".copi-migration-resolution.json")), initialRaw);

    const generationScript = `
      const resolution = await import(${JSON.stringify(resolution)});
      resolution.setMigrationResolutionCheckpointForTests(async (at) => {
        if (at === "after-generation-root-sync") { process.stdout.write("R4_RESOLUTION_CHECKPOINT\\n"); await new Promise(() => {}); }
      });
      const migration = await import(${JSON.stringify(migration)});
      const plan = await migration.prepareMigrationResolution(process.argv[1]);
      const view = migration.readMigrationResolution(plan);
      if (view.status !== "ready") throw new Error(JSON.stringify(view.conflicts));
      await migration.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    `;
    await childAt(box.root, generationScript);
    const generation = JSON.parse(await readFile(path.join(box.root, ".copi-migration-resolution.json"), "utf8")) as {
      generation: number; predecessorHash: string | null; progress: { completed: number; pending: number | null };
    };
    assert.equal(generation.generation, 2);
    assert.equal(generation.predecessorHash, priorHash);
    assert.deepEqual(generation.progress, { phase: "artifacts", completed: 0, pending: 0 });

    const resume = await (await import("../src/migration.ts")).prepareMigrationResolution(box.root);
    const resumeView = (await import("../src/migration.ts")).readMigrationResolution(resume);
    await (await import("../src/migration.ts")).commitMigrationResolution(resume, {
      reviewId: resumeView.reviewId, confirmed: true, approvedSensitivePaths: [...resumeView.sensitivePaths],
    });
    assert.deepEqual(await readFile(box.sourcePath), replacement);
    await assert.rejects(lstat(path.join(box.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    assert.equal((await loadCatalog(box.root)).version, 2);
  } finally { await box.dispose(); }
});
