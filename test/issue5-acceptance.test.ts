import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertModernCatalog, catalogBytes, importPreparedResource, importResource, loadCatalog as loadStoredCatalog, prepareResource, readPreparedResource, readSnapshotFiles, saveCatalog, saveNameChanges } from "../src/catalog.ts";
import { executeApply, planApply } from "../src/apply.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { changeSavedDestination, commitSavedChange, prepareSavedChange, prepareSavedEdit, prepareSavedReplacement, readSavedChange, readSavedEdit } from "../src/resource-mutations.ts";
import { prepareStorageReview, readStorageReview, StorageSession, StorageTransactions, type StorageCheckpoint, type StorageRevision } from "../src/storage-transaction.ts";
import { approval, box, child, digest, errorChainContains, evidence, interrupted, kernel, modules, proposal, rawTree, wait } from "./helpers/issue5-acceptance.ts";
import type { Catalog, LegacyCatalog } from "../src/types.ts";

async function loadCatalog(library: string): Promise<Catalog> {
  const catalog = await loadStoredCatalog(library);
  assertModernCatalog(catalog);
  return catalog;
}

test("Issue5 error matching follows bounded Error causes and AggregateError errors", () => {
  const specific = new Error("specific recovery cause");
  const wrapper = new Error("outer", { cause: new AggregateError([new Error("unrelated"), specific], "aggregate") });
  assert.equal(errorChainContains(wrapper, (error) => error.message === "specific recovery cause"), true);
  assert.equal(errorChainContains({ message: "specific recovery cause" }, () => true), false);

  const cycle = new AggregateError([], "cycle");
  const cycleErrors: unknown[] = cycle.errors;
  cycleErrors.push(cycle);
  assert.equal(errorChainContains(cycle, () => false), false);

  let beyondDepth = new Error("beyond depth");
  for (let index = 0; index < 9; index += 1) beyondDepth = new Error(`wrapper ${index}`, { cause: beyondDepth });
  assert.equal(errorChainContains(beyondDepth, (error) => error.message === "beyond depth"), false);
});

// Expected values originate in the approved Issue #5 contract, not observed implementation behaviour.
test("S1 fixed bytes/metadata/private view/no-op/source loss", async () => {
  const b = await box();
  await rename(b.sourcePath, path.join(b.root, "removed-original"));
  const original = await loadCatalog(b.library);
  for (const bytes of [Buffer.from("\ufeff日本語 e\u0301\r\n\r\n"), Buffer.alloc(0), Buffer.alloc(1_000_000, 97)]) {
    const edit = await prepareSavedEdit(b.library, b.item.id, "SKILL.md");
    readSavedEdit(edit).file.bytes.fill(0);
    const fixed = Buffer.from(bytes);
    const change = await prepareSavedChange(edit, bytes);
    bytes.fill(0);
    const view = readSavedChange(change);
    view.item.name = "caller forgery";
    view.item.files[0]!.sha256 = "0".repeat(64);
    const saved = await commitSavedChange(change, approval(change));
    assert.deepEqual(await readFile(b.file), fixed);
    assert.equal(saved.files[0]!.sha256, digest(fixed));
    assert.deepEqual((await readSnapshotFiles(b.library, saved))[0]!.bytes, fixed);
    const after = await loadCatalog(b.library);
    assert.deepEqual(after.groups, original.groups);
    assert.deepEqual({ ...after.items[0], files: [] }, { ...original.items[0], files: [] });
    assert.equal((await lstat(b.file)).mode & 0o777, 0o600);
    console.log(`fixed length=${fixed.length} sha=${digest(fixed)}`);
  }
  const before = await rawTree(b.library);
  const edit = await prepareSavedEdit(b.library, b.item.id, "SKILL.md");
  const change = await prepareSavedChange(edit, readSavedEdit(edit).file.bytes);
  assert.equal(readSavedChange(change).bytesChanged, false);
  await commitSavedChange(change, approval(change));
  assert.deepEqual(await rawTree(b.library), before);
  await evidence(b, "fixed-bytes");
});

for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.alloc(1_000_001, 97)]) {
  test(`S1 noneditable existing and proposed input ${bytes.length}/${bytes[0]}`, async () => {
    const b = await box(); const before = await rawTree(b.library);
    const edit = await prepareSavedEdit(b.library, b.item.id, "SKILL.md");
    await assert.rejects(prepareSavedChange(edit, bytes), /encoding|UTF-8|Binary|NUL|limited/i);
    for (const name of ["new.md", "../SKILL.md", "", "a//b", "a\\b", "a\0b", "/SKILL.md"]) await assert.rejects(prepareSavedEdit(b.library, b.item.id, name), /registered|unsafe/i);
    assert.deepEqual(await rawTree(b.library), before);
    const stored = await box({ "SKILL.md": bytes });
    await assert.rejects(prepareSavedEdit(stored.library, stored.item.id, "SKILL.md"), /encoding|UTF-8|Binary|NUL|limited/i);
    await evidence(stored, "noneditable");
  });
}

test("S1/S5 full snapshot replacement: all hunks/mask/binary/large/mode/source immutability", async () => {
  const oldSecret = "sk_live_acceptanceOLD123456";
  const newSecret = "sk_live_acceptanceNEW123456";
  const b = await box({ "SKILL.md": `head old\napiKey=${oldSecret}\n${"unchanged\n".repeat(20)}tail old\n`, "obsolete.md": "remove\n" });
  const before = await loadCatalog(b.library);
  await writeFile(path.join(b.sourcePath, "SKILL.md"), `head new\napiKey=${newSecret}\n${"unchanged\n".repeat(20)}tail new\n`);
  await writeFile(path.join(b.sourcePath, "binary.bin"), Buffer.from([0, 255]));
  await writeFile(path.join(b.sourcePath, "large.md"), Buffer.alloc(1_000_001, 98));
  await rename(path.join(b.sourcePath, "obsolete.md"), path.join(b.root, "removed-obsolete"));
  await mkdir(path.join(b.sourcePath, "auth"));
  await writeFile(path.join(b.sourcePath, "auth", "private"), newSecret);
  await chmod(path.join(b.sourcePath, "SKILL.md"), 0o755);
  const prepared = await prepareResource({ ...b.candidate, name: "Source name differs", destination: { kind: "project", path: "other/location" } });
  const sourceBefore = await rawTree(b.sourcePath);
  const change = await prepareSavedReplacement(b.library, b.item.id, prepared);
  const view = readSavedChange(change);
  assert.equal(view.bytesChanged, true);
  assert.ok(!JSON.stringify(view).includes(oldSecret) && !JSON.stringify(view).includes(newSecret));
  const textDiff = view.diffs.find((d) => d.path === "SKILL.md")!.diff;
  assert.match(textDiff, /head old[\s\S]*head new/);
  assert.match(textDiff, /tail old[\s\S]*tail new/);
  assert.equal(textDiff.split("\n").filter((line) => line.startsWith("@@")).length, 2, "both separated hunks must be visible, not only a preview slice");
  assert.equal(view.diffs.find((d) => d.path === "binary.bin")!.diff, "");
  assert.equal(view.diffs.find((d) => d.path === "large.md")!.diff, "");
  assert.match(view.diffs.find((d) => d.path === "SKILL.md")!.summary, /755/);
  assert.deepEqual(view.excludedPaths, ["auth"]);
  await assert.rejects(commitSavedChange(change, { ...approval(change), approvedSensitivePaths: [] }), /approval/i);
  const saved = await commitSavedChange(change, approval(change));
  assert.equal(saved.name, b.item.name); assert.equal(saved.id, b.item.id);
  assert.deepEqual(saved.destination, b.item.destination);
  assert.deepEqual((await loadCatalog(b.library)).groups, before.groups);
  assert.deepEqual(await rawTree(b.sourcePath), sourceBefore);
  for (const file of await readSnapshotFiles(b.library, saved)) assert.equal(file.sha256, digest(file.bytes));
  await chmod(path.join(b.sourcePath, "SKILL.md"), 0o644);
  const modeOnly = await prepareSavedReplacement(b.library, b.item.id, await prepareResource(b.candidate));
  assert.equal(readSavedChange(modeOnly).bytesChanged, false);
  assert.match(readSavedChange(modeOnly).diffs.find((d) => d.path === "SKILL.md")!.summary, /mode 755 → 644/);
  const modeSaved = await commitSavedChange(modeOnly, approval(modeOnly));
  assert.equal(modeSaved.files.find((f) => f.path === "SKILL.md")!.mode, 0o644);
  await evidence(b, "replacement", view);
});

