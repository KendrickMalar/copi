import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageTransactions } from "../src/storage-transaction.ts";
import type { Catalog, LegacyCatalog, SavedItem } from "../src/types.ts";

const idOne = "123e4567-e89b-42d3-a456-426614174000";
const idTwo = "123e4567-e89b-42d3-a456-426614174001";
const root = "/copi/library";
const token = "transaction-token";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const thirdDigest = "c".repeat(64);
const backupDir = ".migration-backups/123e4567-e89b-42d3-a456-426614174000";
const expected = { root, token };
const expectedV5 = { root, token: "123e4567-e89b-42d3-a456-426614174099" };

function migrationJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    mode: "legacy-migration",
    root,
    token,
    oldCatalog: digest,
    newCatalog: otherDigest,
    stableItemsTree: digest,
    stableSourcesTree: "absent",
    stableSourcesTreeNext: thirdDigest,
    backupDir,
    backupManifest: digest,
    operations: [{ itemId: idOne, target: `sources/${idOne}/README.md`, kind: "file", oldTree: null, newTree: otherDigest }],
    ownedDirectories: [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "12" },
    ],
    nextSourcesTree: thirdDigest,
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

function oldItem(id = idOne): Omit<SavedItem, "content"> {
  return {
    id,
    kind: "instruction",
    source: "origin",
    scope: "project",
    sourcePath: "/deleted/origin/README.md",
    destination: { kind: "project", path: "AGENTS.md" },
    name: "Original instruction",
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "README.md", mode: 0o644, sha256: digest }],
  };
}

function legacyCatalog(): LegacyCatalog {
  return { version: 1, items: [oldItem()], groups: [] };
}

function nextCatalog(path = `sources/${idOne}/README.md`): Catalog {
  return { version: 2, items: [{ ...oldItem(), content: { kind: "file", path } }], groups: [] };
}

function callMigrationValidator(codec: Awaited<ReturnType<typeof loadCodec>>, journal: unknown, old: unknown, next: unknown): void {
  const validator = (codec as unknown as {
    validateLegacyMigrationJournalTargets?: (journal: unknown, previous: unknown, next: unknown) => void;
  }).validateLegacyMigrationJournalTargets;
  assert.equal(typeof validator, "function", "a separate v4 catalog/target validator must be available to the later kernel");
  validator!(journal, old, next);
}

test("parses an exact v4 legacy-migration journal and detaches caller-owned nested data", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = migrationJournal();
  const parsed = parseStorageJournal(value, expected) as unknown as { version: number; mode?: string; operations: unknown[] };
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.operations, value.operations);
  assert.notEqual(parsed.operations[0], (value.operations as unknown[])[0]);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.mode, "legacy-migration");
});

test("keeps v1, v2, and v3 journal wire shapes and interpretations unchanged", async () => {
  const { parseStorageJournal } = await loadCodec();
  const values: Array<Record<string, unknown>> = [
    { version: 1, root, token, oldCatalog: null, newCatalog: digest, operations: [{ itemId: idOne, oldTree: null, newTree: digest }] },
    { version: 2, root, token, oldCatalog: digest, newCatalog: otherDigest, stableSourcesTree: digest, operations: [] },
    { version: 3, mode: "catalog-only", root, token, oldCatalog: digest, newCatalog: otherDigest, stableSourcesTree: digest, operations: [] },
  ];
  for (const value of values) {
    const parsed = parseStorageJournal(value, expected);
    assert.deepEqual(parsed, value);
    assert.equal(parsed.version, value.version);
  }
});

test("rejects v4 journals with missing, extra, rebound, or malformed top-level fields", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = migrationJournal();
  const missingOldCatalog = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "oldCatalog"));
  const invalid: unknown[] = [
    { ...valid, version: 1 },
    { ...valid, mode: "catalog-only" },
    { ...valid, root: "/another/library" },
    { ...valid, token: "another-token" },
    { ...valid, oldCatalog: null },
    { ...valid, oldCatalog: "g".repeat(64) },
    { ...valid, newCatalog: "a".repeat(63) },
    { ...valid, stableItemsTree: "missing" },
    { ...valid, stableItemsTree: "absent" },
    { ...valid, stableSourcesTree: "A".repeat(64) },
    { ...valid, stableSourcesTreeNext: "absent" },
    { ...valid, backupManifest: "f".repeat(65) },
    { ...valid, unexpected: true },
    missingOldCatalog,
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expected));
});

