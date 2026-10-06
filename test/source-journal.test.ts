import assert from "node:assert/strict";
import test from "node:test";
import type { Catalog, ContentLocation, SavedItem } from "../src/types.ts";
import type { LegacyStorageJournal, SourcesStorageJournal } from "../src/storage-journal.ts";

const idOne = "123e4567-e89b-42d3-a456-426614174000";
const idTwo = "123e4567-e89b-42d3-a456-426614174001";
const root = "/copi/library";
const token = "transaction-token";
const expected = { root, token };
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

async function loadCodec() {
  const codec = await import("../src/storage-journal.ts").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  });
  assert.ok(codec, "storage journal codec module must be available");
  return codec;
}

function legacyJournal(): LegacyStorageJournal {
  return {
    version: 1,
    root,
    token,
    oldCatalog: null,
    newCatalog: digest,
    operations: [{ itemId: idOne, oldTree: null, newTree: otherDigest }],
  };
}

function sourcesJournal(): SourcesStorageJournal {
  return {
    version: 2,
    root,
    token,
    oldCatalog: digest,
    newCatalog: otherDigest,
    stableSourcesTree: digest,
    stableSourcesTreeNext: digest,
    nextSourcesTree: otherDigest,
    ownedDirectories: [],
    operations: [
      { itemId: idOne, target: "sources/instructions.md", kind: "file", oldTree: digest, newTree: otherDigest },
      { itemId: idTwo, target: "sources/skill", kind: "tree", oldTree: null, newTree: digest },
    ],
  };
}

function savedItem(id: string, content: ContentLocation, kind: SavedItem["kind"] = content.kind === "tree" ? "skill" : "instruction"): SavedItem {
  return {
    id,
    kind,
    source: "origin",
    scope: "project",
    sourcePath: "/deleted/origin",
    destination: { kind: "project", path: "AGENTS.md" },
    name: id,
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: content.kind === "file" ? content.path.split("/").at(-1)! : "SKILL.md", mode: 0o644, sha256: digest }],
    content,
  };
}

function catalog(items: SavedItem[]): Catalog {
  return { version: 2, items, groups: [] };
}

test("accepts legacy v1 journals with the implicit items/<UUID> operation contract", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = legacyJournal();
  const parsed = parseStorageJournal(value, expected);
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.operations, value.operations);
  assert.notEqual(parsed.operations[0], value.operations[0]);
  assert.equal("target" in parsed.operations[0]!, false);
});

test("accepts and deep-copies v2 sources targets without aliasing caller objects", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = sourcesJournal();
  const parsed = parseStorageJournal(value, expected);
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.operations, value.operations);
  for (const index of value.operations.keys()) assert.notEqual(parsed.operations[index], value.operations[index]);
});

test("accepts new-file custody metadata only for its addition operation in a mixed v2 journal", async () => {
  const { parseStorageJournal, validateSourcesJournalTargets } = await loadCodec();
  const base = sourcesJournal();
  const newFileTarget = `sources/${idTwo}/notes.md`;
  const journal: SourcesStorageJournal = {
    ...base,
    operations: [
      base.operations[0]!,
      { itemId: idTwo, target: newFileTarget, kind: "file", oldTree: null, newTree: digest },
    ],
    ownedDirectories: [{ path: `sources/${idTwo}`, stage: "next-1", dev: 7, ino: 9 }],
  };
  const parsed = parseStorageJournal(journal, expected);
  assert.deepEqual(parsed, journal);
  assert.equal(parsed.operations[0]!.oldTree, digest);
  assert.equal(parsed.operations[1]!.oldTree, null);

  const previous = catalog([savedItem(idOne, { kind: "file", path: "sources/instructions.md" })]);
  const next = catalog([...previous.items, savedItem(idTwo, { kind: "file", path: newFileTarget })]);
  assert.doesNotThrow(() => validateSourcesJournalTargets(parsed, previous, next));

  const custodyAssignedToReplacement = {
    ...journal,
    ownedDirectories: [{ path: `sources/${idOne}`, stage: "next-0", dev: 7, ino: 9 }],
  };
  assert.throws(() => parseStorageJournal(custodyAssignedToReplacement, expected));
});

test("rejects unknown versions, non-object envelopes, bad root/token, and malformed operation arrays", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = legacyJournal();
  const invalid: unknown[] = [
    null,
    [],
    "journal",
    { ...valid, version: 3 },
    { ...valid, root: "/another/library" },
    { ...valid, token: "another-token" },
    { ...valid, operations: null },
    { ...valid, operations: {} },
    { ...valid, operations: [null] },
    { ...valid, unexpected: true },
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expected));
});

test("rejects malformed or duplicate item UUIDs", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = legacyJournal();
  assert.throws(() => parseStorageJournal({ ...valid, operations: [{ ...valid.operations[0]!, itemId: "not-a-uuid" }] }, expected));
  assert.throws(() => parseStorageJournal({ ...valid, operations: [valid.operations[0]!, { ...valid.operations[0]! }] }, expected));
});

