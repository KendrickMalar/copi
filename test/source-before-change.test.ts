import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareResource, readSnapshotFiles } from "../src/catalog.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, prepareSavedReplacement, readSavedChange, readSavedEdit } from "../src/resource-mutations.ts";
import { commitRefresh, prepareRefresh, readRefresh, type PreparedRefresh } from "../src/refresh.ts";
import { StorageTransactions, storageTransactions } from "../src/storage-transaction.ts";
import type { Catalog, ResourceCandidate, SavedItem } from "../src/types.ts";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-before-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const itemRoot = path.join(libraryDir, "sources", itemId);
  const sourceRoot = path.join(root, "replacement");
  await mkdir(itemRoot, { recursive: true, mode: 0o700 });
  await mkdir(sourceRoot);
  const beforeSkill = Buffer.from("# Before\n");
  const ordinary = Buffer.from("apiKey=sk_live_beforesecret123456\n");
  const binary = Buffer.from([0, 255, 65, 66]);
  await writeFile(path.join(itemRoot, "SKILL.md"), beforeSkill, { mode: 0o600 });
  await writeFile(path.join(itemRoot, "ordinary.md"), ordinary, { mode: 0o600 });
  await writeFile(path.join(itemRoot, "asset.bin"), binary, { mode: 0o600 });
  await writeFile(path.join(sourceRoot, "SKILL.md"), "# Reviewed\n", { mode: 0o600 });
  const saved = item([{ path: "SKILL.md", mode: 0o600, sha256: digest(beforeSkill) }]);
  const catalog: Catalog = { version: 2, items: [saved], groups: [] };
  await writeFile(path.join(libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  const candidate: ResourceCandidate = {
    id: "fixture",
    kind: "skill",
    source: "test",
    scope: "project",
    sourceRoot: root,
    sourcePath: sourceRoot,
    name: "Replacement",
    destination: { kind: "project", path: ".pi/skills/replacement" },
  };
  const prepared = await prepareResource(candidate);
  return { libraryDir, itemRoot, sourceRoot, catalog, saved, ordinary, binary, candidate, prepared };
}

async function fileFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-before-file-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const itemRoot = path.join(libraryDir, "sources", "223e4567-e89b-42d3-a456-426614174001");
  await mkdir(itemRoot, { recursive: true, mode: 0o700 });
  const registered = Buffer.from("AGENTS before\n");
  const neighbor = Buffer.from("neighbor keep\n");
  await writeFile(path.join(itemRoot, "AGENTS.md"), registered, { mode: 0o600 });
  await writeFile(path.join(itemRoot, "neighbor.txt"), neighbor, { mode: 0o600 });
  const saved: SavedItem = {
    id: path.basename(itemRoot), kind: "instruction", source: "fixture", scope: "project", sourcePath: "/deleted/origin/AGENTS.md",
    destination: { kind: "project", path: "AGENTS.md" }, name: "Agent instructions", savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "AGENTS.md", mode: 0o600, sha256: digest(registered) }],
    content: { kind: "file", path: `sources/${path.basename(itemRoot)}/AGENTS.md` },
  };
  const catalog: Catalog = { version: 2, items: [saved], groups: [] };
  await writeFile(path.join(libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { libraryDir, itemRoot, itemId: saved.id, registered, neighbor };
}

function approval(change: ReturnType<typeof readSavedChange>) {
  return { reviewId: change.reviewId, confirmed: true, approvedSensitivePaths: [...change.sensitivePaths] };
}

test("replacement binds the masked whole before view to confirmed omission of ordinary v2 children", async (t) => {
  const box = await fixture(t);
  const refresh = await prepareRefresh(box.libraryDir, itemId, box.candidate);
  const view = readRefresh(refresh);
  assert.deepEqual(Object.keys(refresh), ["reviewId"]);
  assert.ok(view.diffs.some((entry) => entry.path === "ordinary.md" && entry.diff.includes("(removed)")));
  assert.ok(view.diffs.some((entry) => entry.path === "asset.bin" && /4 → 0 bytes/.test(entry.summary)));
  assert.ok(!JSON.stringify(view).includes("sk_live_beforesecret123456"));
  assert.equal(view.reviewId, refresh.reviewId);
  await assert.rejects(commitRefresh({ ...refresh } as PreparedRefresh, approval(view)), /token|prepared/i);
  await assert.rejects(commitRefresh(refresh, { ...approval(view), reviewId: "foreign-review" }), /review/i);
  const saved = await commitRefresh(refresh, approval(view));
  assert.equal(saved.source, "test");
  assert.equal(saved.sourcePath, view.source.sourcePath);
  await assert.rejects(commitRefresh(refresh, approval(view)), /already|committed/i);
  await assert.rejects(lstat(path.join(box.itemRoot, "ordinary.md")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.itemRoot, "asset.bin")), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), Buffer.from("# Reviewed\n"));
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("failed refresh commit rolls back the reviewed source tree and source metadata", async (t) => {
  const box = await fixture(t);
  const rawCatalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const rawSkill = await readFile(path.join(box.itemRoot, "SKILL.md"));
  const refresh = await prepareRefresh(box.libraryDir, itemId, box.candidate);
  const kernel = new StorageTransactions({ checkpoint(point) { if (point === "before-catalog") throw new Error("injected before-catalog failure"); } });
  const injected = t.mock.method(storageTransactions, "run", kernel.run.bind(kernel));
  try {
    await assert.rejects(commitRefresh(refresh, approval(readRefresh(refresh))), /injected before-catalog failure/);
  } finally {
    injected.mock.restore();
  }
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawCatalog);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), rawSkill);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "ordinary.md")), box.ordinary);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("canceling after a direct current edit preserves its bytes and raw catalog", async (t) => {
  const box = await fixture(t);
  const direct = Buffer.from("manual current bytes before edit\n");
  await writeFile(path.join(box.itemRoot, "SKILL.md"), direct);
  const rawCatalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const edit = await prepareSavedEdit(box.libraryDir, itemId, "SKILL.md");
  assert.deepEqual(readSavedEdit(edit).file.bytes, direct);
  const change = await prepareSavedChange(edit, Buffer.from("Copi proposed bytes\n"));
  await assert.rejects(commitSavedChange(change, { ...approval(readSavedChange(change)), confirmed: false }), /confirm|cancel/i);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), direct);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "ordinary.md")), box.ordinary);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "asset.bin")), box.binary);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawCatalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("before secret bytes stay masked and next secret still requires separate approval", async (t) => {
  const box = await fixture(t);
  const nextSecret = "apiKey=sk_live_nextsecret987654\n";
  await writeFile(path.join(box.sourceRoot, "SKILL.md"), nextSecret);
  const prepared = await prepareResource(box.candidate);
  const change = await prepareSavedReplacement(box.libraryDir, itemId, prepared);
  const view = readSavedChange(change);
  assert.deepEqual(view.sensitivePaths, ["SKILL.md"]);
  assert.ok(!JSON.stringify(view).includes("sk_live_beforesecret123456"));
  assert.ok(!JSON.stringify(view).includes("sk_live_nextsecret987654"));
  await assert.rejects(commitSavedChange(change, { ...approval(view), approvedSensitivePaths: [] }), /approval|sensitive/i);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "ordinary.md")), box.ordinary);
  await commitSavedChange(change, approval(view));
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), Buffer.from(nextSecret));
});