test("S5 equal masked secrets still report changed fixed bytes; all approval errors preserve raw bytes", async () => {
  const b = await box({ "SKILL.md": "apiKey=sk_live_acceptanceOLD123456\n" });
  const before = await rawTree(b.library);
  const change = await prepareSavedChange(await prepareSavedEdit(b.library, b.item.id, "SKILL.md"), Buffer.from("apiKey=sk_live_acceptanceNEW123456\n"));
  assert.equal(readSavedChange(change).diffs[0]!.bytesChanged, true);
  for (const bad of [
    { ...approval(change), confirmed: false }, { ...approval(change), confirmed: "yes" as unknown as boolean },
    { ...approval(change), reviewId: "different" }, { ...approval(change), approvedSensitivePaths: [] },
    { ...approval(change), approvedSensitivePaths: ["SKILL.md", "extra"] }, { ...approval(change), approvedSensitivePaths: ["SKILL.md", "SKILL.md"] },
  ]) { await assert.rejects(commitSavedChange(change, bad), /confirm|review|approval/i); assert.deepEqual(await rawTree(b.library), before); }
  await commitSavedChange(change, approval(change));
  await evidence(b, "masked-secret", readSavedChange(change));
});

for (const entry of ["legacy", "prepared"] as const) {
  test(`S5 ${entry} import: authentic review/snapshot/metadata/exact paths/array capture`, async () => {
    const b = await box({ "SKILL.md": "apiKey=sk_live_acceptanceIMPORT123456\n" });
    const target = path.join(b.root, "new-library");
    const invoke = (options: Parameters<typeof importPreparedResource>[2]) => entry === "legacy" ? importResource(target, b.candidate, options) : importPreparedResource(target, b.prepared, options);
    const good = { confirmed: true, groupIds: [], inspection: b.inspection, approvedSensitivePaths: ["SKILL.md"] };
    if (entry === "legacy") {
      await assert.rejects(importResource(target, b.candidate, { confirmed: true, groupIds: [] }), /inspection|approval/i);
      await assert.rejects(importResource(target, b.candidate, { confirmed: true, groupIds: [], approvedSensitivePaths: ["SKILL.md"] }), /inspection|approval/i);
      await assert.rejects(importResource(target, { ...b.candidate, name: "different metadata" }, good), /metadata|candidate/i);
    }
    for (const paths of [[], ["other"], ["SKILL.md", "extra"], ["SKILL.md", "SKILL.md"]]) await assert.rejects(invoke({ ...good, approvedSensitivePaths: paths }), /approval/i);
    await assert.rejects(invoke({ ...good, inspection: { ...b.inspection, sensitivePaths: [] } }), /inspection/i);
    const other = await prepareResource(b.candidate);
    if (entry === "prepared") await assert.rejects(importPreparedResource(target, other, good), /inspection/i);
    assert.equal(await invoke({ ...good, confirmed: "yes" as unknown as boolean }), null);
    const paths: string[] = []; const pending = invoke({ ...good, approvedSensitivePaths: paths }); paths.push("SKILL.md");
    await assert.rejects(pending, /approval/i);
    await assert.rejects(lstat(target), { code: "ENOENT" });
    readPreparedResource(b.prepared).files[0]!.bytes.fill(0);
    const caller = { ...b.candidate, destination: { ...b.candidate.destination } };
    const allowed = ["SKILL.md"];
    const savedPending = entry === "legacy" ? importResource(target, caller, { ...good, approvedSensitivePaths: allowed }) : invoke({ ...good, approvedSensitivePaths: allowed });
    caller.name = "later change"; allowed.length = 0;
    await writeFile(path.join(b.sourcePath, "SKILL.md"), "unapproved source replacement\n");
    const saved = await savedPending; assert.ok(saved);
    assert.equal((await readSnapshotFiles(target, saved))[0]!.bytes.toString(), "apiKey=sk_live_acceptanceIMPORT123456\n");
    await evidence(b, `import-${entry}`, { target, tree: await rawTree(target) });
  });
}

test("S5 direct kernel secret replacement requires exact review approval", async () => {
  const b = await box(); const before = await rawTree(b.library);
  const p = await proposal(b, { "SKILL.md": "apiKey=sk_live_acceptanceKERNEL123456\n" });
  await assert.rejects(kernel(b, p), /approval|inspection/i);
  const review = prepareStorageReview(p.bytes, p.replacements);
  const approve = { confirmed: true, reviewId: review.reviewId, approvedSensitivePaths: readStorageReview(review).sensitivePaths };
  for (const bad of [ { ...approve, confirmed: "yes" as unknown as boolean }, { ...approve, reviewId: "other" }, { ...approve, approvedSensitivePaths: [] }, { ...approve, approvedSensitivePaths: [...approve.approvedSensitivePaths, ...approve.approvedSensitivePaths] } ]) {
    await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), p.bytes, p.replacements, { review, approval: bad }), { requiresNativePlacement: false }), /approval|review/i);
  }
  assert.deepEqual(await rawTree(b.library), before);
  await evidence(b, "kernel-secret-rejections");
});

