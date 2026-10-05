import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { catalogBytes, importResource, loadCatalog, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { prepareStorageReview, readStorageReview, StorageTransactions, type StorageCheckpoint, type StorageReview } from "../src/storage-transaction.ts";
import { child, childExit, interruptedCode, kernelCommit, transactionFixture, waitForLine } from "./helpers/storage-transaction.ts";
import { sandbox } from "./helpers/sandbox.ts";

// Losing this guard would overwrite another process's group changes.
test("S3 saveCatalog rejects a stale loaded catalog even when names are unique", async (t) => {
  const box = await sandbox(t);
  await saveCatalog(box.libraryDir, { version: 1, items: [], groups: [] });
  const stale = await loadCatalog(box.libraryDir);
  const other = await loadCatalog(box.libraryDir);
  other.groups.push({ id: "other", name: "Other", itemIds: [] });
  await saveCatalog(box.libraryDir, other);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  stale.groups.push({ id: "stale", name: "Stale", itemIds: [] });
  await assert.rejects(saveCatalog(box.libraryDir, stale), /changed|conflict|revision/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
});

test("S6 generic catalog save cannot repair a manually changed checksum", async (t) => {
  const box = await sandbox(t);
  const file = path.join(box.sourceRoot, "safe.md");
  await writeFile(file, "safe");
  const item = await importResource(box.libraryDir, { id: "safe", kind: "instruction", source: "test", scope: "project", sourceRoot: box.sourceRoot, sourcePath: file, name: "safe", destination: { kind: "project", path: "AGENTS.md" } }, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const catalog = await loadCatalog(box.libraryDir);
  await writeFile(path.join(box.libraryDir, "items", item.id, "files", "safe.md"), "changed manually");
  catalog.items[0]!.files[0]!.sha256 = "f".repeat(64);
  await assert.rejects(saveCatalog(box.libraryDir, catalog), /checksum|changed|revision/i);
});

test("S2 library transaction kernel is available for explicit instance-scoped failure injection", async () => {
  const module = await import("../src/" + "storage-transaction.js").catch(() => undefined) as Record<string, unknown> | undefined;
  assert.equal(typeof module?.StorageTransactions, "function", "transaction kernel is missing");
});

const boundaries: StorageCheckpoint[] = ["stage-write", "stage-sync", "journal", "before-swap", "old-renamed", "new-renamed", "before-catalog", "catalog-renamed", "directory-sync", "committed"];
for (const boundary of boundaries) {
  test(`S2 fault at ${boundary} leaves exact old catalog/bytes, checked reader usable and no journal/history`, async (t) => {
    const box = await transactionFixture(t);
    const before = await readFile(path.join(box.libraryDir, "catalog.json"));
    let reached = false;
    await assert.rejects(kernelCommit(box, (point) => { if (point === boundary) { reached = true; throw new Error(`Injected ${point}`); } }), /Injected/);
    assert.ok(reached, `must reach the real ${boundary} boundary`);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
    assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
    assert.equal((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes.toString(), "old snapshot\n");
    assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "items"]);
    console.log(`S2 fault ${boundary}: reached=${reached}, old file+catalog restored, journal absent`);
  });
}
for (const boundary of ["journal", "old-renamed", "new-renamed", "catalog-renamed"] as const) {
  test(`S2 SIGKILL at ${boundary}: next normal reader recovers old or committed consistent bytes`, async (t) => {
    const box = await transactionFixture(t);
    const writer = child(box, interruptedCode(box, boundary));
    const exit = childExit(writer);
    await waitForLine(writer, "PAUSED");
    writer.kill("SIGKILL");
    const stopped = await exit;
    assert.equal(stopped.signal, "SIGKILL");
    const catalog = await loadCatalog(box.libraryDir);
    const expected = boundary === "catalog-renamed" ? "new snapshot\n" : "old snapshot\n";
    const files = await readSnapshotFiles(box.libraryDir, catalog.items[0]!);
    assert.equal(files[0]!.bytes.toString(), expected);
    assert.equal(catalog.items[0]!.files[0]!.sha256, createHash("sha256").update(expected).digest("hex"));
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
    console.log(`S2 interruption ${boundary}: signal=${stopped.signal}, recovered=${JSON.stringify(expected)}, SHA256=${files[0]!.sha256}`);
  });
}

test("S3 a reader cannot observe mixed state while a writer holds the multi-rename commit lock", async (t) => {
  const box = await transactionFixture(t);
  const writer = child(box, interruptedCode(box, "old-renamed"));
  const writerExit = childExit(writer);
  await waitForLine(writer, "PAUSED");
  let readCompleted = false;
  const read = loadCatalog(box.libraryDir).then((value) => { readCompleted = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(readCompleted, false);
  writer.kill("SIGKILL");
  await writerExit;
  const catalog = await read;
  assert.equal((await readSnapshotFiles(box.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "old snapshot\n");
  console.log("S3 concurrent reader: blocked during rename gap, returned recovered old state after SIGKILL");
});

test("S3 distinct cooperating processes serialize imports without losing either item", async (t) => {
  const box = await transactionFixture(t);
  const module = new URL("../src/catalog.js", import.meta.url).href;
  const code = (name: string) => `import {importResource} from ${JSON.stringify(module)}; await importResource(${JSON.stringify(box.libraryDir)},${JSON.stringify({ ...box.candidate, name })},{confirmed:true,groupIds:[]}); console.log('saved');`;
  const results = await Promise.all([childExit(child(box, code("Process A"))), childExit(child(box, code("Process B")))]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const catalog = await loadCatalog(box.libraryDir);
  assert.deepEqual(catalog.items.map((item) => item.name).sort(), ["Process A", "Process B", "Snapshot"]);
  for (const item of catalog.items) assert.equal((await readSnapshotFiles(box.libraryDir, item))[0]!.bytes.toString(), "old snapshot\n");
  console.log(`S3 cooperating import processes exits=${results.map((result) => result.code)}, all 3 items retained`);
});

test("S3 rollback never deletes externally changed bytes; reader fails closed with retained private recovery information", async (t) => {
  const box = await transactionFixture(t);
  await assert.rejects(kernelCommit(box, async (point) => {
    if (point === "new-renamed") { await writeFile(box.file, "manual external new bytes\n"); throw new Error("Injected with external edit"); }
  }), /could not safely recover|external change/i);
  assert.equal(await readFile(box.file, "utf8"), "manual external new bytes\n");
  await assert.rejects(loadCatalog(box.libraryDir), /external change|recovery/i);
  const journal = path.join(box.libraryDir, ".copi-transaction", "journal.json");
  assert.equal((await lstat(path.dirname(journal))).mode & 0o777, 0o700);
  assert.equal((await lstat(journal)).mode & 0o777, 0o600);
  console.log("S3 external bytes preserved; private journal retained and regular reader refused mixed state");
});

for (const corruption of ["unknown owner", "missing journal", "altered journal", "missing rollback", "altered rollback"] as const) {
  test(`S2 fail closed for ${corruption}, without deleting the unknown lock or changing bytes`, async (t) => {
    const box = await transactionFixture(t);
    const lock = path.join(box.libraryDir, ".copi-transaction");
    if (corruption === "unknown owner") { await mkdir(lock, { mode: 0o700 }); await writeFile(path.join(lock, "owner.json"), "{}"); }
    else {
      const writer = child(box, interruptedCode(box, "new-renamed"));
      const exit = childExit(writer);
      await waitForLine(writer, "PAUSED"); writer.kill("SIGKILL"); await exit;
      if (corruption === "missing journal") await rm(path.join(lock, "journal.json"));
      else if (corruption === "altered journal") await writeFile(path.join(lock, "journal.json"), '{}');
      else if (corruption === "missing rollback") await rm(path.join(lock, "old-0"), { recursive: true });
      else await writeFile(path.join(lock, "old-0", "files", "source.md"), "altered backup");
    }
    const file = await readFile(box.file);
    const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    const kernel = new StorageTransactions({ waitMilliseconds: 60 });
    await assert.rejects(kernel.run(box.libraryDir, false, async () => {}), /lock|journal|recovery|rollback|altered/i);
    assert.deepEqual(await readFile(box.file), file);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
    assert.ok(await lstat(lock));
  });
}

test("S3 revisions are library-bound and readers do not create absent libraries", async (t) => {
  const box = await transactionFixture(t);
  const absent = path.join(box.root, "absent");
  assert.deepEqual(await loadCatalog(absent), { version: 1, items: [], groups: [] });
  await assert.rejects(lstat(absent), { code: "ENOENT" });
  const other = path.join(box.root, "other");
  await saveCatalog(other, { version: 1, items: [], groups: [] });
  const kernel = new StorageTransactions();
  const revision = await kernel.run(box.libraryDir, false, async (session) => session!.capture());
  await assert.rejects(kernel.run(other, false, async (session) => session!.assertRevision(revision)), /changed|revision/i);
});

test("S3 stale initially absent catalog cannot erase a subsequently created library", async (t) => {
  const box = await sandbox(t);
  const stale = await loadCatalog(box.libraryDir);
  const other = await loadCatalog(box.libraryDir);
  other.groups.push({ id: "other", name: "Other", itemIds: [] });
  await saveCatalog(box.libraryDir, other);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  stale.groups.push({ id: "stale", name: "Stale", itemIds: [] });
  await assert.rejects(saveCatalog(box.libraryDir, stale), /changed|revision/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
});

test("S3 manual unrelated bytes changed DURING swap are detected, preserved, and own proposed content rolls back", async (t) => {
  const box = await transactionFixture(t);
  const other = await importResource(box.libraryDir, { ...box.candidate, name: "Other" }, { confirmed: true, groupIds: [] });
  assert.ok(other);
  box.next.items.push(other);
  const file = path.join(box.libraryDir, "items", other.id, "files", "source.md");
  await assert.rejects(kernelCommit(box, async (point) => { if (point === "new-renamed") await writeFile(file, "manual unrelated bytes\n"); }), /changed|external/i);
  assert.equal(await readFile(file, "utf8"), "manual unrelated bytes\n");
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

for (const point of ["rollback-displaced", "rollback-restored"] as const) {
  test(`S2 interruption during ${point} is restartable after catalog was already swapped`, async (t) => {
    const box = await transactionFixture(t);
    const code = interruptedCode(box, "catalog-renamed").replace("console.log('PAUSED'); setInterval(()=>{},1000); await new Promise(()=>{});", "throw new Error('Injected after catalog');").replace("if(point===", `if(point===${JSON.stringify(point)}) { console.log('ROLLBACK'); setInterval(()=>{},1000); await new Promise(()=>{}); } if(point===`);
    const writer = child(box, code);
    const exit = childExit(writer);
    try { await waitForLine(writer, "ROLLBACK"); } finally { writer.kill("SIGKILL"); }
    const result = await exit;
    assert.equal(result.signal, "SIGKILL");
    const catalog = await loadCatalog(box.libraryDir);
    assert.equal((await readSnapshotFiles(box.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "old snapshot\n");
    console.log(`S2 ${point}: SIGKILL recovery resumed rollback, old file/catalog consistent`);
  });
}

test("S3 detached stale catalog objects cannot bypass revision provenance and overwrite new group changes", async (t) => {
  const box = await transactionFixture(t);
  const stale = structuredClone(await loadCatalog(box.libraryDir));
  const current = await loadCatalog(box.libraryDir);
  current.groups.push({ id: "new", name: "New", itemIds: [] });
  await saveCatalog(box.libraryDir, current);
  const bytes = await readFile(path.join(box.libraryDir, "catalog.json"));
  stale.groups.push({ id: "stale", name: "Stale", itemIds: [] });
  await assert.rejects(saveCatalog(box.libraryDir, stale), /loaded|revision|changed/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), bytes);
});

test("S4 snapshot swap refuses an ancestor replaced with a symlink during commit; outside bytes never touched", async (t) => {
  const box = await transactionFixture(t);
  const outside = path.join(box.root, "outside-items");
  await mkdir(path.join(outside, box.item.id, "files"), { recursive: true, mode: 0o700 });
  const outsideFile = path.join(outside, box.item.id, "files", "source.md");
  await writeFile(outsideFile, "old snapshot\n", { mode: 0o600 });
  let crossed = false;
  await assert.rejects(kernelCommit(box, async (point) => {
    if (point === "old-renamed") crossed = true;
    if (point === "before-swap") {
      const {rename} = await import("node:fs/promises");
      await rename(path.join(box.libraryDir, "items"), path.join(box.root, "original-items"));
      await symlink(outside, path.join(box.libraryDir, "items"));
    }
  }), /symbolic|unsafe|recover|changed/i);
  assert.equal(crossed, false, "must stop before renaming any item through an outside symlink");
  assert.equal(await readFile(outsideFile, "utf8"), "old snapshot\n");
  assert.equal(await readFile(path.join(box.root, "original-items", box.item.id, "files", "source.md"), "utf8"), "old snapshot\n");
});

test("S5 low-level transaction entry cannot bypass inspection/individual secret approval", async (t) => {
  const box = await transactionFixture(t);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  box.files[0]!.bytes = Buffer.from("apiKey=sk_live_kernelrawsecret123456\n");
  box.next.items[0]!.files[0]!.sha256 = createHash("sha256").update(box.files[0]!.bytes).digest("hex");
  await assert.rejects(kernelCommit(box), /approval|inspection/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

test("S1/S6 raw transaction metadata cannot introduce wrong checksums or silently repair corruption", async (t) => {
  const box = await transactionFixture(t);
  const kernel = new StorageTransactions();
  const wrong = structuredClone(box.catalog);
  wrong.items[0]!.files[0]!.sha256 = "f".repeat(64);
  await assert.rejects(kernel.run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), Buffer.from(JSON.stringify(wrong)))), /checksum|bytes|snapshot/i);
  await writeFile(box.file, "manual corrupted\n");
  wrong.items[0]!.files[0]!.sha256 = createHash("sha256").update("manual corrupted\n").digest("hex");
  await assert.rejects(kernel.run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), Buffer.from(JSON.stringify(wrong)))), /checksum|bytes|snapshot/i);
  assert.equal(await readFile(box.file, "utf8"), "manual corrupted\n");
});

test("S5 generalized kernel accepts only an authentic byte-bound review with matching per-item/file approvals", async (t) => {
  const box = await transactionFixture(t);
  const secret = Buffer.from("apiKey=sk_live_kernelapproved123456\n");
  box.files[0]!.bytes = secret;
  box.next.items[0]!.files[0]!.sha256 = createHash("sha256").update(secret).digest("hex");
  const bytes = catalogBytes(box.next);
  const replacements = [{ itemId: box.item.id, files: box.files }];
  const review = prepareStorageReview(bytes, replacements);
  const approvedSensitivePaths = [`${box.item.id}/source.md`];
  assert.deepEqual(readStorageReview(review).sensitivePaths, approvedSensitivePaths);
  const approval = { confirmed: true, reviewId: review.reviewId, approvedSensitivePaths };
  for (const invalid of [{ ...approval, confirmed: false }, { ...approval, reviewId: "another-review" }, { ...approval, approvedSensitivePaths: [] }]) {
    await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), bytes, replacements, { review, approval: invalid })), /approval|review/i);
  }
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), bytes, replacements, { review: {reviewId:review.reviewId} as StorageReview, approval })), /review/i);
  const wrongBytes = [{ itemId: box.item.id, files: [{ ...box.files[0]!, bytes: Buffer.from("apiKey=sk_live_unreviewed123456\n") }] }];
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), bytes, wrongBytes, { review, approval })), /review|bytes/i);
  (readStorageReview(review).sensitivePaths as string[]).length = 0;
  const expected = Buffer.from(secret);
  const kernel = new StorageTransactions({ checkpoint: (point) => { if (point === "stage-write") { secret.fill(0); bytes.fill(0); } } });
  await kernel.run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), bytes, replacements, { review, approval }));
  assert.deepEqual(await readFile(box.file), expected);
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes, expected);
});

