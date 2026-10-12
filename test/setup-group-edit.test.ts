import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, loadCatalog as loadStoredCatalog, saveCatalog } from "../src/catalog.ts";
import { createGroup, deleteGroup, setGroupItems } from "../src/groups.ts";
import type { Catalog } from "../src/types.ts";
import { acceptanceBox, add, cli, realPty, treeBytes, type AcceptanceBox } from "./helpers/issue2-acceptance.ts";

async function skill(box: AcceptanceBox, name: string): Promise<void> {
  const folder = path.join(box.project, ".pi", "skills", `set-${name}`, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `# ${name}\n`);
}
async function seedGroups(box: AcceptanceBox, names: string[]): Promise<void> {
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  for (const name of names) createGroup(catalog, name);
  await saveCatalog(box.library, catalog);
}
async function groups(box: AcceptanceBox): Promise<Array<{ name: string; items: number }>> {
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  return catalog.groups.map((group) => ({ name: group.name, items: group.itemIds.length }));
}
const flat = (output: string) => output.replace(/[│┌└├─]/g, " ").replace(/\s+/g, " ");
const down = "\u001b[B";
const start = [
  { waitFor: "Choose the locations", send: `${down}\r` },
  { waitFor: "Authorize copi", send: "y" },
];

test("deleteGroup removes only the group; saved items stay", () => {
  const catalog: Catalog = { version: 2, items: [], groups: [] } as unknown as Catalog;
  const keep = createGroup(catalog, "keep");
  const gone = createGroup(catalog, "gone");
  deleteGroup(catalog, gone.id);
  assert.deepEqual(catalog.groups.map((group) => group.id), [keep.id]);
  assert.throws(() => deleteGroup(catalog, gone.id), /Unknown group/);
});

test("assign list: create a group in place, Esc at the name returns, empty selection is refused", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  await seedGroups(box, ["aa"]);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    // Rows: aa, + New group…, ✎ Rename or delete groups…
    // The only group starts selected; Tab clears it so Enter is refused.
    { waitFor: "Rename or delete groups", send: "\t\r" },
    { waitFor: "Select at least one group", send: `${down}\r` },
    { waitFor: "New group name", send: "\u001b" },
    { waitFor: "Rename or delete groups", send: `${down}\r` },
    { waitFor: "New group name", send: "fresh\r" },
    // The cleared aa stays cleared; the new group comes back already selected.
    { waitFor: "fresh (0 saved", send: "\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /alpha → fresh/);
  assert.deepEqual(await groups(box), [{ name: "aa", items: 0 }, { name: "fresh", items: 1 }]);
});

test("assign list: rename a group and delete an empty one, then assign", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  await seedGroups(box, ["aa", "bb"]);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    // Rows: aa, bb, + New group…, ✎ Rename or delete groups…
    { waitFor: "Rename or delete groups", send: `${down.repeat(3)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "aa: what do you want to do?", send: `${down}\r` },
    // aa is empty, so it goes without a confirmation; rows are now bb, new, edit.
    { waitFor: "Rename or delete groups", send: `${down.repeat(2)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "bb: what do you want to do?", send: "\r" },
    { waitFor: "New name for bb", send: "renamed\r" },
    { waitFor: "renamed (0 saved", send: "\t\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.ok(!flat(result.output).includes("Delete group aa?"), "an empty group is deleted without asking");
  assert.deepEqual(await groups(box), [{ name: "renamed", items: 1 }]);
});

test("assign list: deleting a group used earlier in this setup asks (default No) and drops it from that resource", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha"); await skill(box, "bravo");
  await seedGroups(box, ["aa", "bb"]);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: `\t${down}\t\r` },
    { waitFor: "How should these resources be grouped?", send: `${down}\r` },
    { waitFor: "Assign alpha", send: "\t\r" },
    { waitFor: "Assign bravo", send: `${down.repeat(3)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "aa: what do you want to do?", send: `${down}\r` },
    { waitFor: "1 resource(s) already assigned in this setup lose this group", send: "\r" },
    // No (the default) keeps aa; try again and answer Yes.
    { waitFor: "aa (0 saved · 1 pending)", send: `${down.repeat(3)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "aa: what do you want to do?", send: `${down}\r` },
    { waitFor: "Takes effect only if you save at the end", send: "y" },
    { waitFor: "bb (0 saved", send: "\t\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const text = flat(result.output);
  assert.match(text, /alpha → no group/);
  assert.match(text, /bravo → bb/);
  assert.deepEqual(await groups(box), [{ name: "bb", items: 1 }]);
  const catalog = await loadStoredCatalog(box.library);
  assert.equal(catalog.items.length, 2, "the ungrouped resource is still saved");
});

test("assign list: group edits are discarded when the final confirmation is No", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  await seedGroups(box, ["aa", "bb"]);
  const before = await treeBytes(box.library);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Rename or delete groups", send: `${down.repeat(3)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "aa: what do you want to do?", send: `${down}\r` },
    { waitFor: "bb (0 saved", send: "\t\r" },
    { waitFor: "Save 1 copied resource(s)", send: "\r" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Nothing was saved\./);
  assert.deepEqual(await treeBytes(box.library), before);
});

