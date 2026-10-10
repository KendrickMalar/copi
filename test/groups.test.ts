import assert from "node:assert/strict";
import test from "node:test";
import { createGroup, renameGroup, setGroupItems } from "../src/groups.ts";
import { newCatalog } from "../src/catalog.ts";

test("keeps group edits in memory and lets the same saved item belong to multiple groups", () => {
  const catalog = newCatalog();
  catalog.items.push({
    id: "00000000-0000-4000-8000-000000000001",
    kind: "skill",
    source: "shared-agent-skills",
    scope: "shared",
    sourcePath: "/synthetic/home/skills/review/SKILL.md",
    destination: { kind: "project", path: ".pi/skills/review" },
    name: "review",
    savedAt: "2026-09-30T00:00:00.000Z",
    files: [{ path: "SKILL.md", mode: 0o644, sha256: "0".repeat(64) }],
    content: { kind: "tree", path: "sources/00000000-0000-4000-8000-000000000001" },
  });

  const daily = createGroup(catalog, "Daily");
  const review = createGroup(catalog, "Review");
  setGroupItems(catalog, daily.id, [catalog.items[0]!.id]);
  setGroupItems(catalog, review.id, [catalog.items[0]!.id]);
  renameGroup(catalog, review.id, "Code review");

  assert.deepEqual(catalog.groups.map(({ name, itemIds }) => ({ name, itemIds })), [
    { name: "Daily", itemIds: ["00000000-0000-4000-8000-000000000001"] },
    { name: "Code review", itemIds: ["00000000-0000-4000-8000-000000000001"] },
  ]);
});

test("rejects normalized new names and ordinary mutations until existing duplicates are resolved", () => {
  const catalog = newCatalog();
  const first = createGroup(catalog, "Straße");
  assert.throws(() => createGroup(catalog, " STRASSE "), /duplicate|conflict/i);
  const second = createGroup(catalog, "Other");
  assert.throws(() => renameGroup(catalog, second.id, "ＳＴＲＡＳＳＥ"), /duplicate|conflict/i);
  second.name = "STRASSE";
  const before = JSON.stringify(catalog);
  assert.throws(() => createGroup(catalog, "Third"), /duplicate|conflict/i);
  assert.throws(() => setGroupItems(catalog, first.id, []), /duplicate|conflict/i);
  assert.equal(JSON.stringify(catalog), before);
  renameGroup(catalog, second.id, " Separate ");
  assert.equal(second.name, "Separate");
  setGroupItems(catalog, first.id, []);
});

test("rejects invalid group edits without changing existing membership", () => {
  const catalog = newCatalog();
  const group = createGroup(catalog, "Daily");
  assert.throws(() => createGroup(catalog, "  "), /name/i);
  assert.throws(() => setGroupItems(catalog, group.id, ["00000000-0000-4000-8000-000000000099"]), /unknown/i);
  assert.deepEqual(group.itemIds, []);
});