test("prepared edit reviews current direct bytes even when their descriptor SHA is old", async (t) => {
  const box = await fixture(t);
  const direct = Buffer.from("# Manual current edit\n");
  await writeFile(path.join(box.itemRoot, "SKILL.md"), direct);
  const edit = await prepareSavedEdit(box.libraryDir, itemId, "SKILL.md");
  const editView = readSavedEdit(edit);
  assert.deepEqual(editView.file.bytes, direct);
  assert.equal(editView.file.sha256, digest(direct));
  const originalSkillDescriptor = editView.item.files.find((file) => file.path === "SKILL.md");
  assert.ok(originalSkillDescriptor);
  assert.equal(originalSkillDescriptor.sha256, digest(Buffer.from("# Before\n")));
  const proposed = Buffer.from("# Copi reviewed edit\n");
  const change = await prepareSavedChange(edit, proposed);
  const view = readSavedChange(change);
  const skillDiff = view.diffs.find((entry) => entry.path === "SKILL.md");
  assert.ok(skillDiff);
  assert.ok(skillDiff.diff.includes("# Manual current edit"));
  assert.ok(!skillDiff.diff.includes("# Before"));
  const reviewedSkillDescriptor = view.item.files.find((file) => file.path === "SKILL.md");
  assert.ok(reviewedSkillDescriptor);
  assert.equal(reviewedSkillDescriptor.sha256, digest(proposed));
  assert.ok(!JSON.stringify(view).includes("sk_live_beforesecret123456"));
  await commitSavedChange(change, approval(view));
  assert.deepEqual(await readFile(path.join(box.itemRoot, "ordinary.md")), box.ordinary);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "asset.bin")), box.binary);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "SKILL.md")), proposed);
});