test("rejects v4 operations with unsafe, overlapping, rebound, or non-addition targets", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = migrationJournal();
  const operation = (overrides: Record<string, unknown> = {}) => ({
    itemId: idOne, target: `sources/${idOne}/README.md`, kind: "file", oldTree: null, newTree: otherDigest, ...overrides,
  });
  const badTargets = [
    "/sources/absolute.md", "sources/../outside.md", "sources\\windows.md", "sources//empty.md",
    "sources/${idOne}/.envrc", "sources/${idOne}/node_modules/child", "sources/${idOne}/./file.md",
  ];
  const invalid: unknown[] = [
    { ...valid, operations: [{ ...operation({ target: badTargets[0] }) }] },
    ...badTargets.slice(1).map((target) => ({ ...valid, operations: [operation({ target })] })),
    { ...valid, operations: [operation({ oldTree: digest })] },
    { ...valid, operations: [operation({ newTree: "x".repeat(64) })] },
    { ...valid, operations: [operation({ extra: true })] },
    {
      ...valid,
      ownedDirectories: [
        { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
        { path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "12", extra: true },
      ],
    },
    (() => { const missingNext = { ...valid }; delete missingNext.nextSourcesTree; return missingNext; })(),
    { ...valid, operations: [operation({ kind: "directory" })] },
    { ...valid, operations: [operation({ itemId: "not-a-uuid" })] },
    { ...valid, operations: [operation(), operation()] },
    {
      ...valid,
      operations: [operation(), { ...operation({ itemId: idTwo, target: `sources/${idOne}/README.md/child` }) }],
      ownedDirectories: [
        { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
        { path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "12" },
        { path: `sources/${idTwo}`, stage: "next-sources", dev: "8", ino: "13" },
      ],
    },
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expected));
});

test("accepts adopt-only journals only when the source commitment is unchanged and custody is empty", async () => {
  const { parseStorageJournal } = await loadCodec();
  const adoptOnly = {
    ...migrationJournal({ stableSourcesTree: digest, stableSourcesTreeNext: digest, operations: [], ownedDirectories: [] }),
  };
  delete adoptOnly.nextSourcesTree;
  assert.deepEqual(parseStorageJournal(adoptOnly, expected), adoptOnly);

  for (const invalid of [
    { ...adoptOnly, stableSourcesTreeNext: otherDigest },
    { ...adoptOnly, ownedDirectories: [{ path: "sources", stage: "next-sources", dev: "1", ino: "2" }] },
    { ...adoptOnly, nextSourcesTree: digest },
  ]) assert.throws(() => parseStorageJournal(invalid, expected));
});

test("requires strict root/new-file-parent custody and lossless uint64 decimal identities", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = migrationJournal();
  assert.doesNotThrow(() => parseStorageJournal(valid, expected));
  const malformedCustody = [
    [{ path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "12" }],
    [{ path: "sources", stage: "next-sources", dev: "8", ino: "11" }],
    [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-0", dev: "8", ino: "12" },
    ],
    [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-sources", dev: "08", ino: "12" },
    ],
    [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "18446744073709551616" },
    ],
    [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-sources", dev: 8, ino: "12" },
    ],
    [
      { path: "sources", stage: "next-sources", dev: "8", ino: "11" },
      { path: `sources/${idOne}`, stage: "next-sources", dev: "8", ino: "12" },
      { path: `sources/${idTwo}`, stage: "next-sources", dev: "8", ino: "13" },
    ],
  ];
  for (const ownedDirectories of malformedCustody) {
    assert.throws(() => parseStorageJournal({ ...valid, ownedDirectories }, expected));
  }

  const existingSources = {
    ...valid,
    stableSourcesTree: digest,
    stableSourcesTreeNext: otherDigest,
    ownedDirectories: [{ path: `sources/${idOne}`, stage: "next-0", dev: "18446744073709551615", ino: "18446744073709551615" }],
  };
  delete (existingSources as Record<string, unknown>).nextSourcesTree;
  assert.doesNotThrow(() => parseStorageJournal(existingSources, expected));
  assert.throws(() => parseStorageJournal({ ...existingSources, nextSourcesTree: digest }, expected));
});

