import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPreparedResource, importResource, loadCatalog, prepareResource, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { sandbox } from "./helpers/sandbox.ts";
import type { ResourceCandidate } from "../src/types.ts";
import { changeSavedDestination, commitSavedChange, prepareSavedChange, prepareSavedEdit, prepareSavedReplacement, readSavedChange, readSavedEdit, type PreparedSavedChange } from "../src/resource-mutations.ts";
import { executeApply, planApply } from "../src/apply.ts";

async function fixture(t: test.TestContext, content: string | Buffer = "old\r\n日本語\n") {
  const box = await sandbox(t);
  const sourcePath = path.join(box.sourceRoot, "skill");
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, "SKILL.md"), content);
  const candidate: ResourceCandidate = { id: "fixture", kind: "skill", source: "test", scope: "project", sourceRoot: box.sourceRoot, sourcePath, name: "Original", destination: { kind: "project", path: ".pi/skills/original" } };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(box.libraryDir, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  return { ...box, item, candidate, prepared, inspection, file: path.join(box.libraryDir, "items", item.id, "files", "SKILL.md") };
}

// RED on the real pre-existing API: dropping inspection must not bypass secret approval.
test("S5 old import API refuses unreviewed secrets and arrays without a prepared inspection", async (t) => {
  const box = await fixture(t, "apiKey=sk_live_fixedsecret123456");
  const destination = path.join(box.root, "new-library");
  await assert.rejects(importResource(destination, box.candidate, { confirmed: true, groupIds: [] }), /inspection|approval|sensitive/i);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("S5 forged empty inspection cannot override internally detected sensitive paths", async (t) => {
  const box = await fixture(t, "apiKey=sk_live_fixedsecret123456");
  const destination = path.join(box.root, "new-library");
  await assert.rejects(importPreparedResource(destination, box.prepared, { confirmed: true, groupIds: [], inspection: { ...box.inspection, sensitivePaths: [], warnings: [] }, approvedSensitivePaths: [] }), /inspection|approval|sensitive/i);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("S1–S6 saved-edit backend is available", async () => {
  const module = await import("../src/" + "resource-mutations.js").catch(() => undefined) as Record<string, unknown> | undefined;
  assert.equal(typeof module?.prepareSavedEdit, "function", "saved-copy mutation preparation is missing");
});

function approve(change: PreparedSavedChange) { return { confirmed: true, reviewId: change.reviewId, approvedSensitivePaths: readSavedChange(change).sensitivePaths }; }

// A wrong hash, newline normalization, or caller-mutated Buffer must fail this test.
test("S1 fixed UTF-8 bytes including BOM, decomposed Unicode and line endings survive commit/reload without source", async (t) => {
  const box = await fixture(t);
  const before = await loadCatalog(box.libraryDir);
  before.groups.push({ id: "team", name: "Team", itemIds: [box.item.id] });
  await saveCatalog(box.libraryDir, before);
  await rm(box.item.sourcePath, { recursive: true });
  const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
  readSavedEdit(edit).file.bytes.fill(0);
  const bytes = Buffer.from("\ufeffe\u0301\r\n日本語\r\n");
  const expected = Buffer.from(bytes);
  const change = await prepareSavedChange(edit, bytes);
  bytes.fill(0);
  const saved = await commitSavedChange(change, approve(change));
  assert.deepEqual(await readFile(box.file), expected);
  assert.equal(saved.files[0]!.sha256, createHash("sha256").update(expected).digest("hex"));
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, saved))[0]!.bytes, expected);
  assert.deepEqual(saved.destination, box.item.destination);
  assert.equal(saved.name, box.item.name);
  assert.equal(saved.id, box.item.id);
  assert.deepEqual((await loadCatalog(box.libraryDir)).groups, before.groups);
  console.log(`S1 bytes hex=${expected.toString("hex")} SHA256=${saved.files[0]!.sha256}`);
});

test("S2/S5 cancellation, wrong reviewId, original-only approval and forged token write nothing", async (t) => {
  const box = await fixture(t);
  const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const bytes = await readFile(box.file);
  const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
  const change = await prepareSavedChange(edit, Buffer.from("apiKey=sk_live_newsecret123456\n"));
  assert.deepEqual(readSavedChange(change).sensitivePaths, ["SKILL.md"]);
  await assert.rejects(commitSavedChange(change, { ...approve(change), confirmed: false }), /confirm|cancel/i);
  await assert.rejects(commitSavedChange(change, { ...approve(change), reviewId: "another-review" }), /review/i);
  await assert.rejects(commitSavedChange(change, { ...approve(change), approvedSensitivePaths: [] }), /approval/i);
  await assert.rejects(commitSavedChange({ reviewId: change.reviewId } as PreparedSavedChange, approve(change)), /prepared|token/i);
  assert.deepEqual(await readFile(box.file), bytes);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
  await commitSavedChange(change, approve(change));
  assert.equal(await readFile(box.file, "utf8"), "apiKey=sk_live_newsecret123456\n");
});

test("S5 full masked diff reports bytes changed even when both secrets mask identically", async (t) => {
  const box = await fixture(t, "apiKey=sk_live_oldsecret123456\n");
  const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
  const change = await prepareSavedChange(edit, Buffer.from("apiKey=sk_live_newsecret123456\n"));
  const view = readSavedChange(change);
  assert.equal(view.bytesChanged, true);
  assert.equal(view.diffs[0]!.bytesChanged, true);
  assert.match(view.diffs[0]!.summary, /bytes changed/i);
  assert.ok(!JSON.stringify(view).includes("sk_live_oldsecret123456"));
  assert.ok(!JSON.stringify(view).includes("sk_live_newsecret123456"));
  (view.item.files[0]!).sha256 = "0".repeat(64);
  await commitSavedChange(change, approve(change));
  assert.equal(await readFile(box.file, "utf8"), "apiKey=sk_live_newsecret123456\n");
});

for (const mutation of ["raw catalog", "body", "other item", "group"] as const) {
  test(`S3 edit detects ${mutation} changes after editing starts without rolling back external bytes`, async (t) => {
    const box = await fixture(t);
    const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
    const change = await prepareSavedChange(edit, Buffer.from("proposed\n"));
    if (mutation === "body") await writeFile(box.file, "manual external bytes\n");
    else if (mutation === "raw catalog") await writeFile(path.join(box.libraryDir, "catalog.json"), ` ${await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")}`);
    else if (mutation === "group") {
      const catalog = await loadCatalog(box.libraryDir);
      catalog.groups.push({ id: "new-group", name: "New group", itemIds: [] });
      await saveCatalog(box.libraryDir, catalog);
    } else await importResource(box.libraryDir, { ...box.candidate, name: "Other" }, { confirmed: true, groupIds: [] });
    const bytes = await readFile(box.file);
    const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    await assert.rejects(commitSavedChange(change, approve(change)), /changed|checksum|revision/i);
    assert.deepEqual(await readFile(box.file), bytes);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
    console.log(`S3 ${mutation}: preserved file=${bytes.toString("hex")}`);
  });
}

test("S1 no-op leaves raw catalog unchanged but still requires current sensitive approval", async (t) => {
  const box = await fixture(t, "apiKey=sk_live_fixedsecret123456\r\n");
  const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
  const change = await prepareSavedChange(edit, readSavedEdit(edit).file.bytes);
  assert.equal(readSavedChange(change).bytesChanged, false);
  await assert.rejects(commitSavedChange(change, { ...approve(change), approvedSensitivePaths: [] }), /approval/i);
  await commitSavedChange(change, approve(change));
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
});

for (const destination of ["/absolute", "../outside", ".pi/../outside", "a\\b", "a//b", "auth/token", ".envrc", ".pi/.env-production", "cache/x", ".npm/x", "a\0b"]) {
  test(`S4 refuses unsafe/private destination ${JSON.stringify(destination)}`, async (t) => {
    const box = await fixture(t);
    const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    await assert.rejects(changeSavedDestination(box.libraryDir, box.item.id, { kind: "project", path: destination }), /unsafe|private|excluded|destination/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
  });
}

test("S4 destination-only change preserves ID/name/body/groups and cannot promote reference-only resources", async (t) => {
  const box = await fixture(t);
  const bytes = await readFile(box.file);
  const changed = await changeSavedDestination(box.libraryDir, box.item.id, { kind: "project", path: ".pi/skills/new-place" });
  assert.deepEqual(changed, { ...box.item, destination: { kind: "project", path: ".pi/skills/new-place" } });
  assert.deepEqual(await readFile(box.file), bytes);
  await changeSavedDestination(box.libraryDir, box.item.id, { kind: "global-only" });
  await assert.rejects(changeSavedDestination(box.libraryDir, box.item.id, { kind: "project", path: ".pi/models.json" }), /reference|global-only/i);
});

for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 65, 0]), Buffer.alloc(1_000_001, 65)]) {
  test(`S1 refuses noneditable input ${bytes.length} bytes/${bytes[0]}`, async (t) => {
    const box = await fixture(t);
    const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
    await assert.rejects(prepareSavedChange(edit, bytes), /UTF-8|binary|NUL|1 MB|1_000_000|limit/i);
  });
}

