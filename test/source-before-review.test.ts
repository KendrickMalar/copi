import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageTransactions, prepareStorageReview, readStorageReview, type StorageReview } from "../src/storage-transaction.ts";
import type { Catalog, SavedItem } from "../src/types.ts";

const itemId = "123e4567-e89b-42d3-a456-426614174000";
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function item(files: SavedItem["files"]): SavedItem {
  return {
    id: itemId,
    kind: "skill",
    source: "fixture",
    scope: "project",
    sourcePath: "/deleted/origin/skill",
    destination: { kind: "project", path: ".pi/skills/demo" },
    name: "Demo",
    savedAt: "2026-10-05T00:00:00.000Z",
    files,
    content: { kind: "tree", path: `sources/${itemId}` },
  };
}

async function fixture(t: test.TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "copi-before-review-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const libraryDir = path.join(temp, ".copi");
  const itemRoot = path.join(libraryDir, "sources", itemId);
  await mkdir(itemRoot, { recursive: true, mode: 0o700 });
  const beforeSkill = Buffer.from("# Before\n");
  const removed = Buffer.from("ordinary child to remove\n");
  await writeFile(path.join(itemRoot, "SKILL.md"), beforeSkill, { mode: 0o600 });
  await writeFile(path.join(itemRoot, "remove.md"), removed, { mode: 0o640 });
  const catalog: Catalog = { version: 2, items: [item([
    { path: "SKILL.md", mode: 0o600, sha256: digest(beforeSkill) },
    { path: "remove.md", mode: 0o640, sha256: digest(removed) },
  ])], groups: [] };
  await writeFile(path.join(libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  const next: Catalog = structuredClone(catalog);
  const nextSkill = Buffer.from("# Reviewed\n");
  next.items[0]!.files = [{ path: "SKILL.md", mode: 0o600, sha256: digest(nextSkill) }];
  const catalogBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const replacements = [{ itemId, files: [{ path: "SKILL.md", mode: 0o600, bytes: nextSkill }] }];
  return { libraryDir, itemRoot, catalog, next, catalogBytes, replacements, removed };
}

test("legacy review cannot authorize omission of an ordinary source child", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions();
  const review = prepareStorageReview(box.catalogBytes, box.replacements);
  await assert.rejects(kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    await session.commit(expected, box.catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false }), /before|delet|review/i);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), box.removed);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
  assert.equal((await lstat(path.join(box.libraryDir, "sources", itemId))).isDirectory(), true);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("confirmed before review permits deletion only of captured ordinary children", async (t) => {
  const box = await fixture(t);
  const unregisteredPath = path.join(box.itemRoot, "notes.md");
  await writeFile(unregisteredPath, "ordinary included child\n", { mode: 0o644 });
  const kernel = new StorageTransactions();
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const review = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    const view = readStorageReview(review);
    assert.deepEqual(view.sensitivePaths, []);
    assert.equal(JSON.stringify(view).includes("ordinary included child"), false);
    assert.deepEqual(Object.keys(review), ["reviewId"]);
    await session.commit(expected, box.catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false });
  await assert.rejects(lstat(path.join(box.itemRoot, "remove.md")), { code: "ENOENT" });
  await assert.rejects(lstat(unregisteredPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), Buffer.from("# Reviewed\n"));
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.next);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("before review refuses changed source bytes without discarding external edits", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions();
  const edited = Buffer.from("external edit after review\n");
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const review = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    await writeFile(path.join(box.itemRoot, "remove.md"), edited, { mode: 0o640 });
    await assert.rejects(session.commit(expected, box.catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    }), /changed|revision/i);
  }, { requiresNativePlacement: false });
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), edited);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("before review refuses source mode changes without overwriting them", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions();
  const source = path.join(box.itemRoot, "remove.md");
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const review = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    await chmod(source, 0o600);
    await assert.rejects(session.commit(expected, box.catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    }), /changed|revision/i);
  }, { requiresNativePlacement: false });
  assert.deepEqual(await readFile(source), box.removed);
  assert.equal((await lstat(source)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
});

test("before review rejects an atomic same-bytes replacement by identity", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions();
  const replacementPath = path.join(box.itemRoot, "replacement.md");
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const review = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    await writeFile(replacementPath, box.removed, { mode: 0o640 });
    await rename(replacementPath, path.join(box.itemRoot, "remove.md"));
    await assert.rejects(session.commit(expected, box.catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    }), /changed|revision/i);
  }, { requiresNativePlacement: false });
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), box.removed);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("forged token copies cannot authorize source deletion", async (t) => {
  const box = await fixture(t);
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const original = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    const forged = { ...original } as StorageReview;
    await session.commit(expected, box.catalogBytes, box.replacements, {
      review: forged,
      approval: { reviewId: forged.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false }), /review does not match/i);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), box.removed);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
});

test("foreign before-review token cannot authorize source deletion", async (t) => {
  const target = await fixture(t);
  const foreign = await fixture(t);
  const foreignReview = await new StorageTransactions().run(foreign.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    return session.prepareSourcesReview(expected, foreign.catalogBytes, foreign.replacements);
  }, { requiresNativePlacement: false });
  await assert.rejects(new StorageTransactions().run(target.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    await session.commit(expected, target.catalogBytes, target.replacements, {
      review: foreignReview,
      approval: { reviewId: foreignReview.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false }), /another root|expected revision/i);
  assert.deepEqual(await readFile(path.join(target.itemRoot, "remove.md")), target.removed);
  assert.deepEqual(JSON.parse(await readFile(path.join(target.libraryDir, "catalog.json"), "utf8")), target.catalog);
});

test("canceling an approved omission restores the before tree and leaves no transaction lock", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions({ checkpoint: (point) => { if (point === "before-catalog") throw new Error("cancel before review commit"); } });
  let review: StorageReview | undefined;
  await assert.rejects(kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    const prepared = await session.prepareSourcesReview(expected, box.catalogBytes, box.replacements);
    review = prepared;
    await session.commit(expected, box.catalogBytes, box.replacements, {
      review: prepared,
      approval: { reviewId: prepared.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false }), /cancel before review commit/);
  assert.ok(review);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), box.removed);
  assert.equal((await lstat(path.join(box.itemRoot, "remove.md"))).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")), box.catalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  const replayReview = review;
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const current = await session.capture();
    await session.commit(current, box.catalogBytes, box.replacements, {
      review: replayReview,
      approval: { reviewId: replayReview.reviewId, confirmed: true, approvedSensitivePaths: [] },
    });
  }, { requiresNativePlacement: false }), /already been used/);
});

test("before review refuses independent empty directories instead of deleting them", async (t) => {
  const box = await fixture(t);
  await mkdir(path.join(box.itemRoot, "empty"), { mode: 0o700 });
  const kernel = new StorageTransactions();
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const expected = await session.capture();
    await assert.rejects(session.prepareSourcesReview(expected, box.catalogBytes, box.replacements), /empty|directory/i);
  }, { requiresNativePlacement: false });
  assert.equal((await lstat(path.join(box.itemRoot, "empty"))).isDirectory(), true);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "remove.md")), box.removed);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});