test("rejects backup directory escape, noncanonical UUID, and invalid manifest commitments", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = migrationJournal();
  const invalid: unknown[] = [
    { ...valid, backupDir: "/.migration-backups/123e4567-e89b-42d3-a456-426614174000" },
    { ...valid, backupDir: ".migration-backups/../outside" },
    { ...valid, backupDir: ".migration-backups\\123e4567-e89b-42d3-a456-426614174000" },
    { ...valid, backupDir: ".migration-backups/123e4567-e89b-12d3-a456-426614174000" },
    { ...valid, backupDir: ".migration-backups/123e4567-e89b-42d3-a456-426614174000/extra" },
    { ...valid, backupManifest: null },
    { ...valid, backupManifest: "z".repeat(64) },
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expected));
});

test("binds each new-only operation to the corresponding v1 and v2 catalog item", async () => {
  const codec = await loadCodec();
  const { parseStorageJournal } = codec;
  const journal = parseStorageJournal(migrationJournal(), expected);
  callMigrationValidator(codec, journal, legacyCatalog(), nextCatalog());

  assert.throws(() => callMigrationValidator(codec, journal, legacyCatalog(), nextCatalog(`sources/${idOne}/elsewhere.md`)));
  const modifiedLegacy = legacyCatalog();
  modifiedLegacy.items[0]!.name = "changed during migration";
  assert.throws(() => callMigrationValidator(codec, journal, modifiedLegacy, nextCatalog()));
  assert.throws(() => callMigrationValidator(codec, journal, legacyCatalog(), { ...nextCatalog(), groups: [{ id: "daily", name: "Daily", itemIds: [idOne] }] }));
  assert.throws(() => callMigrationValidator(codec, { ...journal, stableItemsTree: "absent" }, legacyCatalog(), nextCatalog()));

  const mismatchedPrevious = legacyCatalog();
  mismatchedPrevious.items[0]!.files[0]!.path = "OTHER.md";
  const mismatchedNext = nextCatalog();
  mismatchedNext.items[0]!.files[0]!.path = "OTHER.md";
  assert.throws(() => callMigrationValidator(codec, journal, mismatchedPrevious, mismatchedNext));

  const skillPrevious = legacyCatalog();
  skillPrevious.items[0]!.kind = "skill";
  skillPrevious.items[0]!.files = [{ path: "SKILL.md", mode: 0o644, sha256: digest }];
  const skillNext: Catalog = {
    version: 2,
    items: [{ ...skillPrevious.items[0]!, content: { kind: "tree", path: `sources/${idOne}` } }],
    groups: [],
  };
  const treeJournal = parseStorageJournal(migrationJournal({
    operations: [{ itemId: idOne, target: `sources/${idOne}`, kind: "tree", oldTree: null, newTree: otherDigest }],
    ownedDirectories: [{ path: "sources", stage: "next-sources", dev: "8", ino: "11" }],
  }), expected);
  callMigrationValidator(codec, treeJournal, skillPrevious, skillNext);
});

test("validates an adoption-only catalog transition without inventing source operations", async () => {
  const codec = await loadCodec();
  const { parseStorageJournal } = codec;
  const value = migrationJournal({ stableSourcesTree: digest, stableSourcesTreeNext: digest, operations: [], ownedDirectories: [] });
  delete value.nextSourcesTree;
  const journal = parseStorageJournal(value, expected);
  callMigrationValidator(codec, journal, legacyCatalog(), nextCatalog());
});

test("does not treat v4 fields as an extension of a legacy v1 journal", async () => {
  const { parseStorageJournal } = await loadCodec();
  const oldV1 = { version: 1, root, token, oldCatalog: null, newCatalog: digest, operations: [], mode: "legacy-migration" };
  assert.throws(() => parseStorageJournal(oldV1, expected));
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function v5Inventory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const catalogHash = hashBytes("catalog-v1");
  const nodes = [
    { path: ".", kind: "directory", mode: 0o700, dev: "1", ino: "2", bytesHash: hashBytes(Buffer.concat([
      Buffer.from("copi-directory-v1\0"), Buffer.from(canonicalJson([["catalog.json", "file"]])),
    ])) },
    { path: "catalog.json", kind: "file", mode: 0o600, dev: "1", ino: "3", bytesHash: catalogHash },
  ];
  return {
    version: 1,
    nodes,
    hash: hashBytes(Buffer.concat([Buffer.from("copi-inventory-v1\0"), Buffer.from(canonicalJson(nodes))])),
    ...overrides,
  };
}

function migrationJournalV5(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startInventory = v5Inventory();
  const catalogNode = (startInventory.nodes as Array<Record<string, unknown>>).find((node) => node.path === "catalog.json");
  assert.ok(catalogNode);
  return {
    version: 5,
    mode: "legacy-migration",
    root,
    token: "123e4567-e89b-42d3-a456-426614174099",
    oldCatalog: catalogNode.bytesHash,
    newCatalog: otherDigest,
    stableItemsTree: "absent",
    stableSourcesTree: "absent",
    stableSourcesTreeNext: "absent",
    backupDir: ".migration-backups/123e4567-e89b-42d3-a456-426614174000",
    backupManifest: thirdDigest,
    operations: [],
    ownedDirectories: [],
    startInventory,
    ...overrides,
  };
}

test("strictly parses and detaches an adopt-only v5 journal with a hashed full-start inventory", async () => {
  const { parseStorageJournal } = await loadCodec();
  const value = migrationJournalV5();
  const parsed = parseStorageJournal(value, expectedV5) as unknown as Record<string, unknown>;
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed, value);
  assert.notEqual(parsed.startInventory, value.startInventory);
  assert.notEqual((parsed.startInventory as Record<string, unknown>).nodes, (value.startInventory as Record<string, unknown>).nodes);
  assert.equal(parsed.version, 5);
});

