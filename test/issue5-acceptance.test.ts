import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogBytes, importPreparedResource, importResource, loadCatalog, prepareResource, readPreparedResource, readSnapshotFiles, saveCatalog, saveNameChanges } from "../src/catalog.ts";
import { executeApply, planApply } from "../src/apply.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { changeSavedDestination, commitSavedChange, prepareSavedChange, prepareSavedEdit, prepareSavedReplacement, readSavedChange, readSavedEdit } from "../src/resource-mutations.ts";
import { prepareStorageReview, readStorageReview, StorageSession, StorageTransactions, type StorageCheckpoint, type StorageRevision } from "../src/storage-transaction.ts";
import { approval, box, child, digest, evidence, interrupted, kernel, modules, proposal, rawTree, wait } from "./helpers/issue5-acceptance.ts";

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
  const b = await box({ "SKILL.md": `apiKey=${oldSecret}\n${"unchanged\n".repeat(20)}tail old\n`, "obsolete.md": "remove\n" });
  const before = await loadCatalog(b.library);
  await writeFile(path.join(b.sourcePath, "SKILL.md"), `apiKey=${newSecret}\n${"unchanged\n".repeat(20)}tail new\n`);
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
  assert.match(view.diffs.find((d) => d.path === "SKILL.md")!.diff, /tail old[\s\S]*tail new/);
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

test("S5 direct kernel secret approval and catalog-only descriptor registration cannot bypass inspection", async () => {
  const b = await box(); const before = await rawTree(b.library);
  const p = await proposal(b, { "SKILL.md": "apiKey=sk_live_acceptanceKERNEL123456\n" });
  await assert.rejects(kernel(b, p), /approval|inspection/i);
  const review = prepareStorageReview(p.bytes, p.replacements);
  const approve = { confirmed: true, reviewId: review.reviewId, approvedSensitivePaths: readStorageReview(review).sensitivePaths };
  for (const bad of [ { ...approve, confirmed: "yes" as unknown as boolean }, { ...approve, reviewId: "other" }, { ...approve, approvedSensitivePaths: [] }, { ...approve, approvedSensitivePaths: [...approve.approvedSensitivePaths, ...approve.approvedSensitivePaths] } ]) {
    await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), p.bytes, p.replacements, { review, approval: bad })), /approval|review/i);
  }
  assert.deepEqual(await rawTree(b.library), before);
  const newPath = path.join(path.dirname(b.file), "manually-added.md");
  const secret = "apiKey=sk_live_acceptanceDESCRIPTOR123456\n";
  await writeFile(newPath, secret);
  const catalog = await loadCatalog(b.library);
  catalog.items[0]!.files.push({ path: "manually-added.md", mode: 0o600, sha256: digest(secret) });
  await assert.rejects(saveCatalog(b.library, catalog), /approval|inspection/i);
  await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), catalogBytes(catalog))), /approval|inspection/i);
  assert.equal(await readFile(newPath, "utf8"), secret);
  await evidence(b, "kernel-secret-rejections");
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
  const revision = await new StorageTransactions().run(b.library, false, async (s) => s!.capture());
  const current = await loadCatalog(b.library); current.groups[0]!.name = "Winner"; await saveCatalog(b.library, current);
  const before = await rawTree(b.library);
  stale.groups[0]!.name = "Stale";
  await assert.rejects(saveCatalog(b.library, stale), /changed|revision/i);
  await assert.rejects(saveCatalog(b.library, structuredClone(current)), /detached|original|revision/i);
  await assert.rejects(saveNameChanges(b.library, structuredClone(current), current), /original|revision/i);
  await assert.rejects(saveCatalog(other.library, current), /changed|revision/i);
  await assert.rejects(new StorageTransactions().run(other.library, false, async (s) => s!.assertRevision(revision!)), /changed|revision/i);
  assert.deepEqual(await rawTree(b.library), before);
});

for (const unsafe of ["", "/absolute", "..", "a/../b", "a\\b", "a\0b", "a//b", "a/", "auth/x", ".envrc", "x/.env-production", "cache/x"]) {
  test(`S4 all destination entry points reject ${JSON.stringify(unsafe)}`, async () => {
    const b = await box(); const before = await rawTree(b.library);
    const destination = { kind: "project" as const, path: unsafe };
    await assert.rejects(changeSavedDestination(b.library, b.item.id, destination), /unsafe|private|excluded/i);
    await assert.rejects(importResource(b.library, { ...b.candidate, name: "Different", destination }, { confirmed: true, groupIds: [] }), /destination/i);
    const c = await loadCatalog(b.library); c.items[0]!.destination = destination;
    await assert.rejects(saveCatalog(b.library, c), /destination|catalog/i);
    await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), Buffer.from(JSON.stringify(c)))), /destination|catalog/i);
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
  await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), catalogBytes(c))), /reference|global-only/i);
  assert.deepEqual(await rawTree(b.library), held);
});

