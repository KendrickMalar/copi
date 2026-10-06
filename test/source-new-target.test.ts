import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareStorageReview, readStorageReview, StorageTransactions, type StorageCheckpoint, type StorageFile } from "../src/storage-transaction.ts";
import { readSourceContent } from "../src/source-content.ts";
import type { Catalog, SavedItem } from "../src/types.ts";

const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: test.TestContext, catalog?: Catalog, sources = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-new-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  if (catalog || sources) {
    await mkdir(libraryDir, { recursive: true, mode: 0o700 });
    if (sources) await mkdir(path.join(libraryDir, "sources"), { mode: 0o700 });
    if (catalog) await writeFile(path.join(libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  }
  return { root, libraryDir };
}

function savedItem(id: string, kind: "instruction" | "skill", name: string, files: readonly StorageFile[]): SavedItem {
  const contentPath = kind === "skill" ? `sources/${id}` : `sources/${id}/${path.posix.basename(files[0]!.path)}`;
  return {
    id,
    kind,
    source: "synthetic fixture",
    scope: "project",
    sourcePath: `/deleted/origin/${name}`,
    destination: { kind: "project", path: kind === "skill" ? `.pi/skills/${name}` : `${name}.md` },
    name,
    savedAt: "2026-10-05T00:00:00.000Z",
    files: files.map((file) => ({ path: file.path, mode: file.mode, sha256: digest(file.bytes) })),
    content: { kind: kind === "skill" ? "tree" : "file", path: contentPath },
  };
}

async function commitNewItem(
  libraryDir: string,
  item: SavedItem,
  files: readonly StorageFile[],
  groupIds: readonly string[] = [],
  checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>,
  approveSensitive = false,
): Promise<void> {
  const kernel = new StorageTransactions(checkpoint === undefined ? {} : { checkpoint });
  const replacements = [{ itemId: item.id, files }];
  await kernel.run(libraryDir, true, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const previous = revision.catalog === null
      ? { version: 2 as const, items: [], groups: [] }
      : JSON.parse(Buffer.from(revision.catalog, "base64").toString("utf8")) as Catalog;
    const next = structuredClone(previous);
    next.items.push(item);
    for (const groupId of groupIds) {
      const group = next.groups.find((entry) => entry.id === groupId);
      assert.ok(group, `fixture group ${groupId} must exist`);
      group.itemIds.push(item.id);
    }
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    const review = prepareStorageReview(bytes, replacements);
    const sensitive = readStorageReview(review).sensitivePaths;
    const authorization = approveSensitive
      ? { review, approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: sensitive } }
      : undefined;
    await session.commit(revision, bytes, replacements, authorization);
  });
}

function newFile(name = "Draft", bytes = Buffer.from("reviewed new file\n")) {
  const id = randomUUID();
  const files: StorageFile[] = [{ path: `${name}.md`, mode: 0o644, bytes }];
  return { item: savedItem(id, "instruction", name, files), files };
}

function newTree(name = "Guide") {
  const id = randomUUID();
  const files: StorageFile[] = [
    { path: "SKILL.md", mode: 0o755, bytes: Buffer.from("# Reviewed skill\n") },
    { path: "docs/guide.md", mode: 0o644, bytes: Buffer.from("Reviewed guide\n") },
  ];
  return { item: savedItem(id, "skill", name, files), files };
}