test("rejects v5 non-adopt-only shape and malformed inventory commitments", async () => {
  const { parseStorageJournal } = await loadCodec();
  const valid = migrationJournalV5();
  const inventory = valid.startInventory as Record<string, unknown>;
  const nodes = inventory.nodes as Array<Record<string, unknown>>;
  const invalid: unknown[] = [
    { ...valid, unexpected: true },
    { ...valid, nextSourcesTree: otherDigest },
    { ...valid, token: expectedV5.token.toUpperCase() },
    { ...valid, stableSourcesTreeNext: otherDigest },
    { ...valid, operations: [{ itemId: idOne }] },
    { ...valid, ownedDirectories: [{ path: "sources", stage: "next-sources", dev: "1", ino: "2" }] },
    { ...valid, startInventory: { ...inventory, hash: digest } },
    { ...valid, startInventory: { ...inventory, nodes: [...nodes, nodes[1]] } },
    { ...valid, startInventory: { ...inventory, nodes: [nodes[0], { ...nodes[1], extra: true }] } },
    (() => { const candidate = migrationJournalV5(); Object.defineProperty(candidate, "mode", { enumerable: true, get: () => "legacy-migration" }); return candidate; })(),
    (() => { const candidate = v5Inventory(); Object.defineProperty(candidate, Symbol("unexpected"), { value: true }); return { ...valid, startInventory: candidate }; })(),
    { ...valid, startInventory: { ...inventory, nodes: [...nodes].reverse() } },
    { ...valid, startInventory: { ...inventory, nodes: [nodes[0], { ...nodes[1], path: "items/../escape" }] } },
    { ...valid, startInventory: { ...inventory, nodes: [nodes[0], { ...nodes[1], ino: "18446744073709551616" }] } },
  ];
  for (const value of invalid) assert.throws(() => parseStorageJournal(value, expectedV5));
});

test("stops safely on a v4 recovery journal until the dedicated kernel is implemented", async () => {
  const library = await mkdtemp(path.join(os.tmpdir(), "copi-v4-recovery-"));
  const token = "123e4567-e89b-42d3-a456-426614174099";
  const lock = path.join(library, ".copi-transaction");
  await mkdir(lock, { mode: 0o700 });
  const ownerBytes = Buffer.from(JSON.stringify({ version: 1, pid: 2_147_483_647, host: os.hostname(), token }));
  const journalBytes = Buffer.from(JSON.stringify(migrationJournal({ root: library, token })));
  const journalDigest = Buffer.from(`${createHash("sha256").update(journalBytes).digest("hex")}`);
  await writeFile(path.join(lock, "owner.json"), ownerBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "journal.json"), journalBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "journal.digest"), journalDigest, { mode: 0o600 });

  try {
    await assert.rejects(
      new StorageTransactions({ waitMilliseconds: 100 }).run(library, false, async () => assert.fail("v4 recovery must stop before issuing a session")),
      /Legacy migration v4 recovery is not implemented/,
    );
    assert.deepEqual(await readFile(path.join(lock, "owner.json")), ownerBytes);
    assert.deepEqual(await readFile(path.join(lock, "journal.json")), journalBytes);
    assert.deepEqual(await readFile(path.join(lock, "journal.digest")), journalDigest);
    await assert.rejects(readFile(path.join(library, ".copi-transaction-recovery")), { code: "ENOENT" });
  } finally {
    await rm(library, { recursive: true, force: true });
  }
});
