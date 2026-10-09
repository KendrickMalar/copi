import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { StorageTransactions } from "../src/storage-transaction.ts";

const validEmptyCatalog = Buffer.from('{"version":2,"items":[],"groups":[]}\n');
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function library(t: test.TestContext, catalogBytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-cleanup-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  await mkdir(libraryDir, { mode: 0o700 });
  const catalogPath = path.join(libraryDir, "catalog.json");
  await writeFile(catalogPath, catalogBytes, { mode: 0o600 });
  return { libraryDir, catalogPath };
}

const invalidCatalogs = [
  { name: "malformed JSON", bytes: Buffer.from("{not valid JSON\n"), expected: /catalog/i },
  { name: "unsupported version", bytes: Buffer.from('{"version":3,"items":[],"groups":[]}\n'), expected: /catalog/i },
  {
    name: "unsafe content location",
    bytes: Buffer.from(`${JSON.stringify({
      version: 2,
      items: [{
        id: "123e4567-e89b-42d3-a456-426614174000", kind: "instruction", source: "fixture", scope: "user",
        sourcePath: "/deleted/origin.md", destination: { kind: "global-only" }, name: "Unsafe", savedAt: "2026-10-05T00:00:00.000Z",
        files: [{ path: "origin.md", mode: 0o644, sha256: "0".repeat(64) }],
        content: { kind: "file", path: "items/123e4567-e89b-42d3-a456-426614174000/origin.md" },
      }],
      groups: [],
    })}\n`),
    expected: /content|path|catalog/i,
  },
] as const;

for (const fixture of invalidCatalogs) {
  test(`read-only catalog rejection safely releases an unjournaled lock for ${fixture.name}`, async (t) => {
    const box = await library(t, fixture.bytes);
    await assert.rejects(loadCatalog(box.libraryDir), fixture.expected);
    assert.deepEqual(await readFile(box.catalogPath), fixture.bytes);
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });

    await writeFile(box.catalogPath, validEmptyCatalog);
    const reloaded = await loadCatalog(box.libraryDir);
    assert.equal(reloaded.version, 2);
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  });
}

test("finalized cleanup refuses a changed catalog and preserves its transaction evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-finalized-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const lock = path.join(libraryDir, ".copi-transaction");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(libraryDir);
  const token = randomUUID();
  const approvedCatalog = Buffer.from(validEmptyCatalog);
  const changedCatalog = Buffer.from('{"version":2,"items":[],"groups":[{"id":"external","name":"Changed","itemIds":[]}]}\n');
  await writeFile(path.join(libraryDir, "catalog.json"), changedCatalog, { mode: 0o600 });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({
    version: 1, pid: 2_147_483_647, host: os.hostname(), token,
  }), { mode: 0o600 });
  const finalized = Buffer.from(JSON.stringify({
    version: 1, root: canonicalRoot, token, catalog: sha256(approvedCatalog), tree: "absent",
  }));
  await writeFile(path.join(lock, "finalized.json"), finalized, { mode: 0o600 });
  await writeFile(path.join(lock, "finalized.digest"), sha256(finalized), { mode: 0o600 });

  await assert.rejects(new StorageTransactions({ waitMilliseconds: 100 }).run(libraryDir, false, async () => {}, { requiresNativePlacement: false }), /Finalized transaction state was changed externally/);
  assert.deepEqual(await readFile(path.join(libraryDir, "catalog.json")), changedCatalog);
  assert.deepEqual(await readFile(path.join(lock, "finalized.json")), finalized);
  assert.deepEqual(await readFile(path.join(lock, "finalized.digest"), "utf8"), sha256(finalized));
  assert.equal((await lstat(lock)).isDirectory(), true);
  await assert.rejects(lstat(path.join(libraryDir, ".copi-transaction-recovery")), { code: "ENOENT" });
});

test("foreign owner nonce prevents cleanup and remains the reported secondary error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-cleanup-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const lock = path.join(libraryDir, ".copi-transaction");
  const ownerPath = path.join(lock, "owner.json");
  const primary = new Error("primary read failure");
  let foreignOwnerBytes: Buffer | undefined;

  const operation = new StorageTransactions().run(libraryDir, true, async () => {
    const original = JSON.parse(await readFile(ownerPath, "utf8")) as { version: number; pid: number; host: string; token: string };
    foreignOwnerBytes = Buffer.from(JSON.stringify({ ...original, token: randomUUID() }));
    await writeFile(ownerPath, foreignOwnerBytes, { mode: 0o600 });
    throw primary;
  }, { requiresNativePlacement: false });
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.ok(error.errors[1] instanceof Error);
    assert.match((error.errors[1] as Error).message, /lock owner changed/);
    return true;
  });

  assert.deepEqual(await readFile(ownerPath), foreignOwnerBytes);
  assert.equal((await lstat(lock)).isDirectory(), true);
});

test("primary operation failure stays first when unknown unjournaled lock data blocks cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-cleanup-primary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const lock = path.join(libraryDir, ".copi-transaction");
  const unknownPath = path.join(lock, "unknown-preserved.bin");
  const unknownBytes = Buffer.from("unknown artifact must remain\n");
  const primary = new Error("primary catalog operation failure");
  let ownerBytes: Buffer | undefined;

  const operation = new StorageTransactions().run(libraryDir, true, async () => {
    ownerBytes = await readFile(path.join(lock, "owner.json"));
    await writeFile(unknownPath, unknownBytes, { mode: 0o600 });
    throw primary;
  }, { requiresNativePlacement: false });
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.ok(error.errors[1] instanceof Error);
    assert.match((error.errors[1] as Error).message, /Unknown files in an unjournaled transaction lock/);
    assert.match(error.message, /primary catalog operation failure/);
    return true;
  });

  assert.deepEqual(await readFile(unknownPath), unknownBytes);
  assert.deepEqual(await readFile(path.join(lock, "owner.json")), ownerBytes);
  assert.equal((await lstat(lock)).isDirectory(), true);
});