for (const corruption of ["checksum", "file symlink", "directory symlink", "item symlink"] as const) {
  test(`S6 ${corruption}: reasoned rejection across reader/edit/destination/catalog/kernel`, async () => {
    const b = await box(); const c = await loadCatalog(b.library);
    if (corruption === "checksum") await writeFile(b.file, "external corrupted\n");
    else {
      const target = corruption === "file symlink" ? b.file : corruption === "directory symlink" ? path.dirname(b.file) : path.dirname(path.dirname(b.file));
      const held = path.join(b.root, "outside-copy"); await rename(target, held); await symlink(held, target);
    }
    const before = await rawTree(b.library);
    const error = /checksum|symbolic|unsafe/i;
    await assert.rejects(readSnapshotFiles(b.library, b.item), error);
    await assert.rejects(prepareSavedEdit(b.library, b.item.id, "SKILL.md"), error);
    await assert.rejects(changeSavedDestination(b.library, b.item.id, { kind: "project", path: "safe/new" }), error);
    c.items[0]!.files[0]!.sha256 = digest("external corrupted\n");
    await assert.rejects(saveCatalog(b.library, c), error);
    await assert.rejects(new StorageTransactions().run(b.library, false, async (s) => s!.commit(await s!.capture(), catalogBytes(c))), error);
    assert.deepEqual(await rawTree(b.library), before);
    await evidence(b, "corruption-rejected", { corruption });
  });
}

test("S6 wrong next checksum is rejected before mutation", async () => {
  const b = await box(); const p = await proposal(b); const before = await rawTree(b.library);
  p.next.items[0]!.files[0]!.sha256 = "f".repeat(64); p.bytes = catalogBytes(p.next);
  await assert.rejects(kernel(b, p), /checksums|bytes|snapshot/i);
  assert.deepEqual(await rawTree(b.library), before);
});

for (const boundary of ["stage-write", "stage-sync", "journal", "old-renamed", "new-renamed", "catalog-held", "catalog-renamed", "directory-sync", "committed"] as StorageCheckpoint[]) {
  test(`S2 real multi-file transaction fault ${boundary}: exact old state and usable reader`, async () => {
    const b = await box({ "SKILL.md": "old A\n", "nested/second.md": "old B\n" });
    const p = await proposal(b, { "SKILL.md": "new A\n", "nested/second.md": "new B\n", "added.md": "new C\n" });
    const before = await evidence(b, "fault-before", { boundary }); let count = 0; const reached: string[] = [];
    await assert.rejects(kernel(b, p, { checkpoint: (point) => { reached.push(point); if (point === boundary && (++count === (boundary.startsWith("stage-") ? 4 : 1))) throw new Error(`independent fault ${boundary}`); } }), /independent fault/i);
    assert.equal(count, boundary.startsWith("stage-") ? 4 : 1);
    assert.deepEqual(await rawTree(b.library), before);
    assert.equal((await readSnapshotFiles(b.library, (await loadCatalog(b.library)).items[0]!)).length, 2);
    await evidence(b, "fault-after", { boundary, count, reached });
  });
}

test("S2 real file-stage failure (second file): no leaked partial file", async () => {
  const b = await box(); const p = await proposal(b, { "SKILL.md": "new\n", "z.md": "second\n" });
  const before = await rawTree(b.library); let count = 0;
  await assert.rejects(kernel(b, p, { checkpoint: (point) => { if (point === "stage-sync" && ++count === 2) throw new Error("second-file failure"); } }), /second-file/);
  assert.equal(count, 2); assert.deepEqual(await rawTree(b.library), before);
  await evidence(b, "second-file-fault", { count });
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
    await assert.rejects(new StorageTransactions({ waitMilliseconds: 40 }).run(b.library, false, async () => {}), /owner|active|host|lock/i);
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
    else await writeFile(path.join(lock, "old-0", "files", "SKILL.md"), "tampered backup\n");
    const before = await evidence(b, "damaged-journal-before", { corruption });
    await assert.rejects(loadCatalog(b.library), /journal|rollback|altered|unknown/i);
    assert.deepEqual(await rawTree(b.library), before);
  });
}