test("S5 catalog save requires inspection; metadata-only descriptor registration is forbidden", async () => {
  const b = await box();
  const newPath = path.join(path.dirname(b.file), "manually-added.md");
  const secret = "apiKey=sk_live_acceptanceDESCRIPTOR123456\n";
  await writeFile(newPath, secret);
  const before = await rawTree(b.library);
  const catalog = await loadCatalog(b.library);
  const descriptorBefore = structuredClone(catalog.items[0]!.files);
  const addedDescriptor = { path: "manually-added.md", mode: 0o600, sha256: digest(secret) };
  const changed = structuredClone(catalog);
  changed.items[0]!.files.push({ ...addedDescriptor });

  await assert.rejects(saveCatalog(b.library, changed), /Saving an existing catalog requires the original object returned by loadCatalog; detached catalogs have no verified starting revision\./);
  assert.deepEqual(await rawTree(b.library), before);
  assert.deepEqual(await readFile(newPath), Buffer.from(secret));

  catalog.items[0]!.files.push({ ...addedDescriptor });
  await assert.rejects(saveCatalog(b.library, catalog), /Content changes require a prepared inspection and individual approval; use the saved-change API\./);
  assert.deepEqual(await rawTree(b.library), before);
  assert.deepEqual(await readFile(newPath), Buffer.from(secret));
  assert.deepEqual((await loadCatalog(b.library)).items[0]!.files, descriptorBefore);

  await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), catalogBytes(changed)), { requiresNativePlacement: false }), /A catalog-only transaction may change only item names and legal destinations; source metadata, descriptors, and content are fixed\./);
  assert.deepEqual(await rawTree(b.library), before);
  assert.deepEqual(await readFile(newPath), Buffer.from(secret));
  await evidence(b, "catalog-only-secret-descriptor-rejected");
});

for (const mutation of ["body", "raw catalog", "group", "other item", "mode", "unregistered file", "unregistered directory"] as const) {
  test(`S3 prepared change refuses ${mutation} without discarding external state`, async () => {
    const b = await box();
    const change = await prepareSavedChange(await prepareSavedEdit(b.library, b.item.id, "SKILL.md"), Buffer.from("proposed stale\n"));
    if (mutation === "body") await writeFile(b.file, "external body\n");
    else if (mutation === "raw catalog") await writeFile(path.join(b.library, "catalog.json"), ` \n${await readFile(path.join(b.library, "catalog.json"), "utf8")}`);
    else if (mutation === "group") { const c = await loadCatalog(b.library); c.groups[0]!.name = "External team"; await saveCatalog(b.library, c); }
    else if (mutation === "other item") await importResource(b.library, { ...b.candidate, name: "Other item" }, { confirmed: true, groupIds: [] });
    else if (mutation === "mode") await chmod(b.file, 0o640);
    else if (mutation === "unregistered file") await writeFile(path.join(path.dirname(b.file), "external.md"), "external keep\n");
    else await mkdir(path.join(path.dirname(b.file), "external-directory"));
    const before = await evidence(b, "external-before", { mutation });
    await assert.rejects(commitSavedChange(change, approval(change)), /changed|checksum|revision/i);
    assert.deepEqual(await rawTree(b.library), before);
    await evidence(b, "external-after", { mutation });
  });
}

test("S3 stale original/clone/name before-catalog/cross-library revisions rejected", async () => {
  const b = await box(); const other = await box();
  const stale = await loadCatalog(b.library);
  const revision = await new StorageTransactions().run(b.library, false, async (s) => s!.capture(), { requiresNativePlacement: false });
  const current = await loadCatalog(b.library); current.groups[0]!.name = "Winner"; await saveCatalog(b.library, current);
  const before = await rawTree(b.library);
  stale.groups[0]!.name = "Stale";
  await assert.rejects(saveCatalog(b.library, stale), /Copi library changed after preparation/);
  await assert.rejects(saveCatalog(b.library, structuredClone(current)), /detached|original|revision/i);
  await assert.rejects(saveNameChanges(b.library, structuredClone(current), current), /original|revision/i);

  const currentItem = current.items[0]!;
  const otherContent = path.join(other.library, ...currentItem.content.path.split("/"));
  await cp(path.join(b.library, ...currentItem.content.path.split("/")), otherContent, { recursive: true });
  const otherBefore = await rawTree(other.library);
  await assert.rejects(saveCatalog(other.library, current), /Copi library changed after preparation/);
  await assert.rejects(new StorageTransactions().run(other.library, false, async (s) => s!.assertRevision(revision!), { requiresNativePlacement: false }), /Copi library changed after preparation/);
  assert.deepEqual(await rawTree(b.library), before);
  assert.deepEqual(await rawTree(other.library), otherBefore);
});

for (const unsafe of ["", "/absolute", "..", "a/../b", "a\\b", "a\0b", "a//b", "a/", "auth/x", ".envrc", "x/.env-production", "cache/x"]) {
  test(`S4 all destination entry points reject ${JSON.stringify(unsafe)}`, async () => {
    const b = await box(); const before = await rawTree(b.library);
    const destination = { kind: "project" as const, path: unsafe };
    await assert.rejects(changeSavedDestination(b.library, b.item.id, destination), /unsafe|private|excluded/i);
    await assert.rejects(importResource(b.library, { ...b.candidate, name: "Different", destination }, { confirmed: true, groupIds: [] }), /destination/i);
    const c = await loadCatalog(b.library); c.items[0]!.destination = destination;
    await assert.rejects(saveCatalog(b.library, c), /destination|catalog/i);
    await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), Buffer.from(JSON.stringify(c))), { requiresNativePlacement: false }), /destination|catalog/i);
    assert.deepEqual(await rawTree(b.library), before);
  });
}

test("S4 destination independent of all item metadata/body/groups; reference-only cannot be promoted", async () => {
  const b = await box(); const before = await loadCatalog(b.library); const content = await readFile(b.file);
  const destination = { kind: "project" as const, path: "relative/safe" };
  assert.deepEqual(await changeSavedDestination(b.library, b.item.id, destination), { ...b.item, destination });
  assert.deepEqual(await readFile(b.file), content);
  assert.deepEqual((await loadCatalog(b.library)).groups, before.groups);
  await changeSavedDestination(b.library, b.item.id, { kind: "global-only" });
  const held = await rawTree(b.library);
  await assert.rejects(changeSavedDestination(b.library, b.item.id, destination), /reference|global-only/i);
  const c = await loadCatalog(b.library); c.items[0]!.destination = destination;
  await assert.rejects(saveCatalog(b.library, c), /reference|global-only/i);
  await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), catalogBytes(c)), { requiresNativePlacement: false }), /reference|global-only/i);
  assert.deepEqual(await rawTree(b.library), held);
});