async function startWriter(libraryDir: string, item: SavedItem, files: readonly StorageFile[], checkpoint: StorageCheckpoint): Promise<ChildProcessWithoutNullStreams> {
  const moduleUrl = new URL("../src/storage-transaction.ts", import.meta.url).href;
  const next: Catalog = { version: 2, items: [item], groups: [] };
  const catalogBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`).toString("base64");
  const replacements = [{ itemId: item.id, files: files.map((file) => ({ path: file.path, mode: file.mode, bytes: file.bytes.toString("base64") })) }];
  const code = `import {StorageTransactions} from ${JSON.stringify(moduleUrl)};
const replacement=${JSON.stringify(replacements[0])};
const kernel=new StorageTransactions({checkpoint:async(point)=>{if(point===${JSON.stringify(checkpoint)}){console.log('PAUSED');setInterval(()=>{},1000);await new Promise(()=>{});}}});
await kernel.run(${JSON.stringify(libraryDir)},true,async(session)=>session.commit(await session.capture(),Buffer.from(${JSON.stringify(catalogBytes)},'base64'),[{itemId:replacement.itemId,files:replacement.files.map(file=>({path:file.path,mode:file.mode,bytes:Buffer.from(file.bytes,'base64')}))}]));`;
  return spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", code], { env: process.env });
}

async function stopAt(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (!output.includes("PAUSED") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!output.includes("PAUSED")) {
    child.kill();
    const stopped = await closed;
    throw new Error(`Writer did not reach its checkpoint (${stopped.code}/${stopped.signal}): ${output}`);
  }
  child.kill("SIGKILL");
  assert.equal((await closed).signal, "SIGKILL");
}

async function recover(libraryDir: string): Promise<void> {
  await new StorageTransactions({ waitMilliseconds: 100 }).run(libraryDir, false, async () => {});
}

test("first v2 file item stores only reviewed bytes under a private UUID parent and preserves descriptor mode", async (t) => {
  const box = await fixture(t);
  const { item, files } = newFile();
  await commitNewItem(box.libraryDir, item, files);

  const target = path.join(box.libraryDir, ...item.content.path.split("/"));
  assert.deepEqual(await readFile(target), files[0]!.bytes);
  assert.equal((await lstat(path.join(box.libraryDir, "sources"))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.dirname(target))).mode & 0o777, 0o700);
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  const committed = JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")) as Catalog;
  assert.deepEqual(committed.items, [item]);
  assert.deepEqual(committed.items[0]!.files, [{ path: "Draft.md", mode: 0o644, sha256: digest(files[0]!.bytes) }]);
  assert.deepEqual(await readdir(box.libraryDir), ["catalog.json", "sources"]);
  assert.deepEqual(await readdir(path.join(box.libraryDir, "sources")), [item.id]);
  assert.equal((await readSourceContent(box.libraryDir, item))[0]!.bytes.toString(), "reviewed new file\n");
});

test("first v2 tree item creates private roots and stores every reviewed file without an items copy", async (t) => {
  const box = await fixture(t, { version: 2, items: [], groups: [] });
  const { item, files } = newTree();
  await commitNewItem(box.libraryDir, item, files);

  const target = path.join(box.libraryDir, ...item.content.path.split("/"));
  assert.deepEqual(await readFile(path.join(target, "SKILL.md")), files[0]!.bytes);
  assert.deepEqual(await readFile(path.join(target, "docs", "guide.md")), files[1]!.bytes);
  assert.equal((await lstat(path.join(box.libraryDir, "sources"))).mode & 0o777, 0o700);
  assert.equal((await lstat(target)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(target, "docs"))).mode & 0o777, 0o700);
  for (const file of files) {
    const filePath = path.join(target, ...file.path.split("/"));
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
  }
  const catalog = JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")) as Catalog;
  assert.deepEqual(catalog.items[0]!.files.map(({ path: filePath, mode }) => ({ path: filePath, mode })), [
    { path: "SKILL.md", mode: 0o755 }, { path: "docs/guide.md", mode: 0o644 },
  ]);
  await assert.rejects(lstat(path.join(box.libraryDir, "items")), { code: "ENOENT" });
  assert.deepEqual((await readSourceContent(box.libraryDir, catalog.items[0]!)).map((file) => file.bytes.toString()), ["Reviewed guide\n", "# Reviewed skill\n"]);
});

test("adding one item changes only its selected existing group relation and preserves registered/unregistered sources", async (t) => {
  const oldId = "123e4567-e89b-42d3-a456-426614174000";
  const oldBytes = Buffer.from("existing canonical bytes\n");
  const old: SavedItem = {
    id: oldId, kind: "instruction", source: "fixture", scope: "project", sourcePath: "/deleted/origin/old.md",
    destination: { kind: "project", path: "old.md" }, name: "Old", savedAt: "2026-10-04T00:00:00.000Z",
    files: [{ path: "old.md", mode: 0o644, sha256: digest(oldBytes) }], content: { kind: "file", path: `sources/${oldId}/old.md` },
  };
  const original: Catalog = { version: 2, items: [old], groups: [
    { id: "selected", name: "Selected", itemIds: [oldId] },
    { id: "untouched", name: "Untouched", itemIds: [] },
  ] };
  const box = await fixture(t, original, true);
  const oldPath = path.join(box.libraryDir, ...old.content.path.split("/"));
  await mkdir(path.dirname(oldPath), { mode: 0o700 });
  await writeFile(oldPath, oldBytes, { mode: 0o600 });
  const neighborPath = path.join(box.libraryDir, "sources", "unregistered", "note.md");
  await mkdir(path.dirname(neighborPath), { mode: 0o700 });
  await writeFile(neighborPath, "unregistered neighbor\n", { mode: 0o600 });
  const oldIdentity = await lstat(oldPath);
  const neighborIdentity = await lstat(neighborPath);
  const { item, files } = newFile("Added");

  await commitNewItem(box.libraryDir, item, files, ["selected"]);

  const next = JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")) as Catalog;
  assert.deepEqual(next.items[0], old);
  assert.deepEqual(next.groups, [
    { id: "selected", name: "Selected", itemIds: [oldId, item.id] },
    { id: "untouched", name: "Untouched", itemIds: [] },
  ]);
  assert.equal(`${(await lstat(oldPath)).dev}:${(await lstat(oldPath)).ino}`, `${oldIdentity.dev}:${oldIdentity.ino}`);
  assert.equal(`${(await lstat(neighborPath)).dev}:${(await lstat(neighborPath)).ino}`, `${neighborIdentity.dev}:${neighborIdentity.ino}`);
  assert.deepEqual(await readFile(oldPath), oldBytes);
  assert.equal(await readFile(neighborPath, "utf8"), "unregistered neighbor\n");
});

test("existing file/tree new-target collisions are refused even when file bytes match", async (t) => {
  for (const kind of ["file", "tree"] as const) {
    await t.test(kind, async (st) => {
      const box = await fixture(st, { version: 2, items: [], groups: [] }, true);
      const { item, files } = kind === "file" ? newFile("Collision") : newTree("Collision");
      const target = path.join(box.libraryDir, ...item.content.path.split("/"));
      if (kind === "file") {
        await mkdir(path.dirname(target), { mode: 0o700 });
        await writeFile(target, files[0]!.bytes, { mode: 0o600 });
      } else {
        await mkdir(path.join(target, "docs"), { recursive: true, mode: 0o700 });
        await writeFile(path.join(target, "SKILL.md"), files[0]!.bytes, { mode: 0o600 });
        await writeFile(path.join(target, "docs", "guide.md"), files[1]!.bytes, { mode: 0o600 });
      }
      const before = await lstat(kind === "file" ? target : path.join(target, "SKILL.md"));
      await assert.rejects(commitNewItem(box.libraryDir, item, files), /exist|collision|target|already/i);
      const after = await lstat(kind === "file" ? target : path.join(target, "SKILL.md"));
      assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
      assert.deepEqual(await readFile(kind === "file" ? target : path.join(target, "SKILL.md")), files[0]!.bytes);
      assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), { version: 2, items: [], groups: [] });
    });
  }
});

test("new-target parent symlink is rejected without following or changing the outside target", async (t) => {
  const box = await fixture(t, { version: 2, items: [], groups: [] }, true);
  const { item, files } = newFile("Linked");
  const outside = path.join(box.root, "outside");
  await mkdir(outside);
  const outsideFile = path.join(outside, "Linked.md");
  await writeFile(outsideFile, "outside bytes\n", { mode: 0o600 });
  const parent = path.join(box.libraryDir, "sources", item.id);
  await symlink(outside, parent);
  const identity = await lstat(outsideFile);

  await assert.rejects(commitNewItem(box.libraryDir, item, files), /symbolic|unsafe|target|parent/i);

  const after = await lstat(outsideFile);
  assert.equal(`${after.dev}:${after.ino}`, `${identity.dev}:${identity.ino}`);
  assert.equal(await readFile(outsideFile, "utf8"), "outside bytes\n");
  assert.ok((await lstat(parent)).isSymbolicLink());
});

test("a target added externally after review is preserved and prevents catalog commit", async (t) => {
  const box = await fixture(t, { version: 2, items: [], groups: [] }, true);
  const { item, files } = newFile("External");
  const target = path.join(box.libraryDir, ...item.content.path.split("/"));
  const external = Buffer.from("external same-byte target\n");
  const itemWithExternalBytes = savedItem(item.id, "instruction", item.name, [{ ...files[0]!, bytes: external }]);

  await assert.rejects(commitNewItem(box.libraryDir, itemWithExternalBytes, [{ ...files[0]!, bytes: external }], [], async (point) => {
    if (point === "before-swap") {
      await mkdir(path.dirname(target), { mode: 0o700 });
      await writeFile(target, external, { mode: 0o600 });
    }
  }), /external|changed|target|recover|recovery/i);

  assert.deepEqual(await readFile(target), external);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), { version: 2, items: [], groups: [] });
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
});

test("raw sensitive new content requires exact opaque individual approval", async (t) => {
  const box = await fixture(t, { version: 2, items: [], groups: [] });
  const secret = Buffer.from("apiKey=sk_live_newtargetsecret123456\n");
  const { item, files } = newFile("Secret", secret);
  const next: Catalog = { version: 2, items: [item], groups: [] };
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const replacements = [{ itemId: item.id, files }];
  const review = prepareStorageReview(bytes, replacements);
  const sensitivePaths = readStorageReview(review).sensitivePaths;
  assert.deepEqual(sensitivePaths, [`${item.id}/Secret.md`]);

  await assert.rejects(new StorageTransactions().run(box.libraryDir, true, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), bytes, replacements);
  }), /approval|inspection/i);
  assert.deepEqual(await readdir(box.libraryDir), ["catalog.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), { version: 2, items: [], groups: [] });
  await assert.rejects(lstat(path.join(box.libraryDir, ...item.content.path.split("/"))), { code: "ENOENT" });

  await new StorageTransactions().run(box.libraryDir, true, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), bytes, replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: sensitivePaths },
    });
  });
  assert.deepEqual(await readFile(path.join(box.libraryDir, ...item.content.path.split("/"))), secret);
});

for (const boundary of ["stage-write", "stage-sync", "journal", "new-renamed", "before-catalog", "catalog-renamed"] as const) {
  test(`new item failure at ${boundary} restores the initially empty library without leaving target bytes`, async (t) => {
    const box = await fixture(t);
    const { item, files } = newFile(`Cancel-${boundary}`);
    await assert.rejects(commitNewItem(box.libraryDir, item, files, [], (point) => {
      if (point === boundary) throw new Error(`cancel ${boundary}`);
    }), /cancel|recover/i);
    assert.deepEqual(await readdir(box.libraryDir), []);
    await assert.rejects(lstat(path.join(box.libraryDir, ...item.content.path.split("/"))), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  });
}

test("an unknown staged artifact blocks new-target recovery and remains untouched", async (t) => {
  const box = await fixture(t);
  const { item, files } = newFile("UnknownStage");
  const unknown = Buffer.from("unowned transaction bytes\n");
  await assert.rejects(commitNewItem(box.libraryDir, item, files, [], async (point, root) => {
    if (point === "journal") {
      await writeFile(path.join(root, ".copi-transaction", "next-99"), unknown, { mode: 0o600 });
      throw new Error("stop after unowned stage");
    }
  }), /unknown|recover|journal|stop/i);
  assert.deepEqual(await readFile(path.join(box.libraryDir, ".copi-transaction", "next-99")), unknown);
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
  assert.deepEqual(await readdir(path.join(box.libraryDir, "sources")).catch(() => []), []);
});

test("SIGKILL after new-target rename rolls back; SIGKILL after catalog rename finalizes the new item", async (t) => {
  const rollbackBox = await fixture(t);
  const rollbackItem = newFile("CrashRollback");
  await stopAt(await startWriter(rollbackBox.libraryDir, rollbackItem.item, rollbackItem.files, "new-renamed"));
  await recover(rollbackBox.libraryDir);
  assert.deepEqual(await readdir(rollbackBox.libraryDir), []);

  const commitBox = await fixture(t);
  const committedItem = newFile("CrashCommit");
  await stopAt(await startWriter(commitBox.libraryDir, committedItem.item, committedItem.files, "catalog-renamed"));
  await recover(commitBox.libraryDir);
  const catalog = JSON.parse(await readFile(path.join(commitBox.libraryDir, "catalog.json"), "utf8")) as Catalog;
  assert.deepEqual(catalog.items, [committedItem.item]);
  assert.equal((await readSourceContent(commitBox.libraryDir, catalog.items[0]!))[0]!.bytes.toString(), "reviewed new file\n");
  await assert.rejects(lstat(path.join(commitBox.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});
