import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { commitMigration, prepareMigration, readMigration } from "../src/migration.ts";
import { commitMigrationResolution, prepareMigrationResolution, readMigrationResolution } from "../src/migration.ts";
import { loadCatalog } from "../src/catalog.ts";
import { setMigrationResolutionCheckpointForTests } from "../src/migration-resolution.ts";
import { legacyItemId, makeLegacyItem, createLegacyLibrary, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const apiKey = "SYNTHETIC_RESOLUTION_SECRET_914725";
const removedSecret = "SYNTHETIC_REMOVED_SKILL_SECRET_731846";

async function createFileFixture() {
  const fixture = await createLegacyLibrary();
  const sourceBytes = Buffer.from(`apiKey = \"${apiKey}\"\noriginal included source\n`);
  const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", sourceBytes, 0o640);
  await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(fixture.root);
  return { ...fixture, sourcePath, sourceBytes };
}

async function createSkillFixture(includeExcluded = false) {
  const fixture = await createLegacyLibrary();
  const skillRoot = path.join(fixture.root, "sources", legacyItemId);
  const skill = Buffer.from("# Safe test skill\\n");
  const removable = Buffer.from(`password = \"${removedSecret}\"\\ncopied helper remains registered until deliberately removed\\n`);
  await writeBytes(fixture.root, `sources/${legacyItemId}/SKILL.md`, skill, 0o644);
  await writeBytes(fixture.root, `sources/${legacyItemId}/remove-me.md`, removable, 0o600);
  const excludedBytes = Buffer.from("excluded content must never be displayed\\n");
  if (includeExcluded) await writeBytes(fixture.root, `sources/${legacyItemId}/.env-test`, excludedBytes, 0o600);
  const item = makeLegacyItem({ kind: "skill", sourcePath: skillRoot, files: [
    { path: "SKILL.md", mode: 0o644, sha256: digest(skill) },
    { path: "remove-me.md", mode: 0o600, sha256: digest(removable) },
  ] });
  await writeLegacyCatalog(fixture.root, [item]);
  await writeLegacySnapshot(fixture.root, skill, `items/${legacyItemId}/files/SKILL.md`, 0o644);
  await writeLegacySnapshot(fixture.root, removable, `items/${legacyItemId}/files/remove-me.md`, 0o600);
  return { ...fixture, skillRoot, skill, removable, excludedBytes, excludedPath: path.join(skillRoot, ".env-test") };
}

function killOnCatalogSwitch(root: string): void {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const script = `
    const { StorageTransactions, storageTransactions } = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation, { requiresNativePlacement: false }) });
    const { prepareMigration, readMigration, commitMigration } = await import(${JSON.stringify(migrationUrl)});
    const plan = await prepareMigration(process.argv[1]);
    const view = readMigration(plan);
    if (view.status !== "ready") throw new Error("migration fixture was not ready: " + JSON.stringify(view.conflicts));
    await commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

async function interruptFirstResolutionRemoval(root: string): Promise<void> {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const resolutionUrl = new URL("../src/migration-resolution.js", import.meta.url).href;
  const script = `
    const resolution = await import(${JSON.stringify(resolutionUrl)});
    resolution.setMigrationResolutionCheckpointForTests((point) => { if (point === "after-action-unlink") process.kill(process.pid, "SIGKILL"); });
    const migration = await import(${JSON.stringify(migrationUrl)});
    const plan = await migration.prepareMigrationResolution(process.argv[1]);
    const view = migration.readMigrationResolution(plan);
    await migration.commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

test("migration module exposes the dedicated resolution review and commit API", async () => {
  const migration = await import("../src/migration.ts") as unknown as Record<string, unknown>;
  assert.equal(typeof migration.prepareMigrationResolution, "function");
  assert.equal(typeof migration.readMigrationResolution, "function");
  assert.equal(typeof migration.commitMigrationResolution, "function");
});

test("a missing library reports not-needed without creating it", async () => {
  const fixture = await createLegacyLibrary();
  const root = path.join(fixture.root, "not-created");
  try {
    const plan = await prepareMigrationResolution(root);
    assert.equal(readMigrationResolution(plan).status, "not-needed");
    await assert.rejects(lstat(root), { code: "ENOENT" });
    await assert.rejects(commitMigrationResolution(plan, { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [] }), /not-needed/i);
    await assert.rejects(lstat(root), { code: "ENOENT" });
  } finally { await fixture.dispose(); }
});

test("post-switch included source edits require exact secret approval and cleanup only owned protocol artifacts", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const edited = Buffer.from(`apiKey = \"${apiKey}ROTATED\"\nuser edit retained\n`);
    await writeFile(fixture.sourcePath, edited);
    const beforeCatalog = await readFile(path.join(fixture.root, "catalog.json"));
    const beforeReview = await treeSnapshot(fixture.root);
    const review = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(review);
    assert.equal(await treeSnapshot(fixture.root), beforeReview, "prepare/read must be strictly read-only");
    assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
    assert.equal(view.backupDir, `.migration-backups/${(await readdir(path.join(fixture.root, ".migration-backups")))[0]}`);
    assert.ok(view.sensitivePaths.includes(`${legacyItemId}/AGENTS.md`));
    assert.ok(view.maskedDiffs.some(({ path: filePath }) => filePath === `${legacyItemId}/AGENTS.md`));
    assert.equal(JSON.stringify(view).includes(apiKey), false);
    assert.equal(JSON.stringify(view).includes("ROTATED"), false);

    const withoutSecret = { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [] };
    await assert.rejects(commitMigrationResolution(review, withoutSecret), /sensitive|individual approval/i);
    assert.ok((await readdir(fixture.root)).includes(".copi-transaction"));
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));

    const freshReview = await prepareMigrationResolution(fixture.root);
    const freshView = readMigrationResolution(freshReview);
    assert.equal(freshView.status, "ready");
    const accepted = await commitMigrationResolution(freshReview, {
      reviewId: freshView.reviewId, confirmed: true, approvedSensitivePaths: [...freshView.sensitivePaths],
    });
    assert.equal(accepted.catalogVersion, 2);
    assert.equal(accepted.backupDir, freshView.backupDir);
    assert.deepEqual(await readFile(fixture.sourcePath), edited);
    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), beforeCatalog);
    for (const internal of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
      await assert.rejects(lstat(path.join(fixture.root, internal)), { code: "ENOENT" });
    }
    const migrated = await loadCatalog(fixture.root);
    assert.equal(migrated.version, 2);
    if (migrated.version !== 2) throw new Error("Resolution fixture did not keep the switched catalog.");
    assert.deepEqual(migrated.items[0]?.content, { kind: "file", path: "sources/current/AGENTS.md" });
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
  } finally {
    setMigrationResolutionCheckpointForTests(undefined);
    await fixture.dispose();
  }
});