test("S2 directly edited current bytes are read without repairing descriptor metadata during a destination change", async () => {
  const b = await box();
  const before = await loadCatalog(b.library);
  const descriptorBefore = structuredClone(before.items[0]!.files);
  const edited = Buffer.from("manual current source edit\n");
  await writeFile(b.file, edited);
  const sourceStat = await lstat(b.file);
  const loaded = await loadCatalog(b.library);
  assert.deepEqual(loaded.items[0]!.files, descriptorBefore);
  const files = await readSnapshotFiles(b.library, loaded.items[0]!);
  assert.deepEqual(files.find((file) => file.path === "SKILL.md")!.bytes, edited);
  assert.equal(files.find((file) => file.path === "SKILL.md")!.sha256, digest(edited));
  assert.deepEqual(readSavedEdit(await prepareSavedEdit(b.library, b.item.id, "SKILL.md")).file.bytes, edited);

  const destination = { kind: "project" as const, path: "relative/current-edited-content" };
  await changeSavedDestination(b.library, b.item.id, destination);
  const after = await loadCatalog(b.library);
  assert.deepEqual(after.items[0], { ...before.items[0]!, destination });
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.items[0]!.files, descriptorBefore);
  assert.deepEqual(await readFile(b.file), edited);
  const afterStat = await lstat(b.file);
  assert.equal(afterStat.dev, sourceStat.dev);
  assert.equal(afterStat.ino, sourceStat.ino);
});