test("copi groups: Delete group asks (default No) and keeps the other groups", async () => {
  const box = await acceptanceBox();
  await seedGroups(box, ["aa", "bb"]);
  // Menu: Create, Rename, Edit membership, Delete, Finish.
  const result = await realPty(box, [process.execPath, cli, "groups"], [
    { waitFor: "Manage saved groups", send: `${down.repeat(3)}\r` },
    { waitFor: "Select group", send: "\r" },
    { waitFor: "Delete group aa?", send: "\r" },
    { waitFor: "Manage saved groups", send: `${down.repeat(3)}\r` },
    { waitFor: "Select group", send: "\r" },
    { waitFor: "Delete group aa?", send: "y" },
    { waitFor: "Manage saved groups", send: `${down.repeat(4)}\r` },
    { waitFor: "Save these group changes", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await groups(box), [{ name: "bb", items: 0 }]);
});

test("saveCatalog: groups may be deleted and appended, but surviving groups keep their order", async () => {
  const box = await acceptanceBox();
  await seedGroups(box, ["aa", "bb", "cc"]);
  const reordered = await loadStoredCatalog(box.library);
  assertModernCatalog(reordered);
  reordered.groups.reverse();
  await assert.rejects(saveCatalog(box.library, reordered), /preserve existing group order and identity/);
  const edited = await loadStoredCatalog(box.library);
  assertModernCatalog(edited);
  deleteGroup(edited, edited.groups[1]!.id);
  createGroup(edited, "dd");
  await saveCatalog(box.library, edited);
  assert.deepEqual((await groups(box)).map((group) => group.name), ["aa", "cc", "dd"]);
});

test("assign list: deleting a group with saved resources asks, lists the change before saving, and keeps the resources", async () => {
  const box = await acceptanceBox();
  const saved = await add(box, "older");
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  setGroupItems(catalog, createGroup(catalog, "old").id, [saved.id]);
  await saveCatalog(box.library, catalog);
  await skill(box, "alpha");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    // Rows: old (preselected), + New group…, ✎ Rename or delete groups…
    { waitFor: "Rename or delete groups", send: `${down.repeat(2)}\r` },
    { waitFor: "Which group?", send: "\r" },
    { waitFor: "old: what do you want to do?", send: `${down}\r` },
    { waitFor: "its 1 saved resource(s) stay in the library but leave this group", send: "y" },
    // No groups are left, so only "New group" remains. Typing a name that matches nothing, then Enter, creates it.
    { waitFor: "New group…", send: "fresh" },
    { waitFor: "No matching groups", send: "\r" },
    { waitFor: "New group name", send: "\r" },
    { waitFor: "fresh (0 saved", send: "\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Group changes: created fresh; deleted old \(its 1 saved resource\(s\) stay in the library\)/);
  assert.deepEqual(await groups(box), [{ name: "fresh", items: 1 }]);
  const after = await loadStoredCatalog(box.library);
  assert.deepEqual(after.items.map((item) => item.name).sort(), ["alpha", "older"]);
});
