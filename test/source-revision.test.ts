import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { sandbox } from "./helpers/sandbox.ts";
import { StorageTransactions } from "../src/storage-transaction.ts";

const emptyV2 = (): Buffer => Buffer.from(`${JSON.stringify({ version: 2, items: [], groups: [] }, null, 2)}\n`);

async function v2Library(t: TestContext) {
  const box = await sandbox(t);
  await mkdir(box.libraryDir, { recursive: true, mode: 0o700 });
  const sources = path.join(box.libraryDir, "sources");
  await mkdir(sources, { mode: 0o700 });
  const source = path.join(sources, "content.md");
  await writeFile(source, "initial source\n", { mode: 0o600 });
  await writeFile(path.join(box.libraryDir, "catalog.json"), emptyV2(), { mode: 0o600 });
  return { ...box, sources, source };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("v2 revision binds catalog and current sources bytes, listing, and inode identity without reading items", async (t) => {
  const box = await v2Library(t);
  const legacyItem = path.join(box.libraryDir, "items", "00000000-0000-4000-8000-000000000001", "files", "old.md");
  await mkdir(path.dirname(legacyItem), { recursive: true, mode: 0o700 });
  await writeFile(legacyItem, "legacy bytes\n", { mode: 0o600 });

  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const captured = await session.capture();

    await writeFile(legacyItem, "legacy bytes changed\n", { mode: 0o600 });
    await session.assertRevision(captured);

    await writeFile(box.source, "edited current source\n", { mode: 0o600 });
    await assert.rejects(session.assertRevision(captured), /changed|revision/i);

    const withEditedSource = await session.capture();
    await writeFile(path.join(box.sources, "added.md"), "new source entry\n", { mode: 0o600 });
    await assert.rejects(session.assertRevision(withEditedSource), /changed|revision/i);

    const withAddedSource = await session.capture();
    const replacement = `${box.source}.replacement`;
    const bytes = await readFile(box.source);
    await writeFile(replacement, bytes, { mode: 0o600 });
    await rename(replacement, box.source);
    assert.equal(await readFile(box.source, "utf8"), "edited current source\n");
    assert.notEqual(sha256(await readFile(box.source)), sha256(Buffer.from("initial source\n")));
    await assert.rejects(session.assertRevision(withAddedSource), /changed|revision/i);

    const beforeCatalogInodeChange = await session.capture();
    const catalogPath = path.join(box.libraryDir, "catalog.json");
    const originalCatalog = await readFile(catalogPath);
    const replacementCatalog = `${catalogPath}.replacement`;
    await writeFile(replacementCatalog, originalCatalog, { mode: 0o600 });
    await rename(replacementCatalog, catalogPath);
    await assert.rejects(session.assertRevision(beforeCatalogInodeChange), /changed|revision/i);

    const beforeCatalogChange = await session.capture();
    await writeFile(catalogPath, Buffer.from(`${JSON.stringify({ version: 2, items: [], groups: [{ id: "changed", name: "Changed", itemIds: [] }] }, null, 2)}\n`), { mode: 0o600 });
    await assert.rejects(session.assertRevision(beforeCatalogChange), /changed|revision/i);
  });
});

test("v1 revision stays bound to its legacy items tree and ordinary commit refuses v1", async (t) => {
  const box = await sandbox(t);
  await mkdir(box.libraryDir, { recursive: true, mode: 0o700 });
  const id = "00000000-0000-4000-8000-000000000001";
  const fileBytes = Buffer.from("legacy content\n");
  const filePath = path.join(box.libraryDir, "items", id, "files", "legacy.md");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, fileBytes, { mode: 0o600 });
  const legacyCatalog = Buffer.from(`${JSON.stringify({
    version: 1,
    items: [{
      id, kind: "instruction", source: "fixture", scope: "project", sourcePath: path.join(box.sourceRoot, "origin.md"),
      destination: { kind: "project", path: "AGENTS.md" }, name: "Legacy", savedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "legacy.md", mode: 0o600, sha256: sha256(fileBytes) }],
    }],
    groups: [],
  }, null, 2)}\n`);
  await writeFile(path.join(box.libraryDir, "catalog.json"), legacyCatalog, { mode: 0o600 });

  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const captured = await session.capture();
    await writeFile(filePath, "legacy content changed\n", { mode: 0o600 });
    await assert.rejects(session.assertRevision(captured), /changed|revision/i);

    await writeFile(filePath, fileBytes, { mode: 0o600 });
    const beforeCommit = await readFile(path.join(box.libraryDir, "catalog.json"));
    await assert.rejects(session.commit(await session.capture(), legacyCatalog), /v2|migrat/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), beforeCommit);
  });
});

test("ordinary v2 commit cannot create a new v1 catalog", async (t) => {
  const box = await v2Library(t);
  const legacy = Buffer.from(`${JSON.stringify({ version: 1, items: [], groups: [] }, null, 2)}\n`);
  const catalogPath = path.join(box.libraryDir, "catalog.json");
  const before = await readFile(catalogPath);

  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await assert.rejects(session.commit(await session.capture(), legacy), /v2|migrat/i);
  });

  assert.deepEqual(await readFile(catalogPath), before);
});

test("v2 storage capture succeeds when the legacy items directory is absent", async (t) => {
  const box = await v2Library(t);
  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    await session.assertRevision(revision);
  });
});
