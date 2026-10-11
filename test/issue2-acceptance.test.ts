import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeApply, planApply } from "../src/apply.ts";
import { assertModernCatalog, importPreparedResource, importResource, listSnapshots, loadCatalog as loadStoredCatalog, newCatalog, prepareResource, readSnapshotFiles, renameSavedItem, saveCatalog, saveNameChanges } from "../src/catalog.ts";
import { createGroup, renameGroup, setGroupItems } from "../src/groups.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { findNameConflicts, nameKey } from "../src/names.ts";
import { foldCaseUnicode17 } from "../src/unicode-case-folding.ts";
import type { Catalog } from "../src/types.ts";
import { acceptanceBox, add, assertOnlyNames, candidate, choose, cli, cliPipe, fixtureImportOptions, legacy, realPty, renameSteps, secret, treeBytes, wizardArgv, type AcceptanceBox, type Action } from "./helpers/issue2-acceptance.ts";

async function loadCatalog(libraryDir: string): Promise<Catalog> {
  const catalog = await loadStoredCatalog(libraryDir);
  assertModernCatalog(catalog);
  return catalog;
}

// Approved supplement, not expectations computed by the product implementation.
const boundaries: readonly [string, string, boolean][] = [
  [" A ", "a", true], ["Ａ", "A", true], ["①", "1", true],
  ["ｶﾀｶﾅ", "カタカナ", true], ["é", "e\u0301", true], ["é", "e", false],
  ["Straße", "STRASSE", true], ["σ", "ς", true], ["I", "i", true],
  ["I", "ı", false], ["İ", "i", false], ["İ", "i\u0307", true],
];
for (const [left, right, same] of boundaries) {
  test(`N1/N2 approved boundary ${JSON.stringify(left)} versus ${JSON.stringify(right)} = ${same}`, async () => {
    assert.equal(nameKey(left) === nameKey(right), same);
    const box = await acceptanceBox();
    await add(box, left);
    const input = await candidate(box, right, "subagent");
    const prepared = await prepareResource(input);
    const inspection = await inspectPreparedResource(prepared);
    const options = fixtureImportOptions(inspection);
    const before = await treeBytes(box.library);
    const catalog = await loadCatalog(box.library);
    createGroup(catalog, left);
    const inMemory = structuredClone(catalog);
    if (same) {
      await assert.rejects(importResource(box.library, input, options), /duplicate/i);
      assert.deepEqual(await treeBytes(box.library), before);
      assert.throws(() => createGroup(catalog, right), /duplicate/i);
      assert.deepEqual(catalog, inMemory);
    } else {
      assert.ok(await importResource(box.library, input, options));
      assert.ok(createGroup(catalog, right));
    }
  });
}

test("N2 folding order, FULL not S/T, locale-independent keys, accents and ignorables retained", () => {
  assert.equal(nameKey(" \u00a0Kﬃẞ\u00a0 "), "kffiss");
  assert.equal(nameKey("\u0390"), "\u0390"); // final NFKC recomposes the expanded fold
  assert.equal(foldCaseUnicode17("ẞßİIıς"), "ssssi\u0307iıσ");
  for (const character of ["\u200b", "\u200c", "\u200d", "\u00ad", "\u034f", "\ufe0f"]) {
    assert.notEqual(nameKey(`a${character}`), "a", `must not remove U+${character.codePointAt(0)!.toString(16)}`);
  }
  assert.notEqual(nameKey("résumé"), nameKey("resume"));
  for (const blank of ["", " \t\n ", "\u3000\u00a0"]) assert.throws(() => nameKey(blank), /empty/i);
});

