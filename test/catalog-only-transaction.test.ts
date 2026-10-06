import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { catalogBytes } from "../src/catalog.ts";
import { StorageTransactions, type StorageCheckpoint } from "../src/storage-transaction.ts";
import type { Catalog, SavedItem } from "../src/types.ts";
import { sandbox } from "./helpers/sandbox.ts";

const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const itemId = "123e4567-e89b-42d3-a456-426614174000";
const otherItemId = "123e4567-e89b-42d3-a456-426614174001";

function item(id = itemId, name = "Snapshot"): SavedItem {
  return {
    id, kind: "instruction", source: "synthetic", scope: "project", sourcePath: "/fixture/source.md",
    destination: { kind: "project", path: "AGENTS.md" }, name, savedAt: "2026-01-02T03:04:05.000Z",
    files: [{ path: "source.md", mode: 0o600, sha256: digest("catalog snapshot bytes") }],
    content: { kind: "file", path: `sources/${id}/source.md` },
  };
}

function catalog(items: SavedItem[] = [], groups: Catalog["groups"] = []): Catalog {
  return { version: 2, items, groups };
}

async function storeCatalog(libraryDir: string, value: Catalog): Promise<Buffer> {
  await mkdir(libraryDir, { recursive: true });
  const bytes = catalogBytes(value);
  await writeFile(path.join(libraryDir, "catalog.json"), bytes, { mode: 0o600 });
  return bytes;
}

async function commitCatalogOnly(libraryDir: string, next: Catalog, checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>): Promise<void> {
  await new StorageTransactions(checkpoint ? { checkpoint } : {}).run(libraryDir, true, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), catalogBytes(next));
  });
}

function catalogOnlyChild(libraryDir: string, next: Catalog, checkpoint: StorageCheckpoint): ChildProcessWithoutNullStreams {
  const sourceTest = import.meta.url.endsWith(".ts");
  const module = new URL(sourceTest ? "../src/storage-transaction.ts" : "../src/storage-transaction.js", import.meta.url).href;
  const bytes = catalogBytes(next).toString("base64");
  const code = `import {StorageTransactions} from ${JSON.stringify(module)};\nconst tx=new StorageTransactions({checkpoint:async point=>{if(point===${JSON.stringify(checkpoint)}) { console.log('PAUSED'); setInterval(()=>{},1000); await new Promise(()=>{}); }}});\nawait tx.run(${JSON.stringify(libraryDir)},true,async session=>{await session.commit(await session.capture(),Buffer.from(${JSON.stringify(bytes)},'base64'));});`;
  return spawn(process.execPath, [...(sourceTest ? ["--experimental-transform-types"] : []), "--input-type=module", "-e", code], { env: process.env });
}