for (const corruption of ["file symlink", "directory symlink", "item symlink"] as const) {
  test(`S6 ${corruption}: unsafe registered source is rejected at its read/mutation boundary`, async () => {
    const b = await box({ "SKILL.md": "safe current skill\n", "nested/notes.md": "registered nested note\n" });
    if (b.item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
    const contentRoot = path.join(b.library, ...b.item.content.path.split("/"));
    const file = path.join(contentRoot, "SKILL.md");
    let linkPath: string;
    let outside: string;
    if (corruption === "file symlink") {
      linkPath = file;
      outside = path.join(b.root, "held-skill.md");
      await rename(file, outside);
      await symlink(outside, file);
    } else if (corruption === "directory symlink") {
      linkPath = path.join(contentRoot, "nested");
      outside = path.join(b.root, "held-nested");
      await rename(linkPath, outside);
      await symlink(outside, linkPath);
    } else {
      linkPath = contentRoot;
      outside = path.join(b.root, "held-content-root");
      await rename(contentRoot, outside);
      await symlink(outside, contentRoot);
    }
    const outsideFile = corruption === "file symlink" ? outside : path.join(outside, corruption === "directory symlink" ? "notes.md" : "SKILL.md");
    const outsideBefore = await rawTree(outside);
    const outsideBytes = await readFile(outsideFile);
    const outsideStat = await lstat(outsideFile);
    const libraryBefore = await rawTree(b.library);
    const contentPathError = corruption === "item symlink"
      ? /Content contains an unsafe symbolic link\./
      : /Source tree contains an unsafe symbolic link\./;

    if (corruption === "item symlink") await assert.rejects(loadStoredCatalog(b.library), /Content contains an unsafe symbolic link\./);
    await assert.rejects(readSnapshotFiles(b.library, b.item), contentPathError);
    await assert.rejects(prepareSavedEdit(b.library, b.item.id, "SKILL.md"), contentPathError);
    await assert.rejects(changeSavedDestination(b.library, b.item.id, { kind: "project", path: "safe/new" }), contentPathError);

    assert.deepEqual(await rawTree(b.library), libraryBefore);
    assert.ok((await lstat(linkPath)).isSymbolicLink());
    assert.deepEqual(await rawTree(outside), outsideBefore);
    assert.deepEqual(await readFile(outsideFile), outsideBytes);
    const outsideAfter = await lstat(outsideFile);
    assert.equal(outsideAfter.dev, outsideStat.dev);
    assert.equal(outsideAfter.ino, outsideStat.ino);
    await evidence(b, "unsafe-registered-content-rejected", { corruption });
  });
}

test("S3 name-only preview rejects a later direct source edit without replacing it or changing its descriptor", async () => {
  const b = await box();
  await writeFile(b.file, "direct source edit before preview\n");
  const before = await loadCatalog(b.library);
  const after = structuredClone(before);
  after.groups[0]!.name = "previewed group rename";
  const catalogPath = path.join(b.library, "catalog.json");
  const catalogBytesBefore = await readFile(catalogPath);
  const descriptorBefore = structuredClone(before.items[0]!.files);

  await writeFile(b.file, "later external edit after preview\n");
  const externalBytes = await readFile(b.file);
  const externalStat = await lstat(b.file);
  const libraryBeforeCommit = await rawTree(b.library);
  await assert.rejects(saveNameChanges(b.library, before, after), /Copi library changed after preparation \(catalog or saved bytes\)/);
  assert.deepEqual(await rawTree(b.library), libraryBeforeCommit);
  assert.deepEqual(await readFile(catalogPath), catalogBytesBefore);
  assert.deepEqual(await readFile(b.file), externalBytes);
  const current = await loadCatalog(b.library);
  assert.equal(current.groups[0]!.name, before.groups[0]!.name);
  assert.deepEqual(current.items[0]!.files, descriptorBefore);
  const afterStat = await lstat(b.file);
  assert.equal(afterStat.dev, externalStat.dev);
  assert.equal(afterStat.ino, externalStat.ino);
});

test("S6 wrong next checksum is rejected before mutation", async () => {
  const b = await box(); const p = await proposal(b); const before = await rawTree(b.library);
  p.next.items[0]!.files[0]!.sha256 = "f".repeat(64); p.bytes = catalogBytes(p.next);
  await assert.rejects(kernel(b, p), /checksums|bytes|snapshot/i);
  assert.deepEqual(await rawTree(b.library), before);
});

type ProposedSourceFile = Awaited<ReturnType<typeof proposal>>["replacements"][number]["files"][number];

async function assertSourceReplacementStage(library: string, sourceRoot: string, files: readonly ProposedSourceFile[], oldTree: Record<string, string>): Promise<void> {
  const lock = path.join(library, ".copi-transaction");
  const stage = path.join(lock, "next-0");
  const staged = await rawTree(stage);
  const stagedFiles = Object.entries(staged).filter(([, value]) => value.startsWith("mode:")).map(([relative]) => relative).sort();
  assert.deepEqual(stagedFiles, files.map((file) => file.path).sort(), "source-change checkpoint must expose the reviewed tree artifact, not a catalog-only stage");
  for (const file of files) assert.deepEqual(await readFile(path.join(stage, ...file.path.split("/"))), file.bytes);
  assert.deepEqual(await rawTree(sourceRoot), oldTree, "live source tree remains at its original bytes before swap");
  await assert.rejects(lstat(path.join(lock, "next-catalog")), { code: "ENOENT" }, "source tree staging occurs before catalog metadata staging");
}

for (const boundary of ["stage-write", "stage-sync", "journal", "old-renamed", "new-renamed", "catalog-held", "catalog-renamed", "directory-sync", "committed"] as StorageCheckpoint[]) {
  test(`S2 real multi-file transaction fault ${boundary}: exact old state and usable reader`, async () => {
    const b = await box({ "SKILL.md": "old A\n", "nested/second.md": "old B\n" });
    const p = await proposal(b, { "SKILL.md": "new A\n", "nested/second.md": "new B\n", "added.md": "new C\n" });
    if (b.item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
    const sourceRoot = path.join(b.library, ...b.item.content.path.split("/"));
    const oldTree = await rawTree(sourceRoot);
    const originalFile = await readFile(b.file);
    const before = await evidence(b, "fault-before", { boundary }); let count = 0; const reached: string[] = [];
    await assert.rejects(kernel(b, p, { checkpoint: async (point, root) => {
      reached.push(point);
      if (point === boundary) {
        count += 1;
        if (boundary === "stage-write" || boundary === "stage-sync") {
          await assertSourceReplacementStage(root, sourceRoot, p.replacements[0]!.files, oldTree);
          assert.deepEqual(await readFile(b.file), originalFile);
        }
        throw new Error(`independent fault ${boundary}`);
      }
    } }), /independent fault/i);
    assert.equal(count, 1);
    assert.ok(reached.includes(boundary));
    assert.deepEqual(await rawTree(b.library), before);
    assert.equal((await readSnapshotFiles(b.library, (await loadCatalog(b.library)).items[0]!)).length, 2);
    await evidence(b, "fault-after", { boundary, count, reached });
  });
}

test("S2 catalog-stage sync fault after a checked source-tree stage retains the original tree", async () => {
  const b = await box({ "SKILL.md": "old\n", "nested/second.md": "old second\n" });
  const p = await proposal(b, { "SKILL.md": "new\n", "nested/second.md": "new second\n" });
  if (b.item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
  const sourceRoot = path.join(b.library, ...b.item.content.path.split("/"));
  const oldTree = await rawTree(sourceRoot);
  const before = await rawTree(b.library);
  let stageSyncs = 0;
  await assert.rejects(kernel(b, p, { checkpoint: async (point, root) => {
    if (point !== "stage-sync") return;
    stageSyncs += 1;
    if (stageSyncs === 1) {
      await assertSourceReplacementStage(root, sourceRoot, p.replacements[0]!.files, oldTree);
      return;
    }
    assert.equal(stageSyncs, 2);
    assert.deepEqual(await readFile(path.join(root, ".copi-transaction", "next-catalog")), p.bytes);
    assert.deepEqual(await rawTree(sourceRoot), oldTree);
    throw new Error("independent catalog-stage sync fault");
  } }), /independent catalog-stage sync fault/);
  assert.equal(stageSyncs, 2);
  assert.deepEqual(await rawTree(b.library), before);
  assert.deepEqual(await rawTree(sourceRoot), oldTree);
  await evidence(b, "catalog-stage-sync-fault", { stageSyncs });
});

for (const [boundary, rollback, expected] of [["old-renamed", false, "old"], ["catalog-held", false, "old"], ["catalog-renamed", false, "new"], ["finalized", false, "new"], ["rollback-displaced", true, "old"], ["rollback-catalog-held", true, "old"], ["rollback-finalized", true, "old"]] as const) {
  test(`S2/S3 real SIGKILL ${boundary}; normal reader recovery ${expected}`, async () => {
    const b = await box({ "SKILL.md": "old A\n", "second.md": "old B\n" });
    const p = await proposal(b, { "SKILL.md": "new A\n", "second.md": "new B\n" });
    const writer = await child(b, interrupted(b, p, boundary, rollback));
    try { await wait(writer.process, "BOUNDARY"); } finally { writer.process.kill("SIGKILL"); }
    const result = await writer.exit; assert.equal(result.signal, "SIGKILL");
    await evidence(b, "killed-before-reader", { boundary, result });
    const c = await loadCatalog(b.library); const files = await readSnapshotFiles(b.library, c.items[0]!);
    assert.deepEqual(Object.fromEntries(files.map((f) => [f.path, f.bytes.toString()])), { "SKILL.md": `${expected} A\n`, "second.md": `${expected} B\n` });
    for (const f of files) assert.equal(f.sha256, digest(f.bytes));
    await assert.rejects(lstat(path.join(b.library, ".copi-transaction")), { code: "ENOENT" });
    await evidence(b, "recovered", { boundary, result });
  });
}

test("S3 real two-process prepared edit: one winner, one rejected loser, retained winner", async () => {
  const b = await box();
  const code = (text: string) => `import {prepareSavedEdit,prepareSavedChange,commitSavedChange} from ${JSON.stringify(modules.mutations)};
const c=await prepareSavedChange(await prepareSavedEdit(${JSON.stringify(b.library)},${JSON.stringify(b.item.id)},'SKILL.md'),Buffer.from(${JSON.stringify(text)}));console.log('READY');
await new Promise(r=>process.stdin.once('data',r));await commitSavedChange(c,{confirmed:true,reviewId:c.reviewId,approvedSensitivePaths:[]});process.stdin.destroy();`;
  const a = await child(b, code("winner A\n")); const z = await child(b, code("winner Z\n"));
  try {
    await Promise.all([wait(a.process, "READY"), wait(z.process, "READY")]); a.process.stdin.write("go"); z.process.stdin.write("go");
    const results = await Promise.all([a.exit, z.exit]); assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
    assert.match(results.find((r) => r.code === 1)!.output, /changed|revision/i);
    assert.equal((await readSnapshotFiles(b.library, b.item))[0]!.bytes.toString(), results[0]!.code === 0 ? "winner A\n" : "winner Z\n");
    await evidence(b, "process-edit-race", results);
  } finally { a.process.kill(); z.process.kill(); }
});

test("S3 real concurrent imports retain both; reader waits through live rename gap", async () => {
  const b = await box();
  const children = await Promise.all(["Concurrent A", "Concurrent B"].map((name) => child(b, `import {importResource} from ${JSON.stringify(modules.catalog)};await importResource(${JSON.stringify(b.library)},${JSON.stringify({ ...b.candidate, name })},{confirmed:true,groupIds:[]});`)));
  const results = await Promise.all(children.map((c) => c.exit)); for (const result of results) assert.equal(result.code, 0, result.output);
  assert.equal((await loadCatalog(b.library)).items.length, 3);
  const writer = await child(b, interrupted(b, await proposal(b), "old-renamed"));
  try {
    await wait(writer.process, "BOUNDARY");
    const reader = await child(b, `import {loadCatalog,readSnapshotFiles} from ${JSON.stringify(modules.catalog)};const c=await loadCatalog(${JSON.stringify(b.library)});const f=await readSnapshotFiles(${JSON.stringify(b.library)},c.items[0]);console.log('READ',f[0].bytes.toString());`);
    let completed = false; void reader.exit.then(() => { completed = true; });
    await new Promise((r) => setTimeout(r, 100)); assert.equal(completed, false);
    writer.process.kill("SIGKILL"); await writer.exit;
    const output = await reader.exit; assert.equal(output.code, 0, output.output); assert.match(output.output, /独立 old/);
    await evidence(b, "parallel-import-reader", { results, reader: output });
  } finally { writer.process.kill("SIGKILL"); }
});

for (const owner of ["malformed", "active", "foreign host"] as const) {
  test(`S2 unknown or ${owner} lock owner: fail closed, no cleanup`, async () => {
    const b = await box(); const lock = path.join(b.library, ".copi-transaction"); await mkdir(lock, { mode: 0o700 });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner === "malformed" ? {} : { version: 1, pid: process.pid, host: owner === "active" ? os.hostname() : "not-this-host", token: randomUUID() }), { mode: 0o600 });
    const before = await evidence(b, "unknown-lock-before", { owner });
    await assert.rejects(new StorageTransactions({ waitMilliseconds: 40 }).run(b.library, false, async () => {}, { requiresNativePlacement: false }), /owner|active|host|lock/i);
    assert.deepEqual(await rawTree(b.library), before);
  });
}

for (const corruption of ["missing journal", "altered journal", "altered backup", "missing backup"] as const) {
  test(`S2 interrupted writer ${corruption}: retained unknown state, not automatic destructive repair`, async () => {
    const b = await box(); const p = await proposal(b);
    const writer = await child(b, interrupted(b, p, "new-renamed"));
    try { await wait(writer.process, "BOUNDARY"); } finally { writer.process.kill("SIGKILL"); } await writer.exit;
    const lock = path.join(b.library, ".copi-transaction");
    if (corruption === "missing journal") await rename(path.join(lock, "journal.json"), path.join(b.root, "held-journal"));
    else if (corruption === "altered journal") await writeFile(path.join(lock, "journal.json"), "{}");
    else if (corruption === "missing backup") await rename(path.join(lock, "old-0"), path.join(b.root, "held-backup"));
    else await writeFile(path.join(lock, "old-0", "SKILL.md"), "tampered backup\n");
    const before = await evidence(b, "damaged-journal-before", { corruption });
    const retainedPaths = corruption === "missing journal"
      ? [path.join(b.root, "held-journal"), path.join(lock, "old-0")]
      : corruption === "missing backup"
        ? [path.join(lock, "journal.json"), path.join(b.root, "held-backup")]
        : [path.join(lock, "journal.json"), path.join(lock, "old-0")];
    const retainedBefore = await Promise.all(retainedPaths.map((target) => rawTree(target)));
    if (corruption === "missing backup") {
      await assert.rejects(loadCatalog(b.library), /V2 recovery does not have exactly one checked original sources inode\./);
    } else {
      await assert.rejects(loadCatalog(b.library), /journal|rollback|altered|unknown/i);
    }
    assert.deepEqual(await rawTree(b.library), before);
    for (const [index, target] of retainedPaths.entries()) assert.deepEqual(await rawTree(target), retainedBefore[index]);
  });
}

for (const retained of ["old snapshot", "held catalog", "recreated catalog", "displaced snapshot"] as const) {
  test(`S3 late external ${retained}: bytes/inode retained, never deleted by cleanup`, async () => {
    const b = await box(); const p = await proposal(b); const external = Buffer.from("external retained bytes\n");
    let target = ""; let reached = false; let targetIdentity: { dev: number; ino: number } | undefined;
    const expectedCauses = retained === "old snapshot"
      ? ["Original sources inode changed after rename; retained external bytes instead of deleting them.", "V2 registered sources bytes or inode changed externally; refusing recovery."]
      : retained === "displaced snapshot"
        ? ["trigger rollback", "V2 retained source stage or backup changed during recovery."]
        : [];
    await assert.rejects(kernel(b, p, { checkpoint: async (point, root) => {
      const lock = path.join(root, ".copi-transaction");
      if (retained === "displaced snapshot" && point === "before-catalog") throw new Error("trigger rollback");
      if ((retained === "old snapshot" && point === "old-renamed") || (retained === "held catalog" && point === "catalog-held") || (retained === "recreated catalog" && point === "catalog-held") || (retained === "displaced snapshot" && point === "rollback-restored")) {
        target = retained === "old snapshot" ? path.join(lock, "old-0", "SKILL.md") : retained === "displaced snapshot" ? path.join(lock, "displaced-0", "SKILL.md") : retained === "held catalog" ? path.join(lock, "held-catalog") : path.join(root, "catalog.json");
        reached = true;
        await writeFile(target, external);
        const stat = await lstat(target);
        targetIdentity = { dev: stat.dev, ino: stat.ino };
      }
    } }), (error: unknown) => error instanceof AggregateError &&
      error.message.startsWith("Copi sources transaction could not safely recover an external change; retained private journal and source bytes.") &&
      expectedCauses.every((message) => errorChainContains(error, (nested) => nested.message === message)));
    assert.ok(reached); assert.ok(targetIdentity); assert.deepEqual(await readFile(target), external);
    const lock = path.join(b.library, ".copi-transaction");
    const journalPath = path.join(lock, "journal.json");
    const lockBeforeReader = await rawTree(lock);
    const journalBeforeReader = await readFile(journalPath);
    const journalStatBeforeReader = await lstat(journalPath);
    await assert.rejects(loadCatalog(b.library), (error: unknown) => error instanceof Error && error.message === "Copi transaction recovery stopped after an external change; inspect its owner-only journal. No external bytes were overwritten.");
    assert.deepEqual(await rawTree(lock), lockBeforeReader);
    assert.deepEqual(await readFile(journalPath), journalBeforeReader);
    const journalStatAfterReader = await lstat(journalPath);
    assert.equal(journalStatAfterReader.dev, journalStatBeforeReader.dev);
    assert.equal(journalStatAfterReader.ino, journalStatBeforeReader.ino);
    assert.deepEqual(await readFile(target), external);
    const targetAfter = await lstat(target);
    assert.equal(targetAfter.dev, targetIdentity.dev);
    assert.equal(targetAfter.ino, targetIdentity.ino);
    await evidence(b, "late-inode-retained", { retained, target, targetIdentity, journalPath, journalStatBeforeReader: { dev: journalStatBeforeReader.dev, ino: journalStatBeforeReader.ino } });
  });
}

test("S4 sources-root symlink swap stops before live outside mutation", async () => {
  const b = await box(); const p = await proposal(b);
  const sourcesRoot = path.join(b.library, "sources");
  const outside = path.join(b.root, "outside-sources");
  const originalSources = path.join(b.root, "original-sources");
  await cp(sourcesRoot, outside, { recursive: true });
  const outsideBefore = await rawTree(outside);
  const originalBefore = await rawTree(sourcesRoot);
  const outsideFile = path.join(outside, b.item.id, "SKILL.md");
  const outsideFileBefore = await lstat(outsideFile);
  const originalRootBefore = await lstat(sourcesRoot);
  let crossed = false;
  await assert.rejects(kernel(b, p, { checkpoint: async (point) => {
    if (point === "old-renamed") crossed = true;
    if (point === "before-swap") {
      await rename(sourcesRoot, originalSources);
      await symlink(outside, sourcesRoot);
    }
  } }), (error: unknown) => error instanceof AggregateError &&
    error.message.startsWith("Copi sources transaction could not safely recover an external change; retained private journal and source bytes.") &&
    errorChainContains(error, (nested) => nested.message === "Registered sources tree changed during commit; refusing overwrite.") &&
    errorChainContains(error, (nested) => nested.message === "Registered sources tree has a missing, unsafe, or symbolic-link parent directory."));
  assert.equal(crossed, false);
  const sourceLinkBeforeReader = await lstat(sourcesRoot);
  assert.ok(sourceLinkBeforeReader.isSymbolicLink());
  assert.equal(await readlink(sourcesRoot), outside);
  const lock = path.join(b.library, ".copi-transaction");
  const journalPath = path.join(lock, "journal.json");
  const retainedLock = await rawTree(lock);
  const journalBefore = await readFile(journalPath);
  const journalStatBefore = await lstat(journalPath);
  await assert.rejects(loadStoredCatalog(b.library), (error: unknown) => error instanceof Error && error.message === "Copi transaction recovery stopped after an external change; inspect its owner-only journal. No external bytes were overwritten.");
  assert.deepEqual(await rawTree(lock), retainedLock);
  assert.deepEqual(await readFile(journalPath), journalBefore);
  const journalStatAfter = await lstat(journalPath);
  assert.equal(journalStatAfter.dev, journalStatBefore.dev);
  assert.equal(journalStatAfter.ino, journalStatBefore.ino);
  const sourceLinkAfterReader = await lstat(sourcesRoot);
  assert.ok(sourceLinkAfterReader.isSymbolicLink());
  assert.equal(sourceLinkAfterReader.dev, sourceLinkBeforeReader.dev);
  assert.equal(sourceLinkAfterReader.ino, sourceLinkBeforeReader.ino);
  assert.equal(await readlink(sourcesRoot), outside);
  assert.deepEqual(await rawTree(outside), outsideBefore);
  assert.deepEqual(await rawTree(originalSources), originalBefore);
  const outsideFileAfter = await lstat(outsideFile);
  assert.equal(outsideFileAfter.dev, outsideFileBefore.dev);
  assert.equal(outsideFileAfter.ino, outsideFileBefore.ino);
  const originalRootAfter = await lstat(originalSources);
  assert.equal(originalRootAfter.dev, originalRootBefore.dev);
  assert.equal(originalRootAfter.ino, originalRootBefore.ino);
  await evidence(b, "sources-root-ancestor-swap", { outside, originalSources, journalPath, outsideFile: { dev: outsideFileAfter.dev, ino: outsideFileAfter.ino }, sourceLink: { dev: sourceLinkAfterReader.dev, ino: sourceLinkAfterReader.ino } });
});

test("S4 v1 reader preserves legacy metadata and bytes; ordinary apply requires explicit migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-issue5-v1-acceptance-"));
  const library = path.join(root, "library");
  const project = path.join(root, "target");
  const id = "123e4567-e89b-42d3-a456-426614174099";
  const savedAt = "2026-10-05T00:00:00.000Z";
  const skill = Buffer.from("# Legacy skill\nlegacy bytes\n");
  const privateBytes = Buffer.from("private legacy bytes\n");
  const filesRoot = path.join(library, "items", id, "files");
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(filesRoot, "SKILL.md"), skill, { mode: 0o600 });
  await writeFile(path.join(filesRoot, ".envrc"), privateBytes, { mode: 0o600 });
  const catalog: LegacyCatalog = {
    version: 1,
    items: [{
      id, kind: "skill", source: "legacy-origin", scope: "project", sourcePath: path.join(root, "missing-origin", "SKILL.md"),
      destination: { kind: "project", path: ".pi/skills/legacy" }, name: "Legacy skill", savedAt,
      files: [
        { path: "SKILL.md", mode: 0o644, sha256: digest(skill) },
        { path: ".envrc", mode: 0o600, sha256: digest(privateBytes) },
      ],
    }],
    groups: [{ id: "legacy-team", name: "Legacy team", itemIds: [id] }],
  };
  const catalogPath = path.join(library, "catalog.json");
  const catalogBytesOnDisk = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(catalogPath, catalogBytesOnDisk, { mode: 0o600 });
  await mkdir(project, { recursive: true });
  const libraryBefore = await rawTree(library);
  const libraryDigestBefore = digest(JSON.stringify(libraryBefore));
  const targetBefore = await rawTree(project);
  const targetDigestBefore = digest(JSON.stringify(targetBefore));
  const stored = await loadStoredCatalog(library);
  assert.equal(stored.version, 1);
  const storedItem = stored.items[0]!;
  assert.equal(storedItem.id, id);
  assert.equal(storedItem.source, "legacy-origin");
  assert.equal(storedItem.sourcePath, path.join(root, "missing-origin", "SKILL.md"));
  assert.equal(storedItem.kind, "skill");
  assert.equal(storedItem.scope, "project");
  assert.equal(storedItem.savedAt, savedAt);
  const files = await readSnapshotFiles(library, storedItem);
  assert.deepEqual(files.map((file) => file.path).sort(), [".envrc", "SKILL.md"]);
  assert.equal(files.find((file) => file.path === "SKILL.md")!.mode, 0o644);
  assert.equal(files.find((file) => file.path === ".envrc")!.mode, 0o600);
  assert.deepEqual(files.find((file) => file.path === "SKILL.md")!.bytes, skill);
  assert.deepEqual(files.find((file) => file.path === ".envrc")!.bytes, privateBytes);
  assert.equal((await lstat(path.join(filesRoot, "SKILL.md"))).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(filesRoot, ".envrc"))).mode & 0o777, 0o600);

  await assert.rejects(planApply(library, "legacy-team", project), /This operation requires catalog v2; explicitly migrate the v1 library first\./);

  assert.equal(digest(JSON.stringify(await rawTree(project))), targetDigestBefore);
  assert.deepEqual(await rawTree(project), targetBefore);
  assert.equal(digest(JSON.stringify(await rawTree(library))), libraryDigestBefore);
  assert.deepEqual(await rawTree(library), libraryBefore);
  assert.deepEqual(await readFile(catalogPath), catalogBytesOnDisk);
  const reread = await loadStoredCatalog(library);
  assert.equal(reread.version, 1);
  assert.equal(reread.items[0]!.id, id);
  assert.equal(reread.items[0]!.source, "legacy-origin");
  assert.equal(reread.items[0]!.sourcePath, path.join(root, "missing-origin", "SKILL.md"));
  const rereadFiles = await readSnapshotFiles(library, reread.items[0]!);
  assert.deepEqual(rereadFiles.find((file) => file.path === "SKILL.md")!.bytes, skill);
  assert.deepEqual(rereadFiles.find((file) => file.path === ".envrc")!.bytes, privateBytes);
  assert.equal((await lstat(path.join(filesRoot, "SKILL.md"))).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(filesRoot, ".envrc"))).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(project, ".pi/skills/legacy/SKILL.md")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(project, ".pi/skills/legacy/.envrc")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(library, "sources")), { code: "ENOENT" });
});

