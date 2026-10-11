import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, loadCatalog as loadStoredCatalog, saveCatalog } from "../src/catalog.ts";
import { createGroup } from "../src/groups.ts";
import { acceptanceBox, add, cli, realPty, treeBytes, type AcceptanceBox } from "./helpers/issue2-acceptance.ts";

async function skill(box: AcceptanceBox, name: string, body = "# body\n"): Promise<void> {
  const folder = path.join(box.project, ".pi", "skills", `set-${name}`, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), body);
}
async function skillAt(box: AcceptanceBox, dir: string, name: string): Promise<void> {
  const folder = path.join(box.project, ".pi", "skills", dir, name);
  await mkdir(folder, { recursive: true });
  // Content differs per folder: identical same-named copies are merged into one row by design.
  await writeFile(path.join(folder, "SKILL.md"), `# body ${dir}\n`);
}
async function seedGroups(box: AcceptanceBox, names: string[]): Promise<void> {
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  for (const name of names) createGroup(catalog, name);
  await saveCatalog(box.library, catalog);
}
const flat = (output: string) => output.replace(/[│┌└├─]/g, " ").replace(/\s+/g, " ");

const start = [
  { waitFor: "Choose the locations", send: "\u001b[B\r" },
  { waitFor: "Authorize copi", send: "y" },
];
const selectTwo = { waitFor: "Select resources to review", send: "\t\u001b[B\t\r" };

test("#13/#15 clean review: progress title, no inspection warnings note, summary heuristic line, ~ confirm, outro next step", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const text = flat(result.output);
  assert.match(text, /Masked preview \(1\/1\): alpha — /);
  assert.doesNotMatch(text, /inspection warnings/);
  const summary = text.slice(text.indexOf("Resources ready to copy"));
  assert.match(summary, /Secret detection is heuristic and cannot guarantee completeness\./);
  assert.match(text, /Save 1 copied resource\(s\) in ~\/\.copi\? Original files will not be changed\./);
  assert.match(text, /Saved 1 copied resource\(s\) in ~\/\.copi \(group: team\)\./);
  assert.ok(result.output.includes("Next: copi apply team <project> --dry-run   (edit or rename: copi manage)"), result.output);
});

test("#13 progress counts resources reviewed", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha"); await skill(box, "bravo");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectTwo,
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Put all 2 resources", send: "\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const text = flat(result.output);
  assert.match(text, /Masked preview \(1\/2\): /);
  assert.match(text, /Masked preview \(2\/2\): /);
});

test("#13 sensitive confirm states that declining drops the whole resource", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha", "apiKey: sk_live_reviewfixture1234567890\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save suspected sensitive file", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled/);
  const saved = await loadStoredCatalog(box.library);
  assertModernCatalog(saved);
  assert.deepEqual(saved.items, [], "nothing was saved after cancelling the sensitive confirm");
  const text = flat(result.output);
  assert.match(text, /Save suspected sensitive file SKILL\.md from alpha\?/);
  assert.match(text, /No = alpha will not be saved at all\./);
  assert.ok(!result.output.includes("sk_live_reviewfixture1234567890"));
});

test("#12 follow-up: two groups, two resources -> mode select, then one multiselect with Tab hint", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha"); await skill(box, "bravo");
  await seedGroups(box, ["aa", "bb"]);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectTwo,
    { waitFor: "Create another group", send: "n" },
    { waitFor: "How should these resources be grouped?", send: "\r" },
    { waitFor: "Put all 2 resources in these groups", send: "\t\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\(Tab: select, Enter: confirm\)/);
  assert.ok(!result.output.includes("Assign alpha"));
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  assert.deepEqual(catalog.groups.map((group) => group.itemIds.length), [2, 0]);
});

test("#12 follow-up: two groups, one resource -> direct multiselect naming the resource", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  await seedGroups(box, ["aa", "bb"]);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create another group", send: "n" },
    { waitFor: "Assign alpha to one or more groups", send: "\t\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes("How should these resources be grouped?"));
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  assert.deepEqual(catalog.groups.map((group) => group.itemIds.length), [1, 0]);
});

test("#12 follow-up: Ctrl-C on the mode select saves nothing", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha"); await skill(box, "bravo");
  await seedGroups(box, ["aa", "bb"]);
  const before = await treeBytes(box.library);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectTwo,
    { waitFor: "Create another group", send: "n" },
    { waitFor: "How should these resources be grouped?", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled; no resources were saved\./);
  assert.deepEqual(await treeBytes(box.library), before);
});

test("#15 outro keeps the frame and quotes a group name with spaces in the next step", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create the first resource group", send: "Alpha 日本\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const lines = flat(result.output);
  assert.match(lines, /Saved 1 copied resource\(s\) in ~\/\.copi \(group: Alpha 日本\)\./);
  assert.ok(lines.includes("Next: copi apply 'Alpha 日本' <project> --dry-run"), lines);
  const nextLine = result.output.split("\n").find((line) => line.includes("Next: copi apply"))!;
  assert.match(nextLine, /└/, "the Next line carries the closing frame glyph");
});

test("#9 follow-up: Ctrl-C at the rename text input saves nothing", async () => {
  const box = await acceptanceBox();
  await skillAt(box, "d0", "dup"); await skillAt(box, "d1", "dup");
  const before = await treeBytes(box.library);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectTwo,
    { waitFor: "share the name", send: "\u001b[B\u001b[B\r" },
    { waitFor: "New display name for", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled; no resources were saved\./);
  assert.deepEqual(await treeBytes(box.library), before);
});

test("#9 follow-up: Ctrl-C at the library-conflict select leaves the library unchanged", async () => {
  const box = await acceptanceBox();
  await add(box, "Known");
  await skill(box, "Known");
  const before = await treeBytes(box.library);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Skip (keep the saved copy)", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled; no resources were saved\./);
  assert.deepEqual(await treeBytes(box.library), before);
});

test("#12 follow-up: Ctrl-C at the bulk groups multiselect saves nothing", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha"); await skill(box, "bravo");
  await seedGroups(box, ["aa", "bb"]);
  const before = await treeBytes(box.library);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectTwo,
    { waitFor: "Create another group", send: "n" },
    { waitFor: "How should these resources be grouped?", send: "\r" },
    { waitFor: "Put all 2 resources in these groups", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled; no resources were saved\./);
  assert.deepEqual(await treeBytes(box.library), before);
});
