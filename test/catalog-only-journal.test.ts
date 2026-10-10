import assert from "node:assert/strict";
import test from "node:test";

const root = "/copi/library";
const token = "transaction-token";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const expected = { root, token };

function catalogOnlyJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    mode: "catalog-only",
    root,
    token,
    oldCatalog: null,
    newCatalog: digest,
    stableSourcesTree: "absent",
    operations: [],
    ...overrides,
  };
}

async function loadCodec() {
  const codec = await import("../src/storage-journal.ts").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  });
  assert.ok(codec, "storage journal codec module must be available");
  return codec;
}

test("parses v3 catalog-only journals for absent and hashed stable source roots", async () => {
  const { parseStorageJournal } = await loadCodec();
  const values = [
    catalogOnlyJournal(),
    catalogOnlyJournal({ oldCatalog: otherDigest, stableSourcesTree: digest }),
  ];

  for (const value of values) {
    const parsed = parseStorageJournal(value, expected);
    assert.deepEqual(parsed, value);
    assert.notEqual(parsed, value);
    assert.notEqual(parsed.operations, value.operations);
  }
});

test("does not reinterpret empty v2 journals with an absent sources root as catalog-only", async () => {
  const { parseStorageJournal } = await loadCodec();
  const v2 = {
    version: 2,
    root,
    token,
    oldCatalog: null,
    newCatalog: digest,
    stableSourcesTree: "absent",
    operations: [],
  };

  assert.throws(() => parseStorageJournal(v2, expected));
});

test("rejects unsupported v3 mode, version, and root or transaction binding", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = catalogOnlyJournal();
  const missingMode = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "mode"));
  const invalid: unknown[] = [
    { ...value, version: 4 },
    { ...value, mode: "sources" },
    missingMode,
    { ...value, root: "/another/library" },
    { ...value, token: "another-token" },
  ];

  for (const journal of invalid) assert.throws(() => parseStorageJournal(journal, expected));
});

test("rejects malformed v3 catalog and stable-source commitments", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = catalogOnlyJournal();
  const invalid: unknown[] = [
    { ...value, oldCatalog: "g".repeat(64) },
    { ...value, oldCatalog: "a".repeat(63) },
    { ...value, newCatalog: "G".repeat(64) },
    { ...value, newCatalog: "a".repeat(65) },
    { ...value, stableSourcesTree: "missing" },
    { ...value, stableSourcesTree: "f".repeat(63) },
    { ...value, stableSourcesTree: "F".repeat(64) },
  ];

  for (const journal of invalid) assert.throws(() => parseStorageJournal(journal, expected));
});

test("rejects non-empty operations and any stage, ownership, or replacement-target fields", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = catalogOnlyJournal();
  const invalid: unknown[] = [
    { ...value, operations: null },
    { ...value, operations: [{ itemId: "123e4567-e89b-42d3-a456-426614174000" }] },
    { ...value, operations: [{ target: "sources/item.md", kind: "file" }] },
    { ...value, stableSourcesTreeNext: "a".repeat(64) },
    { ...value, nextSourcesTree: "a".repeat(64) },
    { ...value, ownedDirectories: [] },
    { ...value, target: "sources/item.md" },
    { ...value, kind: "file" },
    { ...value, itemId: "123e4567-e89b-42d3-a456-426614174000" },
    { ...value, oldTree: null },
    { ...value, newTree: digest },
    { ...value, stage: "next-sources" },
    { ...value, replacement: { target: "sources/item.md" } },
    { ...value, unexpected: true },
  ];

  for (const journal of invalid) assert.throws(() => parseStorageJournal(journal, expected));
});