test("N2 item/group same display name is persisted; comparison never replaces display names or contents", async () => {
  const box = await acceptanceBox();
  const item = await add(box, " Ｓtraße① ");
  assert.equal(item.name, "Ｓtraße①");
  const catalog = await loadCatalog(box.library);
  const group = createGroup(catalog, " Ｓtraße① ");
  setGroupItems(catalog, group.id, [item.id]);
  await saveCatalog(box.library, catalog);
  const sourceBefore = await treeBytes(box.source);
  const filesBefore = await treeBytes(path.join(box.library, "sources"));
  const renamed = await renameSavedItem(box.library, item.id, " Ａgent ﬃ ");
  assert.equal(renamed.name, "Ａgent ﬃ");
  const after = await loadCatalog(box.library);
  renameGroup(after, group.id, " Ａgent ﬃ ");
  await saveNameChanges(box.library, await loadCatalog(box.library), after);
  assert.equal((await loadCatalog(box.library)).groups[0]!.name, "Ａgent ﬃ");
  assert.deepEqual(await treeBytes(box.source), sourceBefore);
  assert.deepEqual(await treeBytes(path.join(box.library, "sources")), filesBefore);
  assert.match((await readSnapshotFiles(box.library, renamed)).find((file) => file.path === "SKILL.md")!.bytes.toString(), /Original Straße \/ ①/);
});

test("N1 every registration entry rejects collisions across kinds and memberships without orphan bytes", async () => {
  const box = await acceptanceBox();
  const item = await add(box, "Straße");
  const catalog = await loadCatalog(box.library);
  const group = createGroup(catalog, "work");
  const other = createGroup(catalog, "other-team");
  setGroupItems(catalog, group.id, [item.id]);
  await saveCatalog(box.library, catalog);
  const input = await candidate(box, " STRASSE ", "instruction");
  const prepared = await prepareResource(input);
  const inspection = await inspectPreparedResource(prepared);
  const options = fixtureImportOptions(inspection, [other.id]);
  const before = await treeBytes(box.library);
  const sourceBefore = await treeBytes(box.source);
  await assert.rejects(importResource(box.library, input, options), /duplicate/i);
  await assert.rejects(importPreparedResource(box.library, prepared, { confirmed: true, groupIds: [other.id], inspection, approvedSensitivePaths: [...inspection.sensitivePaths] }), /duplicate/i);
  const invalid = structuredClone(catalog);
  invalid.items.push({ ...item, id: "10000000-0000-4000-8000-000000000001", name: "STRASSE" });
  await assert.rejects(saveCatalog(box.library, invalid), /duplicate/i);
  const inMemory = structuredClone(catalog);
  assert.throws(() => createGroup(catalog, " ＷＯＲＫ "), /duplicate/i);
  assert.throws(() => renameGroup(catalog, other.id, "WORK"), /duplicate/i);
  assert.deepEqual(catalog, inMemory);
  assert.deepEqual(await treeBytes(box.library), before);
  assert.deepEqual(await treeBytes(box.source), sourceBefore);
});

test("N1 rejected empty import and duplicate save do not create a previously absent library", async () => {
  const box = await acceptanceBox();
  const input = await candidate(box, " \u3000 ");
  const prepared = await prepareResource(input);
  const inspection = await inspectPreparedResource(prepared);
  const options = fixtureImportOptions(inspection);
  await assert.rejects(importResource(box.library, input, options), /empty/i);
  await assert.rejects(importPreparedResource(box.library, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: [...inspection.sensitivePaths] }), /empty/i);
  const catalog = newCatalog();
  catalog.groups = [{ id: "one", name: "ﬃ", itemIds: [] }, { id: "two", name: "FFI", itemIds: [] }];
  await assert.rejects(saveCatalog(box.library, catalog), /duplicate/i);
  await assert.rejects(lstat(box.library), { code: "ENOENT" });
});