test("same-byte editor inode replacement is reviewed without exposing the source body", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const replacementPath = await writeBytes(fixture.root, "sources/current/.replacement", fixture.sourceBytes, 0o640);
    await rename(replacementPath, fixture.sourcePath);
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
    const diff = view.maskedDiffs.find(({ path: filePath }) => filePath === `${legacyItemId}/AGENTS.md`);
    assert.ok(diff);
    assert.match(diff.summary, /identity changed while its bytes remained identical/i);
    assert.equal(JSON.stringify(view).includes(apiKey), false);
    await commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    assert.deepEqual(await readFile(fixture.sourcePath), fixture.sourceBytes);
  } finally { await fixture.dispose(); }
});

for (const edit of ["add included skill file", "delete included skill file"] as const) test(`post-switch skill ${edit} is eligible without chmod or SKILL.md loss`, async () => {
  const fixture = await createSkillFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const addedPath = path.join(fixture.skillRoot, "new-helper.md");
    const removedPath = path.join(fixture.skillRoot, "remove-me.md");
    if (edit === "add included skill file") await writeBytes(fixture.root, `sources/${legacyItemId}/new-helper.md`, Buffer.from("new included skill helper\\n"), 0o751);
    else await unlink(removedPath);

    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
    const expectedDiffPath = `${legacyItemId}/${edit === "add included skill file" ? "new-helper.md" : "remove-me.md"}`;
    assert.ok(view.maskedDiffs.some(({ path: filePath }) => filePath === expectedDiffPath));
    if (edit === "delete included skill file") assert.ok(view.sensitivePaths.includes(`${legacyItemId}/remove-me.md`));
    assert.equal(JSON.stringify(view).includes(removedSecret), false);
    await commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });

    if (edit === "add included skill file") {
      assert.deepEqual(await readFile(addedPath), Buffer.from("new included skill helper\\n"));
      assert.equal((await lstat(addedPath)).mode & 0o777, 0o751);
    } else await assert.rejects(lstat(removedPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(path.join(fixture.skillRoot, "SKILL.md")), fixture.skill);
    assert.equal((await loadCatalog(fixture.root)).version, 2);
  } finally { await fixture.dispose(); }
});