test("S1 accepts empty text and exactly 1_000_000 bytes; rejects unregistered/traversal file edits", async (t) => {
  const box = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1_000_000, 65)]) {
    const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
    const change = await prepareSavedChange(edit, bytes);
    await commitSavedChange(change, approve(change));
    assert.deepEqual(await readFile(box.file), bytes);
  }
  for (const file of ["new.md", "../SKILL.md", "/SKILL.md", "x\\SKILL.md"]) await assert.rejects(prepareSavedEdit(box.libraryDir, box.item.id, file), /registered|unknown|unsafe|path/i);
});

for (const corruption of ["checksum", "file symlink", "directory symlink"] as const) {
  test(`S6 refuses ${corruption} rather than repairing it`, async (t) => {
    const box = await fixture(t);
    const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    if (corruption === "checksum") await writeFile(box.file, "manual");
    else if (corruption === "file symlink") { await rm(box.file); await symlink(path.join(box.item.sourcePath, "SKILL.md"), box.file); }
    else { const root = path.dirname(box.file); await rm(root, { recursive: true }); await symlink(box.item.sourcePath, root); }
    await assert.rejects(prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md"), /checksum|symbolic|unsafe/i);
    await assert.rejects(changeSavedDestination(box.libraryDir, box.item.id, { kind: "project", path: ".pi/skills/new" }), /checksum|symbolic|unsafe/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
  });
}

test("S1/S5 generalized replacement retains identity and destination, detects all snapshot secrets, binds fixed source bytes", async (t) => {
  const box = await fixture(t);
  await mkdir(path.join(box.item.sourcePath, "nested"));
  await writeFile(path.join(box.item.sourcePath, "SKILL.md"), "replacement\n");
  await writeFile(path.join(box.item.sourcePath, "nested", "key.json"), "apiKey=sk_live_replacement123456\n");
  const prepared = await prepareResource({ ...box.candidate, name: "Source name", destination: { kind: "project", path: ".pi/skills/source-place" } });
  const change = await prepareSavedReplacement(box.libraryDir, box.item.id, prepared);
  await rm(box.item.sourcePath, { recursive: true });
  assert.deepEqual(readSavedChange(change).sensitivePaths, ["nested/key.json"]);
  await assert.rejects(commitSavedChange(change, { ...approve(change), approvedSensitivePaths: [] }), /approval/i);
  const saved = await commitSavedChange(change, approve(change));
  assert.equal(saved.name, box.item.name);
  assert.equal(saved.id, box.item.id);
  assert.deepEqual(saved.destination, box.item.destination);
  assert.equal((await readSnapshotFiles(box.libraryDir, saved)).length, 2);
  assert.equal(await readFile(box.file, "utf8"), "replacement\n");
});

test("S3 apply cannot reuse an old plan after saved bytes/catalog changes", async (t) => {
  const box = await fixture(t);
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups.push({ id: "team", name: "Team", itemIds: [box.item.id] });
  await saveCatalog(box.libraryDir, catalog);
  const plan = await planApply(box.libraryDir, "team", box.projectDir);
  const edit = await prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md");
  const change = await prepareSavedChange(edit, Buffer.from("new version\n"));
  await commitSavedChange(change, approve(change));
  await assert.rejects(executeApply(box.libraryDir, plan, {}), /changed|revision/i);
  await assert.rejects(lstat(path.join(box.projectDir, ".pi/skills/original/SKILL.md")), { code: "ENOENT" });
});


test("S5 old API binds authentic inspection to fixed candidate/bytes, rejects candidate mismatch, paths-only, and fake inspection", async (t) => {
  const box = await fixture(t, "apiKey=sk_live_fixedsecret123456\n");
  const library = path.join(box.root, "new-library");
  await assert.rejects(importResource(library, box.candidate, { confirmed: true, groupIds: [], approvedSensitivePaths: ["SKILL.md"] }), /inspection|approval/i);
  await assert.rejects(importResource(library, { ...box.candidate, name: "Forged" }, { confirmed: true, groupIds: [], inspection: box.inspection, approvedSensitivePaths: box.inspection.sensitivePaths }), /candidate|metadata|match/i);
  await assert.rejects(importResource(library, box.candidate, { confirmed: true, groupIds: [], inspection: { ...box.inspection, sensitivePaths: [] }, approvedSensitivePaths: [] }), /inspection/i);
  await writeFile(path.join(box.item.sourcePath, "SKILL.md"), "apiKey=sk_live_unapprovedsecret456\n");
  const item = await importResource(library, box.candidate, { confirmed: true, groupIds: [], inspection: box.inspection, approvedSensitivePaths: box.inspection.sensitivePaths });
  assert.ok(item);
  assert.equal((await readSnapshotFiles(library, item))[0]!.bytes.toString(), "apiKey=sk_live_fixedsecret123456\n");
});

test("S4 generic saves/imports cannot bypass excluded destination constraints", async (t) => {
  const box = await fixture(t);
  await assert.rejects(importResource(box.libraryDir, { ...box.candidate, name: "New", destination: { kind: "project", path: ".envrc" } }, { confirmed: true, groupIds: [] }), /destination|private|excluded/i);
  const catalog = await loadCatalog(box.libraryDir);
  catalog.items[0]!.destination = { kind: "project", path: "auth/token.json" };
  await assert.rejects(saveCatalog(box.libraryDir, catalog), /destination|private|excluded/i);
});

test("S1 text-only edit refuses unknown physical files instead of silently deleting them during snapshot swap", async (t) => {
  const box = await fixture(t);
  const unknown = path.join(path.dirname(box.file), "unregistered.md");
  await writeFile(unknown, "manual keep me\n");
  await assert.rejects(prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md"), /unregistered|layout|unexpected/i);
  assert.equal(await readFile(unknown, "utf8"), "manual keep me\n");
});

for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 65, 0]), Buffer.alloc(1_000_001, 65)]) {
  test(`S1 refuses originally saved noneditable bytes ${bytes.length}/${bytes[0]} before raw editing`, async (t) => {
    const box = await fixture(t, bytes);
    await assert.rejects(prepareSavedEdit(box.libraryDir, box.item.id, "SKILL.md"), /UTF-8|binary|NUL|1 MB|1_000_000|limit/i);
    assert.deepEqual(await readFile(box.file), bytes);
  });
}

