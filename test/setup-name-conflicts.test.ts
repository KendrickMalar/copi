import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, loadCatalog as loadStoredCatalog, readSnapshotFiles } from "../src/catalog.ts";
import type { Catalog, SavedItem } from "../src/types.ts";
import { renamePrompt } from "../src/wizard.ts";
import { acceptanceBox, add, cli, realPty, treeBytes, type AcceptanceBox } from "./helpers/issue2-acceptance.ts";

async function loadCatalog(libraryDir: string): Promise<Catalog> {
  const catalog = await loadStoredCatalog(libraryDir);
  assertModernCatalog(catalog);
  return catalog;
}

async function skill(box: AcceptanceBox, dir: string, name: string, body: string): Promise<string> {
  const folder = path.join(box.project, ".pi", "skills", dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), body);
  return folder;
}

async function snapshotText(box: AcceptanceBox, item: SavedItem): Promise<Record<string, string>> {
  const files = await readSnapshotFiles(box.library, item);
  return Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.bytes).toString("base64")]));
}

const start = [
  { waitFor: "Choose the locations", send: "\u001b[B\r" },
  { waitFor: "Authorize copi", send: "y" },
];
const selectFirstTwo = { waitFor: "Select resources to review", send: "\t\u001b[B\t\r" };
const conflict = "share the name";
const down = "\u001b[B";

test("#9 keep one: choosing a single candidate saves only that one, before any preview", async () => {
  const box = await acceptanceBox();
  await skill(box, "set-0", "dup", "# first copy\n");
  await skill(box, "set-1", "dup", "# second copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: conflict, send: `${down}\r` },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const text = result.output;
  assert.ok(text.indexOf(conflict) < text.indexOf("Masked preview"), "conflict prompt comes before the first preview");
  // Long source paths wrap in the PTY; the label text itself is covered by candidateLabels tests.
  assert.ok(text.split("Keep [skill] dup \u2014").length - 1 >= 2, text);
  assert.match(text, /Keep all and rename the others/);
  assert.match(text, /Go back to the list/);
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name), ["dup"]);
  assert.deepEqual(await snapshotText(box, catalog.items[0]!), { "SKILL.md": Buffer.from("# second copy\n").toString("base64") });
});

test("#9 rename: only the display name changes; validation rejects taken names; files stay byte-identical", async () => {
  const box = await acceptanceBox();
  await skill(box, "set-0", "dup", "# first copy\n");
  const second = await skill(box, "set-1", "dup", "# second copy\n");
  const sourceBefore = await treeBytes(box.project);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: conflict, send: `${down}${down}\r` },
    { waitFor: "New display name for dup", send: "\u0015DUP\r" },
    { waitFor: "already used", send: "\u0015dup copy\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Put all 2 resources", send: "\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes("Duplicate item name"));
  assert.match(result.output, /dup \(set-1\)/, "default name distinguishes the group members");
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name).sort(), ["dup", "dup copy"]);
  const renamed = catalog.items.find((item) => item.name === "dup copy")!;
  assert.deepEqual(renamed.destination, { kind: "project", path: ".pi/skills/dup" });
  assert.equal(renamed.sourcePath, await realpath(second));
  assert.deepEqual(await snapshotText(box, renamed), { "SKILL.md": Buffer.from("# second copy\n").toString("base64") });
  assert.deepEqual(await treeBytes(box.project), sourceBefore);
});

test("#9 library conflict skip keeps the saved copy untouched and saves the rest", async () => {
  const box = await acceptanceBox();
  const known = await add(box, "Known");
  const knownBefore = await snapshotText(box, known);
  await skill(box, "set-0", "Known", "# new local copy\n");
  await skill(box, "set-1", "other", "# other\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: "Skip (keep the saved copy)", send: "\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Rename/);
  assert.match(result.output, /copi manage/);
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name), ["Known", "other"]);
  assert.deepEqual(catalog.items[0], known);
  assert.deepEqual(await snapshotText(box, catalog.items[0]!), knownBefore);
});