test("N1/#9 real CLI setup resolves a conflicting selected batch before review; no Duplicate item name after confirm", async () => {
  const box = await acceptanceBox();
  for (const [index, name] of ["Straße", "STRASSE"].entries()) {
    // Distinct parents are necessary on case-insensitive macOS filesystems.
    const folder = path.join(box.project, ".pi", "skills", `set-${index}`, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `# approved safe original ${index}\n`); // distinct: identical copies merge
  }
  const projectBefore = await treeBytes(box.project);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    { waitFor: "Choose the locations", send: "\u001b[B\u001b[B\r" },
    { waitFor: "Authorize copi", send: "y" },
    { waitFor: "Select resources to review", send: "\t\u001b[B\t\r" },
    { waitFor: "Keep all and rename the others", send: "\u001b[B\u001b[B\r" },
    { waitFor: "New display name for STRASSE", send: "\r" },
    { waitFor: "Create the first resource group", send: "test-team\r" },
    { waitFor: "Put all 2 resources", send: "\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes("Duplicate item name"), result.output);
  assert.ok(result.output.indexOf("Keep all and rename the others") < result.output.indexOf("Masked preview"));
  assert.match(result.output, /PTY actions 8\/8/);
  assert.deepEqual((await loadCatalog(box.library)).items.map((item) => item.name).sort(), ["STRASSE (set-1)", "Straße"]);
  assert.deepEqual(await treeBytes(box.project), projectBefore);
});

const explicitNames = ["Kit (chosen)", "Greek (chosen)", "Daily (chosen)", "Café (chosen)"];
for (const stage of ["selection", "input", "one staged", "final denial", "final interrupt"] as const) {
  test(`N3 real clack cancellation at ${stage} preserves raw catalog and ALL snapshot/source bytes`, async () => {
    const box = await acceptanceBox();
    const before = await legacy(box);
    const original = await treeBytes(box.library);
    const source = await treeBytes(box.source);
    let actions: Action[];
    if (stage === "selection") actions = [{ ...choose, send: "\u0003" }];
    else if (stage === "input") actions = [choose, { waitFor: "New name for", send: "partially typed\u0003" }];
    else if (stage === "one staged") actions = [...renameSteps(explicitNames.slice(0, 1)), { ...choose, send: "\u0003" }];
    else actions = [...renameSteps(explicitNames), { waitFor: "Save these name changes?", send: stage === "final denial" ? "n" : "\u0003" }];
    const result = await realPty(box, wizardArgv(box), actions);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Name changes were not saved/);
    assert.deepEqual(await treeBytes(box.library), original);
    assert.deepEqual(await treeBytes(box.source), source);
    assert.deepEqual(await loadCatalog(box.library), before);
  });
}