async function childPaused(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not pause: ${output}`)), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("PAUSED")) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!output.includes("PAUSED")) reject(new Error(`child exited before pause (${code}, ${signal}): ${output}`));
    });
  });
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function commitRawCatalogOnly(libraryDir: string, rawCatalog: Buffer): Promise<void> {
  await new StorageTransactions().run(libraryDir, true, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), rawCatalog);
  });
}

function rawCatalogWithUnknown(value: Catalog, location: readonly (string | number)[]): Buffer {
  const raw: unknown = JSON.parse(catalogBytes(value).toString("utf8"));
  let current = raw;
  for (const segment of location.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment)) throw new Error("Invalid synthetic catalog property path.");
      current = current[segment];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) throw new Error("Invalid synthetic catalog property path.");
      current = (current as Record<string, unknown>)[segment];
    }
  }
  const key = location.at(-1);
  if (typeof key !== "string" || typeof current !== "object" || current === null || Array.isArray(current)) throw new Error("Invalid synthetic catalog property path.");
  (current as Record<string, unknown>)[key] = "synthetic-extra";
  return Buffer.from(`${JSON.stringify(raw, null, 4)}\n`, "utf8");
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([key, child]) => [key, reverseObjectKeyOrder(child)]));
}

async function pauseWriterAtJournal(libraryDir: string, next: Catalog): Promise<string> {
  const writer = catalogOnlyChild(libraryDir, next, "journal");
  try {
    await childPaused(writer);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("close", () => resolve()));
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
  }
  return path.join(libraryDir, ".copi-transaction");
}

async function rebindJournalCatalog(lock: string, field: "oldCatalog" | "newCatalog", catalog: Buffer): Promise<void> {
  const journalPath = path.join(lock, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
  journal[field] = digest(catalog);
  const bytes = Buffer.from(JSON.stringify(journal), "utf8");
  await writeFile(journalPath, bytes);
  await writeFile(path.join(lock, "journal.digest"), digest(bytes));
}

async function recover(libraryDir: string): Promise<void> {
  await new StorageTransactions({ waitMilliseconds: 100 }).run(libraryDir, false, async () => {});
}

test("catalog-only first group commit journals v3 without creating sources", async (t) => {
  const box = await sandbox(t);
  const next = catalog([], [{ id: "daily", name: "Daily", itemIds: [] }]);
  const checkpoints: StorageCheckpoint[] = [];
  let journal: Record<string, unknown> | undefined;
  await commitCatalogOnly(box.libraryDir, next, async (point, root) => {
    checkpoints.push(point);
    if (["stage-write", "stage-sync", "journal", "before-catalog", "committed"].includes(point)) {
      await assert.rejects(lstat(path.join(root, "sources")), { code: "ENOENT" });
    }
    if (point === "journal") {
      const lock = path.join(root, ".copi-transaction");
      journal = JSON.parse(await readFile(path.join(lock, "journal.json"), "utf8")) as Record<string, unknown>;
      assert.equal((await readdir(lock)).includes("next-sources"), false);
    }
  });
  assert.deepEqual(checkpoints.filter((point) => point === "stage-write" || point === "stage-sync" || point === "journal"), ["stage-write", "stage-sync", "journal"]);
  assert.deepEqual(journal && {
    version: journal.version, mode: journal.mode, root: journal.root, oldCatalog: journal.oldCatalog,
    newCatalog: journal.newCatalog, stableSourcesTree: journal.stableSourcesTree, operations: journal.operations,
  }, {
    version: 3, mode: "catalog-only", root: box.libraryDir, oldCatalog: null,
    newCatalog: digest(catalogBytes(next)), stableSourcesTree: "absent", operations: [],
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), next);
  await assert.rejects(lstat(path.join(box.libraryDir, "sources")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only metadata commits repeat without checking stale item SHA against current source bytes", async (t) => {
  const box = await sandbox(t);
  const saved = item();
  const old = catalog([saved], [{ id: "daily", name: "Daily", itemIds: [] }]);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const sourceFile = path.join(box.libraryDir, saved.content.path);
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, "ordinary manual edit; deliberately differs from catalog SHA\n");
  const currentBytes = await readFile(sourceFile);

  const first = structuredClone(old);
  first.items[0]!.name = "Renamed snapshot";
  first.items[0]!.destination = { kind: "project", path: ".pi/skills/renamed" };
  first.groups[0]!.name = "Daily review";
  first.groups[0]!.itemIds.push(saved.id);
  first.groups.push({ id: "later", name: "Later", itemIds: [saved.id] });
  let journal: Record<string, unknown> | undefined;
  await commitCatalogOnly(box.libraryDir, first, async (point, root) => {
    if (point === "journal") journal = JSON.parse(await readFile(path.join(root, ".copi-transaction", "journal.json"), "utf8")) as Record<string, unknown>;
  });
  assert.equal(journal?.version, 3);
  assert.equal(journal?.mode, "catalog-only");
  assert.equal(journal?.oldCatalog, digest(oldBytes));
  assert.match(String(journal?.stableSourcesTree), /^[0-9a-f]{64}$/);
  assert.deepEqual(journal?.operations, []);
  assert.deepEqual(await readFile(sourceFile), currentBytes);
  assert.notDeepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);

  const second = structuredClone(first);
  second.groups[1]!.name = "Later renamed";
  second.groups[1]!.itemIds = [];
  await commitCatalogOnly(box.libraryDir, second);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), second);
  const referenceOnly = structuredClone(second);
  referenceOnly.items[0]!.destination = { kind: "global-only" };
  await commitCatalogOnly(box.libraryDir, referenceOnly);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), referenceOnly);
  assert.deepEqual(await readFile(sourceFile), currentBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only rollback from an absent old catalog restores catalog absence", async (t) => {
  const box = await sandbox(t);
  const next = catalog([], [{ id: "created", name: "Created", itemIds: [] }]);
  await assert.rejects(commitCatalogOnly(box.libraryDir, next, (point) => {
    if (point === "catalog-renamed") throw new Error("injected after exclusive catalog link");
  }), /injected after exclusive catalog link/);
  await assert.rejects(lstat(path.join(box.libraryDir, "catalog.json")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, "sources")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only recovery rolls back an initially absent catalog after a dead writer held no catalog", async (t) => {
  const box = await sandbox(t);
  const next = catalog([], [{ id: "created", name: "Created", itemIds: [] }]);
  const writer = catalogOnlyChild(box.libraryDir, next, "catalog-held");
  try {
    await childPaused(writer);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("close", () => resolve()));
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
  }
  await recover(box.libraryDir);
  await assert.rejects(lstat(path.join(box.libraryDir, "catalog.json")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, "sources")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only rollback restores the held old catalog inode", async (t) => {
  const box = await sandbox(t);
  const old = catalog([], [{ id: "before", name: "Before", itemIds: [] }]);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const before = await lstat(path.join(box.libraryDir, "catalog.json"));
  const next = catalog([], [{ id: "before", name: "After", itemIds: [] }]);
  await assert.rejects(commitCatalogOnly(box.libraryDir, next, (point) => {
    if (point === "catalog-held") throw new Error("injected with old catalog held");
  }), /injected with old catalog held/);
  const restored = await lstat(path.join(box.libraryDir, "catalog.json"));
  assert.equal(restored.dev, before.dev);
  assert.equal(restored.ino, before.ino);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

for (const unknownField of [
  { label: "top-level", path: ["unexpectedMetadata"] },
  { label: "item", path: ["items", 0, "unexpectedMetadata"] },
  { label: "group", path: ["groups", 0, "unexpectedMetadata"] },
  { label: "file descriptor", path: ["items", 0, "files", 0, "unexpectedMetadata"] },
  { label: "content descriptor", path: ["items", 0, "content", "unexpectedMetadata"] },
  { label: "destination descriptor", path: ["items", 0, "destination", "unexpectedMetadata"] },
] as const) {
  test(`catalog-only raw commit rejects unknown ${unknownField.label} properties`, async (t) => {
    const box = await sandbox(t);
    const saved = item();
    const old = catalog([saved], [{ id: "daily", name: "Daily", itemIds: [] }]);
    const oldBytes = await storeCatalog(box.libraryDir, old);
    const next = structuredClone(old);
    next.items[0]!.name = "Renamed while testing raw metadata";
    const rawNext = rawCatalogWithUnknown(next, unknownField.path);

    await assert.rejects(commitRawCatalogOnly(box.libraryDir, rawNext), /unknown|unexpected|canonical|catalog field/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  });
}

test("catalog-only raw commit rejects unknown properties in the existing catalog", async (t) => {
  const box = await sandbox(t);
  const old = catalog([item()], [{ id: "daily", name: "Daily", itemIds: [] }]);
  const rawOld = rawCatalogWithUnknown(old, ["items", 0, "files", 0, "unexpectedMetadata"]);
  await mkdir(box.libraryDir, { recursive: true });
  await writeFile(path.join(box.libraryDir, "catalog.json"), rawOld);
  const next = structuredClone(old);
  next.items[0]!.name = "Renamed while testing raw old catalog";

  await assert.rejects(commitRawCatalogOnly(box.libraryDir, catalogBytes(next)), /unknown|unexpected|canonical|catalog field/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawOld);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only accepts raw JSON whitespace and reordered object keys", async (t) => {
  const box = await sandbox(t);
  const old = catalog([item()], [{ id: "daily", name: "Daily", itemIds: [] }]);
  const rawOld = Buffer.from(`${JSON.stringify(reverseObjectKeyOrder(old), null, 6)}\n`, "utf8");
  await mkdir(box.libraryDir, { recursive: true });
  await writeFile(path.join(box.libraryDir, "catalog.json"), rawOld);
  const next = structuredClone(old);
  next.items[0]!.name = "Renamed with reordered JSON";
  next.groups[0]!.name = "Daily reviewed";
  const rawNext = Buffer.from(`${JSON.stringify(reverseObjectKeyOrder(next), null, 4)}\n`, "utf8");

  await commitRawCatalogOnly(box.libraryDir, rawNext);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawNext);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("catalog-only rejects item/content, group-reference, destination, and duplicate-name hitchhiking", async (t) => {
  const box = await sandbox(t);
  const first = item();
  const second = item(otherItemId, "Other");
  const old = catalog([first, second], [{ id: "daily", name: "Daily", itemIds: [first.id] }]);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const sourceFile = path.join(box.libraryDir, first.content.path);
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, "apiKey=sk_live_synthetic_fixture_only\n");
  const invalid: Catalog[] = [];
  const changedContent = structuredClone(old); changedContent.items[0]!.files[0]!.sha256 = digest("hitchhiked content"); invalid.push(changedContent);
  const changedOrigin = structuredClone(old); changedOrigin.items[0]!.source = "other-origin"; invalid.push(changedOrigin);
  const changedKind = structuredClone(old); changedKind.items[0]!.kind = "subagent"; invalid.push(changedKind);
  const changedScope = structuredClone(old); changedScope.items[0]!.scope = "package"; invalid.push(changedScope);
  const changedSourcePath = structuredClone(old); changedSourcePath.items[0]!.sourcePath = "/other/source.md"; invalid.push(changedSourcePath);
  const changedSavedAt = structuredClone(old); changedSavedAt.items[0]!.savedAt = "2026-01-03T03:04:05.000Z"; invalid.push(changedSavedAt);
  const changedFilePath = structuredClone(old); changedFilePath.items[0]!.files[0]!.path = "renamed.md"; invalid.push(changedFilePath);
  const changedFileMode = structuredClone(old); changedFileMode.items[0]!.files[0]!.mode = 0o640; invalid.push(changedFileMode);
  const changedContentPath = structuredClone(old); changedContentPath.items[0]!.content.path = `sources/${first.id}/renamed.md`; invalid.push(changedContentPath);
  const reorderedItems = structuredClone(old); reorderedItems.items.reverse(); invalid.push(reorderedItems);
  const removedItem = structuredClone(old); removedItem.items.pop(); invalid.push(removedItem);
  const privateDestination = structuredClone(old); privateDestination.items[0]!.destination = { kind: "project", path: ".env/private" }; invalid.push(privateDestination);
  const unknownMember = structuredClone(old); unknownMember.groups[0]!.itemIds.push("123e4567-e89b-42d3-a456-426614174099"); invalid.push(unknownMember);
  const duplicateName = structuredClone(old); duplicateName.items[0]!.name = "Other"; invalid.push(duplicateName);
  for (const next of invalid) await assert.rejects(commitCatalogOnly(box.libraryDir, next));
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);

  const referenceOnly = structuredClone(old);
  referenceOnly.items[0]!.destination = { kind: "global-only" };
  const referenceBytes = await storeCatalog(box.libraryDir, referenceOnly);
  const promoted = structuredClone(referenceOnly);
  promoted.items[0]!.destination = { kind: "project", path: "AGENTS.md" };
  await assert.rejects(commitCatalogOnly(box.libraryDir, promoted), /global|reference|destination/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), referenceBytes);
  assert.equal(await readFile(sourceFile, "utf8"), "apiKey=sk_live_synthetic_fixture_only\n");
});

for (const checkpoint of ["journal", "catalog-held", "catalog-renamed", "finalized"] as const) {
  test(`catalog-only dead-writer recovery at ${checkpoint} completes only a checked catalog state`, async (t) => {
    const box = await sandbox(t);
    const old = catalog([], [{ id: "before", name: "Before", itemIds: [] }]);
    const oldBytes = await storeCatalog(box.libraryDir, old);
    const next = catalog([], [{ id: "before", name: "After", itemIds: [] }]);
    const writer = catalogOnlyChild(box.libraryDir, next, checkpoint);
    try {
      await childPaused(writer);
      writer.kill("SIGKILL");
      const exit = await new Promise<{ signal: NodeJS.Signals | null }>((resolve) => writer.once("close", (_code, signal) => resolve({ signal })));
      assert.equal(exit.signal, "SIGKILL");
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
    }
    await recover(box.libraryDir);
    const actual = await readFile(path.join(box.libraryDir, "catalog.json"));
    assert.deepEqual(actual, checkpoint === "journal" || checkpoint === "catalog-held" ? oldBytes : catalogBytes(next));
    await assert.rejects(lstat(path.join(box.libraryDir, "sources")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  });
}

for (const corruption of ["unknown stage", "altered digest", "foreign owner nonce"] as const) {
  test(`catalog-only recovery preserves journal and catalog for ${corruption}`, async (t) => {
    const box = await sandbox(t);
    const old = catalog([], [{ id: "before", name: "Before", itemIds: [] }]);
    const oldBytes = await storeCatalog(box.libraryDir, old);
    const next = catalog([], [{ id: "before", name: "After", itemIds: [] }]);
    const writer = catalogOnlyChild(box.libraryDir, next, "journal");
    try {
      await childPaused(writer);
      writer.kill("SIGKILL");
      await new Promise<void>((resolve) => writer.once("close", () => resolve()));
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
    }
    const lock = path.join(box.libraryDir, ".copi-transaction");
    if (corruption === "unknown stage") await writeFile(path.join(lock, "next-0"), "unowned stage");
    else if (corruption === "altered digest") await writeFile(path.join(lock, "journal.digest"), "f".repeat(64));
    else {
      const ownerPath = path.join(lock, "owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token: string };
      owner.token = randomUUID();
      await writeFile(ownerPath, JSON.stringify(owner));
    }
    await assert.rejects(recover(box.libraryDir), /unknown|altered|digest|journal|token|commitment|owner/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
    assert.ok(await lstat(path.join(lock, "journal.json")));
    assert.ok(await lstat(lock));
  });
}

test("catalog-only recovery retains a raw next catalog with an unknown property even when journal hashes match", async (t) => {
  const box = await sandbox(t);
  const old = catalog([item()], [{ id: "daily", name: "Daily", itemIds: [] }]);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const next = structuredClone(old);
  next.items[0]!.name = "Unknown raw next metadata";
  const lock = await pauseWriterAtJournal(box.libraryDir, next);
  const rawNext = rawCatalogWithUnknown(next, ["items", 0, "files", 0, "unexpectedMetadata"]);
  await writeFile(path.join(lock, "next-catalog"), rawNext);
  await rebindJournalCatalog(lock, "newCatalog", rawNext);
  const journalBytes = await readFile(path.join(lock, "journal.json"));

  await assert.rejects(recover(box.libraryDir), /unknown|unexpected|canonical|catalog field/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
  assert.deepEqual(await readFile(path.join(lock, "next-catalog")), rawNext);
  assert.deepEqual(await readFile(path.join(lock, "journal.json")), journalBytes);
  assert.equal((await readFile(path.join(lock, "journal.digest"), "utf8")), digest(journalBytes));
});

test("catalog-only recovery retains a raw old catalog with an unknown property", async (t) => {
  const box = await sandbox(t);
  const old = catalog([item()], [{ id: "daily", name: "Daily", itemIds: [] }]);
  await storeCatalog(box.libraryDir, old);
  const next = structuredClone(old);
  next.items[0]!.name = "Unknown raw old metadata";
  const lock = await pauseWriterAtJournal(box.libraryDir, next);
  const rawOld = rawCatalogWithUnknown(old, ["groups", 0, "unexpectedMetadata"]);
  await writeFile(path.join(lock, "old-catalog"), rawOld);
  await rebindJournalCatalog(lock, "oldCatalog", rawOld);
  const journalBytes = await readFile(path.join(lock, "journal.json"));

  await assert.rejects(recover(box.libraryDir), /unknown|unexpected|canonical|catalog field/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawOld);
  assert.deepEqual(await readFile(path.join(lock, "old-catalog")), rawOld);
  assert.deepEqual(await readFile(path.join(lock, "journal.json")), journalBytes);
  assert.equal((await readFile(path.join(lock, "journal.digest"), "utf8")), digest(journalBytes));
});

test("catalog-only commit stops before catalog installation when sources root appears during staging", async (t) => {
  const box = await sandbox(t);
  const next = catalog([], [{ id: "created", name: "Created", itemIds: [] }]);
  const externalRoot = path.join(box.libraryDir, "sources");
  let inserted = false;
  await assert.rejects(commitCatalogOnly(box.libraryDir, next, async (point) => {
    if (point === "journal") {
      inserted = true;
      await mkdir(externalRoot);
      await writeFile(path.join(externalRoot, "keep.txt"), "external staged-state change\\n");
    }
  }), /sources|tree|changed|recover/i);
  assert.equal(inserted, true);
  assert.equal(await readFile(path.join(externalRoot, "keep.txt"), "utf8"), "external staged-state change\\n");
  await assert.rejects(lstat(path.join(box.libraryDir, "catalog.json")), { code: "ENOENT" });
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
});

test("catalog-only recovery stops and retains journal when sources root appears after an absent-root review", async (t) => {
  const box = await sandbox(t);
  const old = catalog([], [{ id: "before", name: "Before", itemIds: [] }]);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const next = catalog([], [{ id: "before", name: "After", itemIds: [] }]);
  const writer = catalogOnlyChild(box.libraryDir, next, "journal");
  try {
    await childPaused(writer);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("close", () => resolve()));
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
  }
  const outside = path.join(box.root, "outside-sources");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "external fixture bytes\n");
  await symlink(outside, path.join(box.libraryDir, "sources"));
  await assert.rejects(recover(box.libraryDir), /sources|tree|changed|symbolic/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "external fixture bytes\n");
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
});

test("catalog-only recovery preserves ordinary source edits made after journaling", async (t) => {
  const box = await sandbox(t);
  const saved = item();
  const old = catalog([saved], []);
  const oldBytes = await storeCatalog(box.libraryDir, old);
  const sourceFile = path.join(box.libraryDir, saved.content.path);
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, "before recovery\n");
  const next = structuredClone(old); next.items[0]!.name = "Changed";
  const writer = catalogOnlyChild(box.libraryDir, next, "journal");
  try {
    await childPaused(writer);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("close", () => resolve()));
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
  }
  await writeFile(sourceFile, "external ordinary source edit\n");
  await assert.rejects(recover(box.libraryDir), /sources|tree|changed|revision/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), oldBytes);
  assert.equal(await readFile(sourceFile, "utf8"), "external ordinary source edit\n");
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
});

test("catalog-only cleanup interruption with a missing artifact retains the journal and remaining state", async (t) => {
  const box = await sandbox(t);
  const old = catalog([], [{ id: "before", name: "Before", itemIds: [] }]);
  await storeCatalog(box.libraryDir, old);
  const next = catalog([], [{ id: "before", name: "After", itemIds: [] }]);
  const writer = catalogOnlyChild(box.libraryDir, next, "finalized");
  try {
    await childPaused(writer);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("close", () => resolve()));
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) await killChild(writer);
  }
  const lock = path.join(box.libraryDir, ".copi-transaction");
  // Simulate power loss after finalization metadata was removed and the first sorted artifact was deleted.
  await unlink(path.join(lock, "finalized.digest"));
  await unlink(path.join(lock, "finalized.json"));
  await unlink(path.join(lock, "held-catalog"));
  await assert.rejects(recover(box.libraryDir), /newly verified recovery build/i);
  assert.ok(await lstat(path.join(lock, "journal.json")));
  assert.ok(await lstat(path.join(lock, "old-catalog")));
  assert.ok(await lstat(path.join(lock, "next-catalog")));
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), next);
  assert.deepEqual((await readdir(lock)).sort(), ["journal.digest", "journal.json", "next-catalog", "old-catalog", "owner.json"]);
  console.log("R3 v3 cleanup interruption: missing held-catalog retained journal/remaining stages/catalog; manual inspection with newly verified recovery build required");
});