for (const retained of ["old snapshot", "held catalog", "recreated catalog", "displaced snapshot"] as const) {
  test(`S3 late external ${retained}: bytes retained, never deleted by cleanup`, async () => {
    const b = await box(); const p = await proposal(b); const external = Buffer.from("external retained bytes\n"); let target = ""; let reached = false;
    await assert.rejects(kernel(b, p, { checkpoint: async (point, root) => {
      const lock = path.join(root, ".copi-transaction");
      if (retained === "displaced snapshot" && point === "before-catalog") throw new Error("trigger rollback");
      if ((retained === "old snapshot" && point === "old-renamed") || (retained === "held catalog" && point === "catalog-held") || (retained === "recreated catalog" && point === "catalog-held") || (retained === "displaced snapshot" && point === "rollback-restored")) {
        target = retained === "old snapshot" ? path.join(lock, "old-0", "files", "SKILL.md") : retained === "displaced snapshot" ? path.join(lock, "displaced-0", "files", "SKILL.md") : retained === "held catalog" ? path.join(lock, "held-catalog") : path.join(root, "catalog.json");
        reached = true; await writeFile(target, external);
      }
    } }), /recover|external|changed/i);
    assert.ok(reached); assert.deepEqual(await readFile(target), external);
    await assert.rejects(loadCatalog(b.library), /external|recovery/i);
    await evidence(b, "late-inode-retained", { retained, target });
  });
}

test("S4 root/ancestor symbolic-link swap stops before live outside mutation", async () => {
  const b = await box(); const p = await proposal(b); const outside = path.join(b.root, "outside-items");
  await mkdir(path.join(outside, b.item.id, "files"), { recursive: true });
  await writeFile(path.join(outside, b.item.id, "files", "SKILL.md"), "outside sentinel\n");
  const before = await rawTree(outside); let crossed = false;
  await assert.rejects(kernel(b, p, { checkpoint: async (point) => {
    if (point === "old-renamed") crossed = true;
    if (point === "before-swap") { await rename(path.join(b.library, "items"), path.join(b.root, "original-items")); await symlink(outside, path.join(b.library, "items")); }
  } }), /symbolic|unsafe|recover/i);
  assert.equal(crossed, false); assert.deepEqual(await rawTree(outside), before);
  await evidence(b, "ancestor-swap");
});

test("S4 legacy private descriptors stay readable but are skipped by apply", async () => {
  const b = await box(); const c = await loadCatalog(b.library);
  await writeFile(path.join(path.dirname(b.file), ".envrc"), "private legacy bytes\n");
  c.items[0]!.files.push({ path: ".envrc", mode: 0o600, sha256: digest("private legacy bytes\n") });
  await writeFile(path.join(b.library, "catalog.json"), catalogBytes(c));
  assert.equal((await readSnapshotFiles(b.library, b.item)).length, 2);
  const project = path.join(b.root, "target"); await mkdir(project);
  const plan = await planApply(b.library, "independent-team", project);
  assert.ok(plan.warnings.some((w) => w.code === "private-path-skipped"));
  assert.ok(!plan.files.some((f) => f.path.includes(".env")));
  await executeApply(b.library, plan, {});
  await assert.rejects(lstat(path.join(project, ".pi/skills/independent/.envrc")), { code: "ENOENT" });
});

// Priority negative test: retain failure; never change expectation to permit successful misuse.
test("S2 expired session commit must reject BEFORE mutation and leave normal reader usable", async () => {
  const b = await box(); const p = await proposal(b); const before = await rawTree(b.library);
  let revision!: StorageRevision;
  const escaped = await new StorageTransactions().run(b.library, false, async (s) => { assert.ok(s); revision = await s.capture(); return s; });
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
    }).catch((e: Error) => { console.log(`owner cleanup refused: ${e.message}`); });
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
  });
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
  } }).run(b.library, false, async (s) => s!.commit(await s!.capture(), p.bytes, p.replacements, { review, approval: approve }));
  assert.deepEqual(await readFile(b.file), fixed);
  assert.equal((await readSnapshotFiles(b.library, b.item))[0]!.sha256, digest(fixed));
  await evidence(b, "kernel-fixed-bytes");
});