for (const entry of ["groups", "setup"] as const) {
  test(`N3/N4 real CLI ${entry} allows only masked viewing and conflict resolution`, async () => {
    const box = await acceptanceBox();
    const catalog = await legacy(box);
    const before = await treeBytes(box.library);
    const result = await realPty(box, [process.execPath, cli, entry], [
      { waitFor: "Unresolved names", send: "\r" },
      { waitFor: "Select saved resource or group", send: "\r" },
      { waitFor: "Unresolved names", send: "\u001b[B\u001b[B\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Masked saved preview/);
    assert.match(result.output, /REDACTED/);
    assert.ok(!result.output.includes(secret));
    for (const item of catalog.items) assert.ok(!result.output.includes(item.id));
    assert.ok(!result.output.includes("Choose the locations"));
    assert.ok(!result.output.includes("Manage saved groups"));
    assert.deepEqual(await treeBytes(box.library), before);
  });
}

test("N3 new occupied name rejected in actual text validation; corrected explicit names commit together", async () => {
  const box = await acceptanceBox();
  const before = await legacy(box);
  assert.equal((await listSnapshots(box.library)).length, 5);
  assert.equal(findNameConflicts(await loadCatalog(box.library)).length, 4);
  const snapshotBefore = await treeBytes(path.join(box.library, "sources"));
  const sourceBefore = await treeBytes(box.source);
  const result = await realPty(box, [process.execPath, cli, "groups"], [
    { waitFor: "Unresolved names", send: "\u001b[B\r" },
    choose,
    { waitFor: "New name for", send: "ＳＡＦＥ\r" },
    { waitFor: "Duplicate item name", send: "\u0015Kit (chosen)\r" },
    ...renameSteps(explicitNames.slice(1)),
    { waitFor: "Save these name changes?", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const after = await loadCatalog(box.library);
  assertOnlyNames(before, after);
  assert.deepEqual(after.items.map((item) => item.name), ["Kit (chosen)", " 1 KIT ", "Greek (chosen)", "ος", "safe"]);
  assert.deepEqual(after.groups.map((group) => group.name), ["Daily (chosen)", "ＤＡＩＬＹ", "Café (chosen)", "Cafe\u0301", "safe-team"]);
  assert.equal(findNameConflicts(after).length, 0);
  assert.deepEqual(await treeBytes(path.join(box.library, "sources")), snapshotBefore);
  assert.deepEqual(await treeBytes(box.source), sourceBefore);
  for (const item of after.items) assert.equal((await readSnapshotFiles(box.library, item)).length, 3);
  for (const item of before.items) assert.ok(!result.output.includes(item.id));
});

test("N3 CLI setup also reaches and commits explicit conflict resolution (not resource search)", async () => {
  const box = await acceptanceBox();
  const before = await legacy(box);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    { waitFor: "Unresolved names", send: "\u001b[B\r" },
    ...renameSteps(explicitNames), { waitFor: "Save these name changes?", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Name conflicts resolved/);
  assert.ok(!result.output.includes("Choose the locations"));
  assertOnlyNames(before, await loadCatalog(box.library));
});

async function expectUnchanged(box: AcceptanceBox, operation: () => Promise<unknown>, pattern = /duplicate|conflict/i) {
  const library = await treeBytes(box.library);
  const project = await treeBytes(box.project);
  await assert.rejects(operation(), pattern);
  assert.deepEqual(await treeBytes(box.library), library);
  assert.deepEqual(await treeBytes(box.project), project);
}

test("N4 unresolved library rejects public mutation APIs including nonconflicting targets", async () => {
  const box = await acceptanceBox();
  const before = await legacy(box);
  const safeId = before.items[4]!.id;
  const input = await candidate(box, "new unique");
  const prepared = await prepareResource(input);
  const inspection = await inspectPreparedResource(prepared);
  const options = fixtureImportOptions(inspection);
  await expectUnchanged(box, () => importResource(box.library, input, options));
  await expectUnchanged(box, () => importPreparedResource(box.library, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: [...inspection.sensitivePaths] }));
  await expectUnchanged(box, () => renameSavedItem(box.library, safeId, "safe renamed"));
  const changed = structuredClone(before);
  changed.items[4]!.destination = { kind: "global-only" };
  await expectUnchanged(box, () => saveCatalog(box.library, changed));
  await expectUnchanged(box, () => planApply(box.library, "safe-team", box.project));
  for (const operation of [
    (catalog: Catalog) => createGroup(catalog, "brand new"),
    (catalog: Catalog) => setGroupItems(catalog, "safe-team", []),
    (catalog: Catalog) => renameGroup(catalog, "safe-team", "new team"),
  ]) {
    const catalog = structuredClone(before);
    assert.throws(() => operation(catalog), /duplicate|conflict/i);
    assert.deepEqual(catalog, before);
  }
  const resolved = structuredClone(before);
  resolved.items[0]!.name = "unique-one"; resolved.items[2]!.name = "unique-two";
  resolved.groups[0]!.name = "unique-three"; resolved.groups[2]!.name = "unique-four";
  await expectUnchanged(box, () => saveCatalog(box.library, resolved));
  // Ordinary save is not a backdoor to the name-only resolution transaction.
  for (const args of [["list"], ["groups"], []]) {
    const result = await cliPipe(box, args);
    assert.equal(result.code, 0, result.output);
  }
  for (const args of [["setup"], ["apply", "safe-team", box.project]]) {
    const result = await cliPipe(box, args);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /TTY/);
  }
});

test("N4 actual CLI apply rejects conflicts outside chosen group before confirmation or writes", async () => {
  const box = await acceptanceBox();
  await legacy(box);
  const library = await treeBytes(box.library);
  const target = await treeBytes(box.project);
  const result = await realPty(box, [process.execPath, cli, "apply", "safe-team", box.project], []);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Duplicate names/);
  assert.ok(!result.output.includes("Apply the selected snapshots"));
  assert.deepEqual(await treeBytes(box.project), target);
  assert.deepEqual(await treeBytes(box.library), library);
});

for (const namespace of ["item", "group"] as const) {
  test(`N4 execute rechecks whole catalog after plan when ${namespace} conflicts appear elsewhere`, async () => {
    const box = await acceptanceBox();
    const targetItem = await add(box, "target");
    await add(box, "unselected-a"); await add(box, "unselected-b");
    const catalog = await loadCatalog(box.library);
    catalog.groups = [
      { id: "chosen", name: "Chosen", itemIds: [targetItem.id] },
      { id: "unselected-a", name: "Other A", itemIds: [] },
      { id: "unselected-b", name: "Other B", itemIds: [] },
    ];
    await saveCatalog(box.library, catalog);
    const plan = await planApply(box.library, "chosen", box.project);
    assert.ok(plan.files.length > 0, "test must reach a writable plan");
    if (namespace === "item") catalog.items[2]!.name = "UNSELECTED-A";
    else catalog.groups[2]!.name = "OTHER A";
    await writeFile(path.join(box.library, "catalog.json"), JSON.stringify(catalog));
    await expectUnchanged(box, () => executeApply(box.library, plan, { secretApprovals: plan.files.filter((file) => file.sensitive).map((file) => file.path) }));
  });
}

test("N5 name-only APIs preserve identity, metadata, every group reference and all source/snapshot bytes", async () => {
  const box = await acceptanceBox();
  const first = await add(box, "first"); const second = await add(box, "second");
  const before = await loadCatalog(box.library);
  before.groups = [
    { id: "a", name: "group A", itemIds: [first.id, second.id] },
    { id: "b", name: "group B", itemIds: [second.id, first.id] },
  ];
  await saveCatalog(box.library, before);
  const source = await treeBytes(box.source);
  const snapshots = await treeBytes(path.join(box.library, "sources"));
  await renameSavedItem(box.library, first.id, " explicit first ");
  const mid = await loadCatalog(box.library);
  const after = structuredClone(mid);
  renameGroup(after, "b", " explicit team ");
  await saveNameChanges(box.library, mid, after);
  assertOnlyNames(before, await loadCatalog(box.library));
  assert.deepEqual(await treeBytes(box.source), source);
  assert.deepEqual(await treeBytes(path.join(box.library, "sources")), snapshots);
  await expectUnchanged(box, () => renameSavedItem(box.library, first.id, " SECOND "), /duplicate/i);
});

for (const corruption of ["none", "checksum", "file symlink"] as const) {
  test(`N5 ordinary CLI group rename ${corruption} ${corruption === "file symlink" ? "rejects the unsafe source" : "preserves current bytes and metadata"}`, async () => {
    const box = await acceptanceBox();
    const item = await add(box, "healthy-name");
    const catalog = await loadCatalog(box.library);
    catalog.groups = [{ id: "team", name: "Original team", itemIds: [item.id] }];
    await saveCatalog(box.library, catalog);
    if (item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
    const contentRoot = path.join(box.library, ...item.content.path.split("/"));
    const target = path.join(contentRoot, "SKILL.md");
    if (corruption === "checksum") await writeFile(target, "manual current edit\n");
    const outside = path.join(box.root, "original-copy.md");
    if (corruption === "file symlink") {
      await rename(target, outside);
      await symlink(outside, target);
    }
    const libraryBefore = await treeBytes(box.library);
    const sourcesBefore = await treeBytes(path.join(box.library, "sources"));
    const sourceBefore = await treeBytes(box.source);
    const currentBytes = corruption === "file symlink" ? undefined : await readFile(target);
    const outsideBytesBefore = corruption === "file symlink" ? await readFile(outside) : undefined;
    const targetBefore = await lstat(corruption === "file symlink" ? outside : target);
    const result = await realPty(box, [process.execPath, cli, "groups"], [
      { waitFor: "Manage saved groups", send: "\u001b[B\r" },
      { waitFor: "Select group", send: "\r" },
      { waitFor: "New name for", send: "Explicit new team\r" },
      { waitFor: "Manage saved groups", send: "\u001b[B\u001b[B\u001b[B\r" },
      { waitFor: "Save these group changes", send: "y" },
    ]);
    if (corruption !== "file symlink") {
      assert.equal(result.code, 0, result.output);
      const after = await loadCatalog(box.library);
      assertOnlyNames(catalog, after);
      assert.equal(after.groups[0]!.name, "Explicit new team");
      assert.equal(after.items[0]!.name, "healthy-name");
      assert.deepEqual(after.items[0]!.files, catalog.items[0]!.files, "metadata rename must not rewrite the old descriptor SHA");
      assert.ok(currentBytes);
      assert.deepEqual(await readFile(target), currentBytes);
      assert.deepEqual((await readSnapshotFiles(box.library, after.items[0]!)).find((file) => file.path === "SKILL.md")!.bytes, currentBytes);
      const targetAfter = await lstat(target);
      assert.equal(targetAfter.dev, targetBefore.dev);
      assert.equal(targetAfter.ino, targetBefore.ino);
      assert.deepEqual(await treeBytes(path.join(box.library, "sources")), sourcesBefore);
    } else {
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /unsafe symbolic link/i);
      assert.deepEqual(await treeBytes(box.library), libraryBefore);
      assert.ok(outsideBytesBefore);
      assert.deepEqual(await readFile(outside), outsideBytesBefore);
      const outsideAfter = await lstat(outside);
      assert.equal(outsideAfter.dev, targetBefore.dev);
      assert.equal(outsideAfter.ino, targetBefore.ino);
    }
    assert.deepEqual(await treeBytes(box.source), sourceBefore);
  });
}

const forbidden: [string, (catalog: Catalog) => void][] = [
  ["source", (c) => { c.items[0]!.source = "forged"; }],
  ["sourcePath", (c) => { c.items[0]!.sourcePath += "-forged"; }],
  ["scope", (c) => { c.items[0]!.scope = "user"; }],
  ["kind", (c) => { c.items[0]!.kind = "instruction"; }],
  ["destination", (c) => { c.items[0]!.destination = { kind: "global-only" }; }],
  ["savedAt", (c) => { c.items[0]!.savedAt = "2020-01-01T00:00:00Z"; }],
  ["checksum", (c) => { c.items[0]!.files[0]!.sha256 = "0".repeat(64); }],
  ["file removal", (c) => { c.items[0]!.files.pop(); }],
  ["membership", (c) => { c.groups[0]!.itemIds = []; }],
  ["group deletion", (c) => { c.groups.pop(); }],
  ["item order", (c) => { c.items.reverse(); }],
  ["identifier", (c) => { c.items[0]!.id = "20000000-0000-4000-8000-000000000002"; }],
];
test("N5 resolution API rejects metadata/membership/file forgery and nonconflicting rename", async () => {
  const box = await acceptanceBox();
  const before = await legacy(box);
  for (const [label, mutate] of forbidden) {
    const after = structuredClone(before);
    after.items[0]!.name = "explicit unique";
    mutate(after);
    await expectUnchanged(box, () => saveNameChanges(box.library, before, after), /renam|preserve|invalid|unknown/i);
    console.log(`Rejected name-only forgery: ${label}`);
  }
  const unrelated = structuredClone(before);
  unrelated.items[4]!.name = "not a conflict";
  await expectUnchanged(box, () => saveNameChanges(box.library, before, unrelated), /only conflicting/i);
});

test("N5 item rename reads directly edited sources and preserves descriptor metadata and inode", async () => {
  const box = await acceptanceBox();
  const item = await add(box, "original item name");
  const initial = await loadCatalog(box.library);
  const group = createGroup(initial, "original group name");
  setGroupItems(initial, group.id, [item.id]);
  await saveCatalog(box.library, initial);
  const before = await loadCatalog(box.library);
  if (item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
  const target = path.join(box.library, ...item.content.path.split("/"), "SKILL.md");
  await writeFile(target, "manual current source edit\n");
  const currentBytes = await readFile(target);
  const targetBefore = await lstat(target);
  const descriptorBefore = structuredClone(before.items[0]!.files);

  await renameSavedItem(box.library, item.id, "renamed item");

  const after = await loadCatalog(box.library);
  assertOnlyNames(before, after);
  assert.equal(after.items[0]!.name, "renamed item");
  assert.equal(after.groups[0]!.name, "original group name");
  assert.deepEqual(after.items[0]!.files, descriptorBefore, "direct edits must not silently update the historical descriptor SHA");
  assert.deepEqual(await readFile(target), currentBytes);
  assert.deepEqual((await readSnapshotFiles(box.library, after.items[0]!)).find((file) => file.path === "SKILL.md")!.bytes, currentBytes);
  const targetAfter = await lstat(target);
  assert.equal(targetAfter.dev, targetBefore.dev);
  assert.equal(targetAfter.ino, targetBefore.ino);
});

for (const corruption of ["file symlink", "directory symlink"] as const) {
  test(`N5 item/group metadata operations reject ${corruption} before mutation`, async () => {
    const box = await acceptanceBox();
    const item = await add(box, "unique item");
    const initial = await loadCatalog(box.library);
    const group = createGroup(initial, "unique group");
    setGroupItems(initial, group.id, [item.id]);
    await saveCatalog(box.library, initial);
    const before = await loadCatalog(box.library);
    if (item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
    const contentRoot = path.join(box.library, ...item.content.path.split("/"));
    const target = path.join(contentRoot, "SKILL.md");
    let linkPath: string;
    let outside: string;
    if (corruption === "file symlink") {
      linkPath = target;
      outside = path.join(box.root, "original-copy.md");
      await rename(target, outside);
      await symlink(outside, target);
    } else {
      linkPath = contentRoot;
      outside = path.join(box.root, "outside-directory");
      await rename(contentRoot, outside);
      await symlink(outside, contentRoot);
    }
    const outsideFile = corruption === "file symlink" ? outside : path.join(outside, "SKILL.md");
    const outsideBytes = await readFile(outsideFile);
    const outsideBefore = await lstat(outsideFile);
    const libraryBefore = await treeBytes(box.library);
    const groupRename = structuredClone(before);
    renameGroup(groupRename, group.id, "renamed group");

    await expectUnchanged(box, () => renameSavedItem(box.library, item.id, "renamed item"), /unsafe symbolic link/i);
    await expectUnchanged(box, () => saveNameChanges(box.library, before, groupRename), /unsafe symbolic link/i);
    await assert.rejects(readSnapshotFiles(box.library, item), /unsafe symbolic link/i);

    assert.deepEqual(await treeBytes(box.library), libraryBefore);
    assert.ok((await lstat(linkPath)).isSymbolicLink());
    assert.deepEqual(await readFile(outsideFile), outsideBytes);
    const outsideAfter = await lstat(outsideFile);
    assert.equal(outsideAfter.dev, outsideBefore.dev);
    assert.equal(outsideAfter.ino, outsideBefore.ino);
  });
}

test("N5 name-only preview rejects later direct source edits without rewriting catalog or source", async () => {
  const box = await acceptanceBox();
  const item = await add(box, "stable item");
  const initial = await loadCatalog(box.library);
  const group = createGroup(initial, "stable group");
  setGroupItems(initial, group.id, [item.id]);
  await saveCatalog(box.library, initial);
  if (item.content.kind !== "tree") throw new Error("Expected a v2 skill tree fixture.");
  const target = path.join(box.library, ...item.content.path.split("/"), "SKILL.md");
  await writeFile(target, "direct edit before preview\n");
  const before = await loadCatalog(box.library);
  const after = structuredClone(before);
  renameGroup(after, group.id, "previewed group name");
  const catalogPath = path.join(box.library, "catalog.json");
  const catalogBefore = await readFile(catalogPath);

  await writeFile(target, "later external edit after preview\n");
  const currentBytes = await readFile(target);
  const currentStat = await lstat(target);
  const libraryBeforeCommit = await treeBytes(box.library);
  await assert.rejects(saveNameChanges(box.library, before, after), /Copi library changed after preparation/);
  assert.deepEqual(await treeBytes(box.library), libraryBeforeCommit);
  assert.deepEqual(await readFile(catalogPath), catalogBefore);
  assert.deepEqual(await readFile(target), currentBytes);
  const targetAfter = await lstat(target);
  assert.equal(targetAfter.dev, currentStat.dev);
  assert.equal(targetAfter.ino, currentStat.ino);
  const current = await loadCatalog(box.library);
  assert.equal(current.groups[0]!.name, "stable group");
  assert.deepEqual(current.items[0]!.files, before.items[0]!.files);
});
