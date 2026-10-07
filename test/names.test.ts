import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { newCatalog } from "../src/catalog.ts";
import { nameKey, findNameConflicts, assertNoNameConflicts } from "../src/names.ts";

test("name comparison follows all approved Unicode boundaries without stripping accents or ignorable characters", () => {
  for (const [left, right, equal] of [
    [" A ", "a", true], ["Ａ", "A", true], ["①", "1", true], ["ｶﾀｶﾅ", "カタカナ", true],
    ["é", "e\u0301", true], ["é", "e", false], ["Straße", "STRASSE", true], ["σ", "ς", true],
    ["I", "i", true], ["I", "ı", false], ["İ", "i", false], ["İ", "i\u0307", true],
    ["a\u200b", "a", false], ["a\u00ad", "a", false],
  ] as const) assert.equal(nameKey(left) === nameKey(right), equal, `${left} / ${right}`);
  assert.equal(nameKey(" ＳＴＲＡＳＳＥ "), "strasse");
  for (const value of ["", "  ", "\u3000"]) assert.throws(() => nameKey(value), /empty|name/i);
});

test("reports every duplicate namespace independently and does not rewrite display names", () => {
  const catalog = newCatalog();
  catalog.groups = [
    { id: "one", name: "Straße", itemIds: [] }, { id: "two", name: " STRASSE ", itemIds: [] },
    { id: "three", name: "σ", itemIds: [] }, { id: "four", name: "ς", itemIds: [] },
  ];
  const snapshotBytes = Buffer.from("synthetic snapshot bytes\n");
  catalog.items = ["Straße", "STRASSE", "Ｓｔｒａｓｓｅ"].map((name, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    return {
      id, name, kind: "skill", source: "synthetic", scope: "project",
      sourcePath: `/synthetic/source/${index}`, destination: { kind: "global-only" }, savedAt: "2026-10-04T00:00:00Z",
      content: { kind: "tree", path: `sources/${id}` },
      files: [{ path: "SKILL.md", mode: 0o644, sha256: createHash("sha256").update(snapshotBytes).digest("hex") }],
    };
  });
  const before = JSON.stringify(catalog);
  assert.deepEqual(findNameConflicts(catalog), [
    { namespace: "item", key: "strasse", ids: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"] },
    { namespace: "group", key: "strasse", ids: ["one", "two"] },
    { namespace: "group", key: "σ", ids: ["three", "four"] },
  ]);
  assert.throws(() => assertNoNameConflicts(catalog), /duplicate|conflict/i);
  assert.equal(JSON.stringify(catalog), before);
});