test("tree edit treats additions and missing past descriptors as current included content", async (t) => {
  const box = await fixture(t);
  const direct = Buffer.from("# Current skill bytes\n");
  await writeFile(path.join(box.itemRoot, "SKILL.md"), direct);
  const removedBytes = Buffer.from("manually removed past descriptor\n");
  await mkdir(path.join(box.itemRoot, "docs"));
  await writeFile(path.join(box.itemRoot, "docs", "removed.md"), removedBytes);
  await writeFile(path.join(box.itemRoot, "docs", "kept.md"), "current sibling\n");
  box.catalog.items[0]!.files.push({ path: "docs/removed.md", mode: 0o600, sha256: digest(removedBytes) });
  await writeFile(path.join(box.libraryDir, "catalog.json"), `${JSON.stringify(box.catalog, null, 2)}\n`);
  await rm(path.join(box.itemRoot, "docs", "removed.md"));
  const addedBytes = Buffer.from("ordinary current addition\n");
  await writeFile(path.join(box.itemRoot, "added.md"), addedBytes, { mode: 0o640 });

  const edit = await prepareSavedEdit(box.libraryDir, itemId, "SKILL.md");
  assert.deepEqual(readSavedEdit(edit).file.bytes, direct);
  const change = await prepareSavedChange(edit, Buffer.from("# Reviewed current tree\n"));
  const view = readSavedChange(change);
  assert.ok(view.item.files.some((file) => file.path === "added.md" && file.mode === 0o640));
  assert.ok(view.item.files.some((file) => file.path === "docs/kept.md"));
  assert.ok(!view.item.files.some((file) => file.path === "docs/removed.md"));
  await commitSavedChange(change, approval(view));
  assert.deepEqual(await readFile(path.join(box.itemRoot, "added.md")), addedBytes);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "docs", "kept.md"), "utf8"), "current sibling\n");
  const savedFiles = await readSnapshotFiles(box.libraryDir, view.item);
  assert.deepEqual(savedFiles.map((file) => file.path).sort((left, right) => left.localeCompare(right)), ["SKILL.md", "added.md", "asset.bin", "docs/kept.md", "ordinary.md"].sort((left, right) => left.localeCompare(right)));
});

test("previewed saved edit rejects a later direct file edit without replacing it", async (t) => {
  const box = await fileFixture(t);
  const initial = Buffer.from("direct before preview\n");
  await writeFile(path.join(box.itemRoot, "AGENTS.md"), initial);
  const rawCatalog = await readFile(path.join(box.libraryDir, "catalog.json"));
  const edit = await prepareSavedEdit(box.libraryDir, box.itemId, "AGENTS.md");
  assert.deepEqual(readSavedEdit(edit).file.bytes, initial);
  const change = await prepareSavedChange(edit, Buffer.from("reviewed preview bytes\n"));
  const external = Buffer.from("direct edit after preview\n");
  await writeFile(path.join(box.itemRoot, "AGENTS.md"), external);
  await assert.rejects(commitSavedChange(change, approval(readSavedChange(change))), /changed|revision|before-reviewed/i);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "AGENTS.md")), external);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "neighbor.txt")), box.neighbor);
  assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), rawCatalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("single-file v2 edits leave adjacent unregistered storage files outside the content boundary", async (t) => {
  const box = await fileFixture(t);
  const edit = await prepareSavedEdit(box.libraryDir, box.itemId, "AGENTS.md");
  const change = await prepareSavedChange(edit, Buffer.from("AGENTS reviewed\n"));
  const view = readSavedChange(change);
  assert.deepEqual(view.diffs.map((entry) => entry.path), ["AGENTS.md"]);
  await commitSavedChange(change, approval(view));
  assert.deepEqual(await readFile(path.join(box.itemRoot, "AGENTS.md")), Buffer.from("AGENTS reviewed\n"));
  assert.deepEqual(await readFile(path.join(box.itemRoot, "neighbor.txt")), box.neighbor);
});