for (const mutation of ["existing included mode change", "missing SKILL.md", "excluded subtree edit"] as const) test(`post-switch ${mutation} is held without mutating protocol state`, async () => {
  const fixture = await createSkillFixture(mutation === "excluded subtree edit");
  try {
    killOnCatalogSwitch(fixture.root);
    if (mutation === "existing included mode change") await chmod(path.join(fixture.skillRoot, "remove-me.md"), 0o644);
    else if (mutation === "missing SKILL.md") await unlink(path.join(fixture.skillRoot, "SKILL.md"));
    else await writeFile(fixture.excludedPath, Buffer.from("changed excluded bytes\\n"));
    const beforePrepare = await treeSnapshot(fixture.root);
    const catalog = await readFile(path.join(fixture.root, "catalog.json"));
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    await assert.rejects(commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /blocked/i);
    assert.equal(await treeSnapshot(fixture.root), beforePrepare);
    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), catalog);
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
    assert.equal(JSON.stringify(view).includes("excluded content must never be displayed"), false);
  } finally { await fixture.dispose(); }
});

test("an unowned backup sibling is not projected away or deleted", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const sibling = ".migration-backups/123e4567-e89b-42d3-a456-426614174111/unowned.bin";
    const bytes = Buffer.from("unowned backup sibling remains visible to inventory");
    await writeBytes(fixture.root, sibling, bytes, 0o600);
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    assert.deepEqual(await readFile(path.join(fixture.root, sibling)), bytes);
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
  } finally { await fixture.dispose(); }
});

test("an editor change after prepare consumes the review but writes no claim or record", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    await writeFile(fixture.sourcePath, Buffer.from("approved source before race\\n"));
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "ready");
    const winner = Buffer.from("external editor won after review\\n");
    await writeFile(fixture.sourcePath, winner);
    const beforeCommit = await treeSnapshot(fixture.root);
    await assert.rejects(commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] }), /changed|fresh review|review/i);
    assert.equal(await treeSnapshot(fixture.root), beforeCommit);
    assert.deepEqual(await readFile(fixture.sourcePath), winner);
    await assert.rejects(lstat(path.join(fixture.root, ".copi-transaction-recovery")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(fixture.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
  } finally { await fixture.dispose(); }
});

test("v4 recovery journals remain baseline-insufficient for resolution", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const journalPath = path.join(fixture.root, ".copi-transaction", "journal.json");
    const value = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    delete value.startInventory;
    value.version = 4;
    const raw = Buffer.from(JSON.stringify(value));
    await writeFile(journalPath, raw);
    await writeFile(path.join(fixture.root, ".copi-transaction", "journal.digest"), digest(raw));
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    assert.match(view.conflicts.join("\\n"), /v5|inventory|baseline/i);
    await assert.rejects(commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [] }), /blocked/i);
    assert.deepEqual(await readFile(journalPath), raw);
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
    assert.ok((await readdir(fixture.root)).includes(".copi-transaction"));
  } finally { await fixture.dispose(); }
});

test("unregistered root edits block without changing the switched catalog or preserving lock artifacts", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    const outsider = Buffer.from("outside the reviewed sources");
    await writeBytes(fixture.root, "unregistered-root.bin", outsider, 0o600);
    const catalog = await readFile(path.join(fixture.root, "catalog.json"));
    const plan = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(plan);
    assert.equal(view.status, "blocked");
    await assert.rejects(commitMigrationResolution(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [] }), /blocked/i);
    assert.deepEqual(await readFile(path.join(fixture.root, "catalog.json")), catalog);
    assert.deepEqual(await readFile(path.join(fixture.root, "unregistered-root.bin")), outsider);
    assert.ok((await readdir(path.join(fixture.root, ".copi-transaction"))).includes("journal.json"));
    assert.ok((await readdir(fixture.root)).includes(".migration-backups"));
  } finally { await fixture.dispose(); }
});

test("a pending unlink after SIGKILL resumes the recorded fixed state without replaying approval", async () => {
  const fixture = await createFileFixture();
  try {
    killOnCatalogSwitch(fixture.root);
    await writeFile(fixture.sourcePath, Buffer.from("first approved-resolution edit\n"));
    await interruptFirstResolutionRemoval(fixture.root);
    assert.equal(await lstat(path.join(fixture.root, ".copi-transaction", "held-catalog")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
    const review = await prepareMigrationResolution(fixture.root);
    const view = readMigrationResolution(review);
    assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
    await commitMigrationResolution(review, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    assert.deepEqual(await readFile(fixture.sourcePath), Buffer.from("first approved-resolution edit\n"));
    await assert.rejects(lstat(path.join(fixture.root, ".copi-migration-resolution.json")), { code: "ENOENT" });
    assert.equal((await loadCatalog(fixture.root)).version, 2);
  } finally {
    setMigrationResolutionCheckpointForTests(undefined);
    await fixture.dispose();
  }
});
