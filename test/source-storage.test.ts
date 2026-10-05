import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { catalogBytes, importResource, loadCatalog, readSnapshotFiles } from "../src/catalog.ts";
import { StorageTransactions } from "../src/storage-transaction.ts";
import { sandbox } from "./helpers/sandbox.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type ContentPath = { kind: "file" | "tree"; path: string };
function contentPath(item: object): ContentPath {
  const content = (item as { content?: unknown }).content;
  assert.ok(content && typeof content === "object", "saved item must have a v2 content location");
  return content as ContentPath;
}

async function importedFile(t: TestContext, name = "Coder") {
  const box = await sandbox(t);
  const origin = path.join(box.sourceRoot, "coder.md");
  await writeFile(origin, "old contents\n");
  const item = await importResource(box.libraryDir, {
    id: "storage-source", kind: "subagent", source: "test-origin", scope: "project",
    sourceRoot: box.sourceRoot, sourcePath: origin, name,
    destination: { kind: "project", path: ".pi/agents/coder.md" },
  }, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const location = contentPath(item);
  assert.equal(location.kind, "file");
  return { box, item, location, target: path.join(box.libraryDir, ...location.path.split("/")) };
}

test("imports a v2 source file into sources, not items", async (t) => {
  const { box, item, location, target } = await importedFile(t);
  assert.match(location.path, /^sources\/[0-9a-f-]+\/coder\.md$/i);
  assert.deepEqual(await readFile(target), Buffer.from("old contents\n"));
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "sources"]);
  await assert.rejects(lstat(path.join(box.libraryDir, "items")), { code: "ENOENT" });
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, item))[0]!.bytes, Buffer.from("old contents\n"));
});

test("single-file source replacement preserves sibling and unregistered files in the shared parent", async (t) => {
  const { box, item, target } = await importedFile(t);
  const parent = path.dirname(target);
  const tester = path.join(parent, "tester.md");
  const note = path.join(parent, "note.md");
  await writeFile(tester, "leave tester untouched\n");
  await writeFile(note, "unregistered note\n");
  const beforeTester = await readFile(tester);
  const beforeNote = await readFile(note);
  const next = await loadCatalog(box.libraryDir);
  const modern = next as { version: number; items: Array<{ id: string; files: Array<{ path: string; mode: number; sha256: string }> }> };
  const saved = modern.items.find((entry) => entry.id === item.id)!;
  const replacement = Buffer.from("replacement contents\n");
  saved.files[0]!.sha256 = digest(replacement);
  const replacements = [{ itemId: item.id, files: [{ path: "coder.md", mode: item.files[0]!.mode, bytes: replacement }] }];
  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    await session.commit(revision, catalogBytes(modern as never), replacements);
  });
  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(await readFile(tester), beforeTester);
  assert.deepEqual(await readFile(note), beforeNote);
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, item))[0]!.bytes, replacement);
});

for (const point of ["before-swap", "old-renamed", "before-catalog"] as const) {
  test(`source transaction preserves external inode edits at ${point}`, async (t) => {
    const { box, item, target } = await importedFile(t);
    const next = await loadCatalog(box.libraryDir);
    const modern = next as { version: number; items: Array<{ id: string; files: Array<{ path: string; mode: number; sha256: string }> }> };
    const saved = modern.items.find((entry) => entry.id === item.id)!;
    const proposed = Buffer.from("proposed new bytes\n");
    saved.files[0]!.sha256 = digest(proposed);
    const replacements = [{ itemId: item.id, files: [{ path: "coder.md", mode: item.files[0]!.mode, bytes: proposed }] }];
    const external = Buffer.from(`external inode edit at ${point}\n`);
    let reached = false;
    await assert.rejects(new StorageTransactions({ checkpoint: async (current, root) => {
      if (current !== point) return;
      reached = true;
      const pathToEdit = point === "old-renamed"
        ? path.join(root, ".copi-transaction", "old-0")
        : target;
      await writeFile(pathToEdit, external);
    } }).run(box.libraryDir, false, async (session) => {
      assert.ok(session);
      const revision = await session.capture();
      await session.commit(revision, catalogBytes(modern as never), replacements);
    }), /changed|external|journal|recover|snapshot/i);
    assert.equal(reached, true);
    const retained = point === "old-renamed" ? path.join(box.libraryDir, ".copi-transaction", "old-0") : target;
    assert.deepEqual(await readFile(retained), external);
    await assert.rejects(readSnapshotFiles(box.libraryDir, item), /recovery|external|lock/i);
  });
}

test("v2 source revisions include directory entries and inode identity", async (t) => {
  const { box, item, location, target } = await importedFile(t);
  const sibling = path.join(path.dirname(target), "note.md");
  await writeFile(sibling, "registered-parent neighbor\n");
  const revisions = await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const before = await session.capture();
    await writeFile(sibling, "changed neighbor\n");
    const after = await session.capture();
    return { before, after };
  });
  assert.notEqual(revisions.before.tree, revisions.after.tree);
  assert.equal(location.kind, "file");
});