for (const boundary of ["stage-write", "stage-sync"] as const) {
  test(`S2 failure at catalog ${boundary} (after content stage) restores old bytes/catalog`, async (t) => {
    const box = await transactionFixture(t);
    const before = await readFile(path.join(box.libraryDir, "catalog.json"));
    let visits = 0;
    await assert.rejects(kernelCommit(box, (point) => { if (point === boundary && ++visits === 2) throw new Error("Injected catalog stage"); }), /Injected catalog stage/);
    assert.equal(visits, 2);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
    assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
    console.log(`S2 catalog ${boundary}: real boundary invocation ${visits}, exact old state retained`);
  });
}

test("S3 two editing processes preparing the same revision permit one commit, refuse the other, and retain the winner", async (t) => {
  const box = await transactionFixture(t);
  const module = new URL("../src/resource-mutations.js", import.meta.url).href;
  const code = (value: string) => `import {prepareSavedEdit,prepareSavedChange,commitSavedChange} from ${JSON.stringify(module)};
const edit=await prepareSavedEdit(${JSON.stringify(box.libraryDir)},${JSON.stringify(box.item.id)},'source.md');
const change=await prepareSavedChange(edit,Buffer.from(${JSON.stringify(value)})); console.log('READY');
await new Promise(resolve=>process.stdin.once('data',resolve));
await commitSavedChange(change,{confirmed:true,reviewId:change.reviewId,approvedSensitivePaths:[]}); console.log('COMMITTED'); process.stdin.destroy();`;
  const a = child(box, code("process A\n")); const b = child(box, code("process B\n"));
  const ae = childExit(a); const be = childExit(b);
  try {
    await Promise.all([waitForLine(a, "READY"), waitForLine(b, "READY")]);
    a.stdin.write("go"); b.stdin.write("go");
    const results = await Promise.all([ae, be]);
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.match(results.find((result) => result.code === 1)!.output, /changed|revision/i);
    const expected = results[0]!.code === 0 ? "process A\n" : "process B\n";
    assert.equal((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes.toString(), expected);
    console.log(`S3 editing process exits=${results.map((result) => result.code)}, winning bytes=${JSON.stringify(expected)}`);
  } finally { a.kill(); b.kill(); }
});

test("S4 new private descriptors cannot be registered by catalog-only save", async (t) => {
  const box = await transactionFixture(t);
  const file = path.join(path.dirname(box.file), ".envrc");
  await writeFile(file, "manually installed private file");
  const catalog = await loadCatalog(box.libraryDir);
  catalog.items[0]!.files.push({ path: ".envrc", mode: 0o600, sha256: createHash("sha256").update("manually installed private file").digest("hex") });
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  await assert.rejects(saveCatalog(box.libraryDir, catalog), /private|excluded/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  assert.equal(await readFile(file, "utf8"), "manually installed private file");
});

test("S2 interruption after journal removal still recovers the finalized consistent state and cleans private data", async (t) => {
  const box = await transactionFixture(t);
  const writer = child(box, interruptedCode(box, "finalized" as StorageCheckpoint));
  const exit = childExit(writer);
  try { await waitForLine(writer, "PAUSED"); } finally { writer.kill("SIGKILL"); }
  const stopped = await exit;
  assert.equal(stopped.signal, "SIGKILL");
  const catalog = await loadCatalog(box.libraryDir);
  assert.equal((await readSnapshotFiles(box.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "new snapshot\n");
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "items"]);
});

test("S1/S5 externally altered staged bytes cannot become an unreviewed saved secret", async (t) => {
  const box = await transactionFixture(t);
  const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  let injected = false;
  await assert.rejects(kernelCommit(box, async (point, root) => {
    if (point === "stage-sync" && !injected) {
      injected = true;
      await writeFile(path.join(root, ".copi-transaction", "next-0", "files", "source.md"), "apiKey=sk_live_unreviewedstage123456\n");
    }
  }), /staged|fixed|bytes|changed|inspection/i);
  assert.ok(injected);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

test("S1 altered staged catalog is detected before any live snapshot rename", async (t) => {
  const box = await transactionFixture(t);
  let count = 0; let crossed = false;
  await assert.rejects(kernelCommit(box, async (point, root) => {
    if (point === "stage-write" && ++count === 2) await writeFile(path.join(root, ".copi-transaction", "next-catalog"), catalogBytes(box.catalog));
    if (point === "old-renamed") crossed = true;
  }), /staged|catalog|changed/i);
  assert.equal(crossed, false);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

for (const boundary of ["stage-sync", "before-catalog"] as const) {
  test(`S2 multi-file replacement fault at ${boundary} retains the complete old snapshot`, async (t) => {
    const box = await transactionFixture(t);
    const additional = Buffer.from("second new file\n");
    box.files.push({ path: "nested/new.md", mode: 0o600, bytes: additional });
    box.next.items[0]!.files.push({ path: "nested/new.md", mode: 0o600, sha256: createHash("sha256").update(additional).digest("hex") });
    const before = await readFile(path.join(box.libraryDir, "catalog.json"));
    let count = 0;
    await assert.rejects(kernelCommit(box, (point) => { if (point === boundary && (boundary === "before-catalog" || ++count === 2)) throw new Error("Injected multi-file failure"); }), /Injected multi-file/);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
    const files = await readSnapshotFiles(box.libraryDir, box.item);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.bytes.toString(), "old snapshot\n");
    await assert.rejects(lstat(path.join(path.dirname(box.file), "nested", "new.md")), { code: "ENOENT" });
    console.log(`S2 multi-file ${boundary}: old 1-file snapshot intact, no 2nd staged file leaked`);
  });
}

for (const ownerKind of ["active", "unknown host"] as const) {
  test(`S3 ${ownerKind} owner fails closed without deleting its lock`, async (t) => {
    const box = await transactionFixture(t);
    const lock = path.join(box.libraryDir, ".copi-transaction");
    await mkdir(lock, { mode: 0o700 });
    const { hostname } = await import("node:os");
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({version:1,pid:process.pid,host:ownerKind === "active" ? hostname() : "unknown-machine",token:randomUUID()}), {mode:0o600});
    await assert.rejects(new StorageTransactions({waitMilliseconds:60}).run(box.libraryDir, false, async () => {}), /active process|unknown host|unsafe/i);
    assert.ok(await lstat(lock));
    assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
  });
}

test("S3 a valid dead transaction copied into a different library is not replayed or deleted", async (t) => {
  const a = await transactionFixture(t); const b = await transactionFixture(t);
  const writer = child(a, interruptedCode(a, "new-renamed"));
  const exit = childExit(writer);
  await waitForLine(writer, "PAUSED"); writer.kill("SIGKILL"); await exit;
  const lock = path.join(b.libraryDir, ".copi-transaction");
  await cp(path.join(a.libraryDir, ".copi-transaction"), lock, { recursive: true });
  const before = await readFile(path.join(b.libraryDir, "catalog.json"));
  await assert.rejects(new StorageTransactions({waitMilliseconds:60}).run(b.libraryDir, false, async () => {}), /journal|recovery/i);
  assert.deepEqual(await readFile(path.join(b.libraryDir, "catalog.json")), before);
  assert.equal(await readFile(b.file, "utf8"), "old snapshot\n");
  assert.ok(await lstat(lock));
  assert.equal((await readSnapshotFiles(a.libraryDir, (await loadCatalog(a.libraryDir)).items[0]!))[0]!.bytes.toString(), "old snapshot\n");
});

test("S3 raw kernel cannot bypass name uniqueness and make the saved library unusable", async (t) => {
  const box = await transactionFixture(t);
  const other = await importResource(box.libraryDir, { ...box.candidate, name: "Other" }, { confirmed: true, groupIds: [] });
  assert.ok(other);
  box.next.items.push({ ...other, name: " SNAPSHOT " });
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  await assert.rejects(kernelCommit(box), /duplicate|conflict/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

test("S3 late writes to the moved old snapshot inode are preserved, never deleted by successful cleanup", async (t) => {
  const box = await transactionFixture(t);
  const retained = path.join(box.libraryDir, ".copi-transaction", "old-0", "files", "source.md");
  await assert.rejects(kernelCommit(box, async (point) => {
    if (point === "old-renamed") await writeFile(retained, "external old-inode bytes\n");
  }), /changed|altered|recover|external/i);
  assert.equal(await readFile(retained, "utf8"), "external old-inode bytes\n");
  await assert.rejects(loadCatalog(box.libraryDir), /recovery|external/i);
});

test("S2 failure while old catalog is held restores exact old catalog and snapshot", async (t) => {
  const box = await transactionFixture(t);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  let reached = false;
  await assert.rejects(kernelCommit(box, (point) => { if (point === ("catalog-held" as StorageCheckpoint)) { reached = true; throw new Error("Injected catalog hold"); } }), /Injected catalog hold/);
  assert.ok(reached);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  assert.equal((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes.toString(), "old snapshot\n");
});

test("S3 a manually modified held catalog is preserved instead of overwritten or removed", async (t) => {
  const box = await transactionFixture(t);
  const retained = path.join(box.libraryDir, ".copi-transaction", "held-catalog");
  const external = Buffer.from('{"manually":"modified original catalog inode"}\n');
  let reached = false;
  await assert.rejects(kernelCommit(box, async (point) => { if (point === ("catalog-held" as StorageCheckpoint)) { reached = true; await writeFile(retained, external); } }), /changed|external|recover|catalog/i);
  assert.ok(reached);
  assert.deepEqual(await readFile(retained), external);
  await assert.rejects(loadCatalog(box.libraryDir), /external|recovery/i);
});

test("S3 actual EEXIST during exclusive catalog installation preserves the manually recreated catalog", async (t) => {
  const box = await transactionFixture(t);
  const external = Buffer.from(' {"external":"catalog recreated while writer held old inode"}\n');
  let reached = false;
  await assert.rejects(kernelCommit(box, async (point) => {
    if (point === "catalog-held") { reached = true; await writeFile(path.join(box.libraryDir, "catalog.json"), external); }
  }), (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.equal((error.cause.errors[0] as NodeJS.ErrnoException).code, "EEXIST", "must reach the real fs.link exclusive-create failure");
    return true;
  });
  assert.ok(reached);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), external);
  console.log("S3 catalog hold: actual fs.link EEXIST, external catalog bytes preserved, journal retained");
});

test("S2 SIGKILL during catalog hold restores checked old catalog and all snapshot bytes", async (t) => {
  const box = await transactionFixture(t);
  const writer = child(box, interruptedCode(box, "catalog-held"));
  const exit = childExit(writer);
  await waitForLine(writer, "PAUSED"); writer.kill("SIGKILL");
  assert.equal((await exit).signal, "SIGKILL");
  const catalog = await loadCatalog(box.libraryDir);
  assert.equal((await readSnapshotFiles(box.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "old snapshot\n");
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "items"]);
  console.log("S2 SIGKILL catalog-held: absent live catalog recovered to exact checked old state");
});

test("S3 late writes to the displaced new snapshot during rollback are preserved, not cleaned up", async (t) => {
  const box = await transactionFixture(t);
  const retained = path.join(box.libraryDir, ".copi-transaction", "displaced-0", "files", "source.md");
  await assert.rejects(kernelCommit(box, async (point) => {
    if (point === "before-catalog") throw new Error("Injected before catalog");
    if (point === "rollback-restored") await writeFile(retained, "external displaced-inode bytes\n");
  }), /recover|external/i);
  assert.equal(await readFile(retained, "utf8"), "external displaced-inode bytes\n");
  await assert.rejects(loadCatalog(box.libraryDir), /external|recovery/i);
});

test("S2 SIGKILL while rollback holds the catalog resumes the checked old state", async (t) => {
  const box = await transactionFixture(t);
  const code = interruptedCode(box, "catalog-renamed").replace("console.log('PAUSED'); setInterval(()=>{},1000); await new Promise(()=>{});", "throw new Error('Injected after catalog');").replace("if(point===", "if(point==='rollback-catalog-held') { console.log('ROLLBACK'); setInterval(()=>{},1000); await new Promise(()=>{}); } if(point===");
  const writer = child(box, code);
  const exit = childExit(writer);
  await waitForLine(writer, "ROLLBACK"); writer.kill("SIGKILL");
  assert.equal((await exit).signal, "SIGKILL");
  const catalog = await loadCatalog(box.libraryDir);
  assert.equal((await readSnapshotFiles(box.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "old snapshot\n");
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "items"]);
});

test("S2 a forged session with the real nonce still has no issued lease", async (t) => {
  const box = await transactionFixture(t);
  const before = await readFile(path.join(box.libraryDir, "catalog.json"));
  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const lock = path.join(session.root, ".copi-transaction");
    const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as { token: string };
    const { StorageSession } = await import("../src/storage-transaction.ts");
    const forged = new StorageSession(session.root, lock, owner.token);
    await assert.rejects(forged.commit(await session.capture(), catalogBytes(box.next), [{ itemId: box.item.id, files: box.files }]), /invalid|session|lease/i);
  });
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});

for (const boundary of ["stage-sync", "journal", "before-swap"] as const) {
  test(`S2 owner nonce changed at ${boundary} is detected before any live rename`, async (t) => {
    const box = await transactionFixture(t);
    const catalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    let changed = false; let live = false;
    await assert.rejects(kernelCommit(box, async (point, root) => {
      if (point === "old-renamed") live = true;
      if (point === boundary && !changed) {
        changed = true;
        const file = path.join(root, ".copi-transaction", "owner.json");
        const owner = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        owner.token = randomUUID();
        await writeFile(file, JSON.stringify(owner));
      }
    }), /owner|session|lease/i);
    assert.ok(changed); assert.equal(live, false);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), catalog);
    assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
  });
}

test("S2 an externally recreated lock with identical owner fields is not the issued lock", async (t) => {
  const box = await transactionFixture(t);
  let live = false;
  await assert.rejects(kernelCommit(box, async (point, root) => {
    if (point === "old-renamed") live = true;
    if (point === "journal") {
      const lock = path.join(root, ".copi-transaction");
      const owner = await readFile(path.join(lock, "owner.json"));
      const { rename } = await import("node:fs/promises");
      await rename(lock, path.join(box.root, "held-issued-lock"));
      await mkdir(lock, { mode: 0o700 });
      await writeFile(path.join(lock, "owner.json"), owner, { mode: 0o600 });
    }
  }), /lock|directory|changed|lease/i);
  assert.equal(live, false);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
  assert.ok(await lstat(path.join(box.root, "held-issued-lock")));
});

test("S2 callback expiry also revokes capture and recovery entry points", async (t) => {
  const box = await transactionFixture(t);
  const session = await new StorageTransactions().run(box.libraryDir, false, async (issued) => { assert.ok(issued); return issued; });
  await assert.rejects(session.capture(), /expired|session|lease/i);
  await assert.rejects(session.recover(true), /expired|session|lease/i);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  assert.equal((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes.toString(), "old snapshot\n");
});

test("S2 F5 callback closes while commit waits after old rename: no half-update or reader block", { timeout: 15_000 }, async (t) => {
  const box = await transactionFixture(t);
  const beforeCatalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const beforeBytes = await readFile(box.file);
  let atLive!: () => void; let resume!: () => void;
  const reached = new Promise<void>((resolve) => { atLive = resolve; });
  const suspended = new Promise<void>((resolve) => { resume = resolve; });
  let pending: Promise<{ success: boolean; error?: string }> | undefined;
  const tx = new StorageTransactions({ checkpoint: async (point) => {
    if (point === "old-renamed") { atLive(); await suspended; }
  } });
  await tx.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    pending = session.commit(await session.capture(), catalogBytes(box.next), [{ itemId: box.item.id, files: box.files }])
      .then(() => ({ success: true }), (error: Error) => ({ success: false, error: error.message }));
    await reached;
  });
  // Same ordering as the independent F5: only resume after run has returned.
  resume();
  assert.ok(pending);
  const outcome = await pending;
  const catalog = await loadCatalog(box.libraryDir);
  const files = await readSnapshotFiles(box.libraryDir, catalog.items[0]!);
  const liveBytes = await readFile(box.file);
  assert.ok(liveBytes.equals(beforeBytes) || liveBytes.equals(box.bytes));
  assert.deepEqual(files[0]!.bytes, liveBytes);
  assert.equal(files[0]!.sha256, createHash("sha256").update(liveBytes).digest("hex"));
  if (liveBytes.equals(beforeBytes)) assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), beforeCatalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  const evidence = { outcome, reader: "usable", liveHex: liveBytes.toString("hex"), sha256: files[0]!.sha256, oldHex: beforeBytes.toString("hex"), newHex: box.bytes.toString("hex") };
  const evidencePath = path.join(process.env.TMPDIR!, `copi-f5-${randomUUID()}.json`);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`F5 raw evidence: ${evidencePath} ${JSON.stringify(evidence)}`);
});

test("S5 raw storage approval requires boolean true as well as the authenticated review", async (t) => {
  const box = await transactionFixture(t);
  box.files[0]!.bytes = Buffer.from("apiKey=sk_live_kernelapproved123456\n");
  box.next.items[0]!.files[0]!.sha256 = createHash("sha256").update(box.files[0]!.bytes).digest("hex");
  const bytes = catalogBytes(box.next); const replacements = [{itemId:box.item.id,files:box.files}];
  const review = prepareStorageReview(bytes, replacements);
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => session!.commit(await session!.capture(), bytes, replacements, {review,approval:{confirmed:"false" as unknown as boolean,reviewId:review.reviewId,approvedSensitivePaths:readStorageReview(review).sensitivePaths}})), /approval|confirm/i);
  assert.equal(await readFile(box.file, "utf8"), "old snapshot\n");
});
