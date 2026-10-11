import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, loadCatalog as loadStoredCatalog } from "../src/catalog.ts";
import { acceptanceBox, cli, realPty, type AcceptanceBox } from "./helpers/issue2-acceptance.ts";

async function skill(box: AcceptanceBox, name: string, body = "# body\n"): Promise<void> {
  const folder = path.join(box.project, ".pi", "skills", `set-${name}`, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), body);
}

const start = [
  { waitFor: "Choose the locations", send: "\u001b[B\r" },
  { waitFor: "Authorize copi", send: "y" },
];
// Select every listed row: Tab toggles without moving, so go down between Tabs.
const selectFour = { waitFor: "Select resources to review", send: "\t\u001b[B\t\u001b[B\t\u001b[B\t\r" };

test("#12 the first-group prompt explains how a group is used and shows an example", async () => {
  const box = await acceptanceBox();
  await skill(box, "alpha");
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\r" },
    { waitFor: "Create the first resource group", send: "\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Create the first resource group — used later with: copi apply <group>/);
  assert.match(result.output, /e\.g\. game-review/);
});

test("#12 bulk default: 4 resources, one new group, no per-resource Assign prompt", async () => {
  const box = await acceptanceBox();
  for (const name of ["alpha", "bravo", "charlie", "delta"]) await skill(box, name);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start, selectFour,
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Put all 4 resources in \"team\"", send: "\r" },
    { waitFor: "Save 4 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes("Assign "), "no per-resource group prompt");
  assert.equal(result.output.split("→ team").length - 1, 4, result.output);
  assert.equal(result.output.split("Masked preview (").length - 1, 4);
  assert.match(result.output, /Choose groups for each resource/);
  const catalog = await loadStoredCatalog(box.library);
  assertModernCatalog(catalog);
  assert.equal(catalog.items.length, 4);
  assert.deepEqual(catalog.groups.map((group) => group.itemIds.length), [4]);
});

test("#12 per-resource mode shows pending counts that grow", async () => {
  const box = await acceptanceBox();
  for (const name of ["alpha", "bravo"]) await skill(box, name);
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Select resources to review", send: "\t\u001b[B\t\r" },
    { waitFor: "Create the first resource group", send: "team\r" },
    { waitFor: "Put all 2 resources", send: "\u001b[B\r" },
    { waitFor: "Assign alpha", send: "\t\r" },
    { waitFor: "Assign bravo", send: "\t\r" },
    { waitFor: "Save 2 copied resource(s)", send: "y" },
  ]);
  assert.equal(result.code, 0, result.output);
  const first = result.output.indexOf("Assign alpha");
  const second = result.output.indexOf("Assign bravo");
  assert.ok(first > 0 && second > first);
  assert.match(result.output.slice(first, second), /0 saved · 0 pending/);
  assert.match(result.output.slice(second), /0 saved · 1 pending/);
});