test("S4 replacement never promotes a newly selected reference-only source into a project destination", async (t) => {
  const box = await fixture(t);
  const prepared = await prepareResource({ ...box.candidate, destination: { kind: "global-only" } });
  await assert.rejects(prepareSavedReplacement(box.libraryDir, box.item.id, prepared), /reference|global-only|applicable/i);
  assert.deepEqual((await loadCatalog(box.libraryDir)).items[0]!.destination, box.item.destination);
});

test("S1 replacement mode-only changes are visible as mode changes, not mislabeled as byte edits", async (t) => {
  const box = await fixture(t);
  const original = await readFile(box.file);
  await chmod(path.join(box.item.sourcePath, "SKILL.md"), 0o755);
  const prepared = await prepareResource(box.candidate);
  const change = await prepareSavedReplacement(box.libraryDir, box.item.id, prepared);
  const view = readSavedChange(change);
  assert.equal(view.bytesChanged, false);
  assert.equal(view.diffs[0]!.bytesChanged, false);
  assert.match(view.diffs[0]!.summary, /mode.*755/);
  const saved = await commitSavedChange(change, approve(change));
  assert.equal(saved.files[0]!.mode, 0o755);
  assert.deepEqual(await readFile(box.file), original);
});

test("S1 replacement records the new source metadata but keeps ID/display name/groups/destination and original source bytes", async (t) => {
  const box = await fixture(t);
  const before = await loadCatalog(box.libraryDir);
  before.groups.push({ id: "team", name: "Team", itemIds: [box.item.id] });
  await saveCatalog(box.libraryDir, before);
  const original = await readFile(path.join(box.item.sourcePath, "SKILL.md"));
  const sourcePath = path.join(box.sourceRoot, "replacement");
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, "SKILL.md"), "new selected source\n");
  const prepared = await prepareResource({ ...box.candidate, sourcePath, source: "New source", scope: "user", name: "New source display", destination: { kind: "project", path: ".pi/skills/other" } });
  const change = await prepareSavedReplacement(box.libraryDir, box.item.id, prepared);
  const saved = await commitSavedChange(change, approve(change));
  assert.equal(saved.sourcePath, sourcePath);
  assert.equal(saved.source, "New source");
  assert.equal(saved.scope, "user");
  assert.equal(saved.id, box.item.id);
  assert.equal(saved.name, box.item.name);
  assert.deepEqual(saved.destination, box.item.destination);
  assert.deepEqual((await loadCatalog(box.libraryDir)).groups, before.groups);
  assert.deepEqual(await readFile(path.join(box.item.sourcePath, "SKILL.md")), original);
  assert.equal((await readSnapshotFiles(box.libraryDir, saved))[0]!.bytes.toString(), "new selected source\n");
});