for (const mutation of ["add", "delete", "edit", "atomic replacement", "mode"] as const) {
  test(`prepared before token rejects ${mutation} after review and preserves the external state`, async (t) => {
    const box = await fixture(t);
    const change = await prepareSavedReplacement(box.libraryDir, itemId, box.prepared);
    const ordinaryPath = path.join(box.itemRoot, "ordinary.md");
    const atomicPath = path.join(box.itemRoot, "replacement.tmp");
    if (mutation === "add") await writeFile(path.join(box.itemRoot, "new.md"), "external addition\n", { mode: 0o600 });
    else if (mutation === "delete") await rm(ordinaryPath);
    else if (mutation === "edit") await writeFile(ordinaryPath, "external edit\n", { mode: 0o600 });
    else if (mutation === "atomic replacement") {
      await writeFile(atomicPath, box.ordinary, { mode: 0o600 });
      await rename(atomicPath, ordinaryPath);
    } else await chmod(ordinaryPath, 0o640);
    const externalCatalog = await readFile(path.join(box.libraryDir, "catalog.json"));
    const expectedError = /changed|revision|before-reviewed/i;
    await assert.rejects(commitSavedChange(change, approval(readSavedChange(change))), expectedError);
    if (mutation === "add") assert.equal(await readFile(path.join(box.itemRoot, "new.md"), "utf8"), "external addition\n");
    else if (mutation === "delete") await assert.rejects(lstat(ordinaryPath), { code: "ENOENT" });
    else {
      assert.deepEqual(await readFile(ordinaryPath), mutation === "edit" ? Buffer.from("external edit\n") : box.ordinary);
      if (mutation === "mode") assert.equal((await lstat(ordinaryPath)).mode & 0o777, 0o640);
    }
    assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), externalCatalog);
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  });
}

test("before review still refuses private excluded content and symlink nodes", async (t) => {
  const excluded = await fixture(t);
  const privateDir = path.join(excluded.itemRoot, "auth");
  await mkdir(privateDir);
  await writeFile(path.join(privateDir, "secret.md"), "private excluded bytes\n");
  await assert.rejects(prepareSavedReplacement(excluded.libraryDir, itemId, excluded.prepared), /excluded|private|preserv/i);
  assert.equal(await readFile(path.join(privateDir, "secret.md"), "utf8"), "private excluded bytes\n");
  await assert.rejects(lstat(path.join(excluded.libraryDir, ".copi-transaction")), { code: "ENOENT" });

  const linked = await fixture(t);
  const linkPath = path.join(linked.itemRoot, "linked.md");
  await symlink(path.join(linked.sourceRoot, "SKILL.md"), linkPath);
  await assert.rejects(prepareSavedReplacement(linked.libraryDir, itemId, linked.prepared), /symbolic|symlink|unsafe/i);
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  await assert.rejects(lstat(path.join(linked.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("before review refuses independent empty source directories at the saved-change API", async (t) => {
  const box = await fixture(t);
  await mkdir(path.join(box.itemRoot, "empty"), { mode: 0o700 });
  await assert.rejects(prepareSavedReplacement(box.libraryDir, itemId, box.prepared), /empty|directory/i);
  assert.equal((await lstat(path.join(box.itemRoot, "empty"))).isDirectory(), true);
  assert.deepEqual(await readFile(path.join(box.itemRoot, "ordinary.md")), box.ordinary);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});