// Priority negative test: retain failure; never change expectation to permit successful misuse.
test("S2 expired session commit must reject BEFORE mutation and leave normal reader usable", async () => {
  const b = await box(); const p = await proposal(b); const before = await rawTree(b.library);
  let revision!: StorageRevision;
  const escaped = await new StorageTransactions().run(b.library, false, async (s) => { assert.ok(s); revision = await s.capture(); return s; }, { requiresNativePlacement: false });
  const outcome = await escaped.commit(revision, p.bytes, p.replacements).then(() => "succeeded", (e: Error) => `rejected:${e.message}`);
  const after = await rawTree(b.library);
  const reader = await loadCatalog(b.library).then(() => "usable", (e: Error) => `rejected:${e.message}`);
  await evidence(b, "expired-session", { outcome, reader, before, after });
  assert.match(outcome, /^rejected:/, "expired session must not commit live bytes");
  assert.deepEqual(after, before); assert.equal(reader, "usable");
});

test("S2 valid callback-local session commit succeeds as expired-session control", async () => {
  const b = await box(); const p = await proposal(b); await kernel(b, p);
  assert.deepEqual(await readFile(b.file), p.replacements[0]!.files[0]!.bytes);
  assert.equal((await readSnapshotFiles(b.library, (await loadCatalog(b.library)).items[0]!))[0]!.sha256, digest(p.replacements[0]!.files[0]!.bytes));
  await evidence(b, "valid-session-control");
});