test("rejects malformed SHA-256 catalog and tree commitments for both journal versions", async () => {
  const { parseStorageJournal } = await loadCodec();
  const v1 = legacyJournal();
  const v2 = sourcesJournal();
  const invalid: unknown[] = [
    { ...v1, newCatalog: "f".repeat(63) },
    { ...v1, oldCatalog: "not-a-digest" },
    { ...v1, operations: [{ ...v1.operations[0]!, newTree: "g".repeat(64) }] },
    { ...v1, operations: [{ ...v1.operations[0]!, oldTree: "" }] },
    { ...v2, newCatalog: "f".repeat(65) },
    { ...v2, oldCatalog: "G".repeat(64) },
    { ...v2, stableSourcesTree: "not-a-digest" },
    { ...v2, operations: [{ ...v2.operations[0]!, newTree: "g".repeat(64) }, v2.operations[1]!] },
    { ...v2, operations: [{ ...v2.operations[0]!, oldTree: "" }, v2.operations[1]!] },
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expected));
});

test("rejects unsafe and non-sources v2 target paths", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = sourcesJournal();
  const badTargets = [
    "sources/../outside",
    "/sources/absolute",
    "items/123e4567-e89b-42d3-a456-426614174000",
    "sources//empty-segment",
    "sources/./dot",
    "sources\\windows-path",
    "sources/private/.env.local",
  ];
  for (const target of badTargets) {
    const operations = [{ ...valid.operations[0]!, target }, valid.operations[1]!];
    assert.throws(() => parseStorageJournal({ ...valid, operations }, expected), `target ${JSON.stringify(target)} must be rejected`);
  }
});

test("rejects duplicate or ancestor-overlapping v2 targets", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = sourcesJournal();
  const duplicate = [
    valid.operations[0]!,
    { ...valid.operations[1]!, target: valid.operations[0]!.target },
  ];
  const overlapping = [
    { ...valid.operations[0]!, target: "sources/shared" },
    { ...valid.operations[1]!, target: "sources/shared/child.md" },
  ];
  assert.throws(() => parseStorageJournal({ ...valid, operations: duplicate }, expected));
  assert.throws(() => parseStorageJournal({ ...valid, operations: overlapping }, expected));
});

test("validates v2 operation targets against next and previous catalogs", async () => {
  const { validateSourcesJournalTargets } = await loadCodec();
  const journal = sourcesJournal();
  const previous = catalog([savedItem(idOne, { kind: "file", path: "sources/instructions.md" })]);
  const next = catalog([
    savedItem(idOne, { kind: "file", path: "sources/instructions.md" }),
    savedItem(idTwo, { kind: "tree", path: "sources/skill" }),
  ]);
  assert.doesNotThrow(() => validateSourcesJournalTargets(journal, previous, next));
});

test("rejects operation targets that do not match the next catalog or any next item", async () => {
  const { validateSourcesJournalTargets } = await loadCodec();
  const journal = sourcesJournal();
  const next = catalog([
    savedItem(idOne, { kind: "file", path: "sources/instructions.md" }),
    savedItem(idTwo, { kind: "tree", path: "sources/skill" }),
  ]);
  const wrongTarget: SourcesStorageJournal = {
    ...journal,
    operations: [{ ...journal.operations[0]!, target: "sources/other.md" }, journal.operations[1]!],
  };
  const unknownItem: SourcesStorageJournal = {
    ...journal,
    operations: [{ ...journal.operations[0]!, itemId: "123e4567-e89b-42d3-a456-426614174002" }, journal.operations[1]!],
  };
  assert.throws(() => validateSourcesJournalTargets(wrongTarget, null, next));
  assert.throws(() => validateSourcesJournalTargets(unknownItem, null, next));
});

test("rejects a changed target for an existing item in the previous catalog", async () => {
  const { validateSourcesJournalTargets } = await loadCodec();
  const journal = sourcesJournal();
  const previous = catalog([savedItem(idOne, { kind: "file", path: "sources/previous.md" })]);
  const next = catalog([savedItem(idOne, { kind: "file", path: "sources/instructions.md" })]);
  assert.throws(() => validateSourcesJournalTargets({ ...journal, operations: [journal.operations[0]!] }, previous, next));
});

test("requires oldTree for existing items and null oldTree for newly added items", async () => {
  const { validateSourcesJournalTargets } = await loadCodec();
  const base = sourcesJournal();
  const existing = catalog([savedItem(idOne, { kind: "file", path: "sources/instructions.md" })]);
  const next = catalog([
    savedItem(idOne, { kind: "file", path: "sources/instructions.md" }),
    savedItem(idTwo, { kind: "tree", path: "sources/skill" }),
  ]);
  const missingOldTree: SourcesStorageJournal = {
    ...base,
    operations: [{ ...base.operations[0]!, oldTree: null }],
  };
  const unexpectedOldTree: SourcesStorageJournal = {
    ...base,
    operations: [{ ...base.operations[1]!, oldTree: digest }],
  };
  assert.throws(() => validateSourcesJournalTargets(missingOldTree, existing, next));
  assert.throws(() => validateSourcesJournalTargets(unexpectedOldTree, existing, next));
});

test("requires journal operation kind to match the next catalog content kind", async () => {
  const { validateSourcesJournalTargets } = await loadCodec();
  const journal = sourcesJournal();
  const next = catalog([
    savedItem(idOne, { kind: "file", path: "sources/instructions.md" }),
    savedItem(idTwo, { kind: "tree", path: "sources/skill" }),
  ]);
  const wrongKind: SourcesStorageJournal = {
    ...journal,
    operations: [{ ...journal.operations[0]!, kind: "tree" }, journal.operations[1]!],
  };
  assert.throws(() => validateSourcesJournalTargets(wrongKind, null, next));
});