test("#9 library conflict skip of the only selection saves nothing", async () => {
  const box = await acceptanceBox();
  await add(box, "Known");
  const before = await treeBytes(box.library);
  await skill(box, "set-0", "Known", "# new local copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Skip (keep the saved copy)", send: "\r" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /No resources selected; nothing was saved/);
  assert.deepEqual(await treeBytes(box.library), before);
});

test("#9 library conflict Rename saves under the new name and leaves the saved item untouched", async () => {
  const box = await acceptanceBox();
  const known = await add(box, "Known");
  const knownBefore = await snapshotText(box, known);
  await skill(box, "set-0", "Known", "# new local copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Skip (keep the saved copy)", send: `${down}\r` },
    { waitFor: "New display name for Known", send: "\u0015Known local\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name), ["Known", "Known local"]);
  assert.deepEqual(catalog.items[0], known);
  assert.deepEqual(await snapshotText(box, catalog.items[0]!), knownBefore);
  assert.deepEqual(await snapshotText(box, catalog.items[1]!), { "SKILL.md": Buffer.from("# new local copy\n").toString("base64") });
});

test("#9 rename prompt never echoes raw control bytes and is not prefilled with an unsafe suggestion", async () => {
  const box = await acceptanceBox();
  const name = "dup\u0007bell";
  await skill(box, "set-0", name, "# first copy\n");
  await skill(box, "set-1", name, "# second copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: "Keep all and rename the others", send: `${down}${down}\r` },
    // Submitting immediately proves the field is empty (not prefilled).
    { waitFor: "New display name for", send: "\r" },
    { waitFor: "Enter a non-empty display name", send: "clean name\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Put all 2 resources", send: "\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const ptyOutput = result.output;
  assert.ok(!ptyOutput.includes("\u0007"), "no raw BEL byte reaches the terminal");
  assert.match(ptyOutput, /dup\\u0007bell \(set-1\)/, "the masked suggestion is shown in the message");
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name).sort(), ["clean name", name]);
});

test("#9 go back re-shows the list with the previous selection, then resolves", async () => {
  const box = await acceptanceBox();
  await skill(box, "set-0", "dup", "# first copy\n");
  await skill(box, "set-1", "dup", "# second copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: "Go back to the list", send: `${down}${down}${down}\r` },
    // Both rows are preselected and the cursor sits on the last selected row (set-1): un-select it.
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Save 1 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const again = result.output.indexOf("Select resources to review", result.output.indexOf(conflict));
  assert.ok(again > 0, "the list is shown again after Go back");
  const firstFrame = result.output.slice(again, result.output.indexOf("\u2514", again));
  assert.equal(firstFrame.split("\u25fc [skill] dup").length - 1, 2, `previous selection is preselected: ${firstFrame}`);
  const catalog = await loadCatalog(box.library);
  assert.deepEqual(catalog.items.map((item) => item.name), ["dup"]);
  assert.deepEqual(await snapshotText(box, catalog.items[0]!), { "SKILL.md": Buffer.from("# first copy\n").toString("base64") });
});

test("#9 cancel at the conflict prompt saves nothing", async () => {
  const box = await acceptanceBox();
  await skill(box, "set-0", "dup", "# first copy\n");
  await skill(box, "set-1", "dup", "# second copy\n");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFirstTwo,
    { waitFor: conflict, send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Setup cancelled; no resources were saved/);
  await assert.rejects(lstat(box.library), { code: "ENOENT" });
});

test("#9 renamePrompt prefills only display-safe suggestions", () => {
  assert.deepEqual(renamePrompt("dup", "~/p/set-1", "dup (set-1)"), {
    message: "New display name for dup \u2014 ~/p/set-1 (display name only; files are not changed)", initialValue: "dup (set-1)",
  });
  const unsafe = renamePrompt("a\u001b[2Jb", "~/p", "a\u001b[2Jb (p)");
  assert.equal(unsafe.initialValue, undefined);
  assert.match(unsafe.message, /Suggestion: a\u001b\[2Jb \(p\)$/); // masked later by the text wrapper
});