for (const kind of ["changed nonce", "lost lock"] as const) {
  test(`S2 session ${kind} must reject before live mutation and preserve bytes`, async () => {
    const b = await box(); const p = await proposal(b); const oldCatalog = await readFile(path.join(b.library, "catalog.json")); const oldFile = await readFile(b.file);
    let commitOutcome = "not attempted"; let live = false;
    const tx = new StorageTransactions({ checkpoint: (point) => { if (point === "old-renamed") live = true; } });
    await tx.run(b.library, false, async (s) => {
      assert.ok(s); const revision = await s.capture(); const lock = path.join(b.library, ".copi-transaction");
      if (kind === "changed nonce") {
        const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as Record<string, unknown>;
        owner.token = randomUUID(); await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner));
      } else await rename(lock, path.join(b.root, "displaced-lock"));
      commitOutcome = await s.commit(revision, p.bytes, p.replacements).then(() => "succeeded", (e: Error) => `rejected:${e.message}`);
    }, { requiresNativePlacement: false }).catch((e: Error) => { console.log(`owner cleanup refused: ${e.message}`); });
    await evidence(b, "lease-owner-boundary", { kind, commitOutcome, live, oldCatalog: oldCatalog.toString("base64"), oldFile: oldFile.toString("base64") });
    assert.match(commitOutcome, /^rejected:/); assert.equal(live, false);
    assert.deepEqual(await readFile(path.join(b.library, "catalog.json")), oldCatalog); assert.deepEqual(await readFile(b.file), oldFile);
  });
}

test("S2 forged StorageSession token cannot borrow another active lease", async () => {
  const b = await box(); const p = await proposal(b); const before = await rawTree(b.library);
  let outcome = "not attempted"; let live = false;
  await new StorageTransactions().run(b.library, false, async (s) => {
    assert.ok(s);
    const forged = new StorageSession(s.root, path.join(s.root, ".copi-transaction"), randomUUID(), (point) => { if (point === "old-renamed") live = true; });
    outcome = await forged.commit(await s.capture(), p.bytes, p.replacements).then(() => "succeeded", (e: Error) => `rejected:${e.message}`);
  }, { requiresNativePlacement: false });
  await evidence(b, "forged-session", { outcome, live, before });
  assert.match(outcome, /^rejected:/); assert.equal(live, false); assert.deepEqual(await rawTree(b.library), before);
});

test("S4 library root symlink replacement stops before outside mutation", async () => {
  const b = await box(); const p = await proposal(b);
  const outside = path.join(b.root, "outside-library"); await cp(b.library, outside, { recursive: true });
  const before = await rawTree(outside); let crossed = false;
  await assert.rejects(kernel(b, p, { checkpoint: async (point) => {
    if (point === "old-renamed") crossed = true;
    if (point === "before-swap") { await rename(b.library, path.join(b.root, "displaced-library")); await symlink(outside, b.library); }
  } }), /symbolic|unsafe|changed|directory/i);
  assert.equal(crossed, false); assert.deepEqual(await rawTree(outside), before);
  await evidence(b, "root-swap");
});

test("S5 kernel binds fixed approved bytes despite caller view/Buffer changes during staging", async () => {
  const b = await box(); const p = await proposal(b, { "SKILL.md": "apiKey=sk_live_acceptanceFIXED123456\n" });
  const fixed = Buffer.from(p.replacements[0]!.files[0]!.bytes);
  const review = prepareStorageReview(p.bytes, p.replacements);
  const approve = { confirmed: true, reviewId: review.reviewId, approvedSensitivePaths: [...readStorageReview(review).sensitivePaths] };
  (readStorageReview(review).sensitivePaths as string[]).length = 0;
  await new StorageTransactions({ checkpoint: (point) => {
    if (point === "stage-write") { p.bytes.fill(0); p.replacements[0]!.files[0]!.bytes.fill(0); approve.approvedSensitivePaths.length = 0; }
  } }).run(b.library, false, async (s) => s!.commit(await s!.capture(), p.bytes, p.replacements, { review, approval: approve }), { requiresNativePlacement: false });
  assert.deepEqual(await readFile(b.file), fixed);
  assert.equal((await readSnapshotFiles(b.library, b.item))[0]!.sha256, digest(fixed));
  await evidence(b, "kernel-fixed-bytes");
});
