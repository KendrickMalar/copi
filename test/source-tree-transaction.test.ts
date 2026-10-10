import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageTransactions, readStorageReview, type StorageCheckpoint } from "../src/storage-transaction.ts";
import type { Catalog, SavedItem } from "../src/types.ts";

const skillId = "123e4567-e89b-42d3-a456-426614174000";
const neighborId = "123e4567-e89b-42d3-a456-426614174001";
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function skillItem(files: SavedItem["files"]): SavedItem {
  return {
    id: skillId,
    kind: "skill",
    source: "fixture",
    scope: "project",
    sourcePath: "/deleted/origin/skill",
    destination: { kind: "project", path: ".pi/skills/demo" },
    name: "Demo",
    savedAt: "2026-10-05T00:00:00.000Z",
    files,
    content: { kind: "tree", path: `sources/${skillId}` },
  };
}

function neighborItem(): SavedItem {
  const bytes = Buffer.from("neighbor item\n");
  return {
    id: neighborId,
    kind: "subagent",
    source: "fixture",
    scope: "project",
    sourcePath: "/deleted/origin/neighbor.md",
    destination: { kind: "project", path: "agents/neighbor.md" },
    name: "Neighbor",
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "neighbor.md", mode: 0o644, sha256: digest(bytes) }],
    content: { kind: "file", path: "sources/neighbor/neighbor.md" },
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-v2-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const sources = path.join(libraryDir, "sources");
  const skillRoot = path.join(sources, skillId);
  const neighborRoot = path.join(sources, "neighbor");
  await mkdir(path.join(skillRoot, "docs"), { recursive: true, mode: 0o700 });
  await mkdir(neighborRoot, { mode: 0o700 });
  await mkdir(path.join(sources, "unregistered"), { mode: 0o700 });
  const initialSkill = Buffer.from("# Original skill\n");
  const removed = Buffer.from("remove me\n");
  await writeFile(path.join(skillRoot, "SKILL.md"), initialSkill, { mode: 0o600 });
  await writeFile(path.join(skillRoot, "docs", "removed.md"), removed, { mode: 0o600 });
  await writeFile(path.join(neighborRoot, "neighbor.md"), "neighbor item\n", { mode: 0o600 });
  await writeFile(path.join(sources, "unregistered", "note.md"), "unregistered sibling\n", { mode: 0o600 });
  const catalog: Catalog = {
    version: 2,
    items: [
      skillItem([
        { path: "SKILL.md", mode: 0o644, sha256: digest(initialSkill) },
        { path: "docs/removed.md", mode: 0o600, sha256: digest(removed) },
      ]),
      neighborItem(),
    ],
    groups: [],
  };
  const catalogPath = path.join(libraryDir, "catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  const next = structuredClone(catalog);
  const skillBytes = Buffer.from("# Reviewed skill\n");
  const addedBytes = Buffer.from("included addition\n");
  next.items[0]!.files = [
    { path: "SKILL.md", mode: 0o755, sha256: digest(skillBytes) },
    { path: "docs/added.md", mode: 0o640, sha256: digest(addedBytes) },
  ];
  const replacements = [{
    itemId: skillId,
    files: [
      { path: "SKILL.md", mode: 0o755, bytes: skillBytes },
      { path: "docs/added.md", mode: 0o640, bytes: addedBytes },
    ],
  }];
  return {
    root, libraryDir, sources, skillRoot, neighborRoot, catalogPath, catalog, next, replacements,
    skillBytes, addedBytes, initialSkill,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function commitWithoutReview(box: Fixture, checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>) {
  const kernel = new StorageTransactions(checkpoint === undefined ? {} : { checkpoint });
  return kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`), box.replacements);
  }, { requiresNativePlacement: false });
}

async function commit(box: Fixture, checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>) {
  const kernel = new StorageTransactions(checkpoint === undefined ? {} : { checkpoint });
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`);
  return kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const review = await session.prepareSourcesReview(revision, catalogBytes, box.replacements);
    const approvedSensitivePaths = readStorageReview(review).sensitivePaths;
    await session.commit(revision, catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths },
    });
  }, { requiresNativePlacement: false });
}

function crashWriter(box: Fixture, checkpoint: StorageCheckpoint): ChildProcessWithoutNullStreams {
  const sourceRun = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(sourceRun ? "../src/storage-transaction.ts" : "../src/storage-transaction.js", import.meta.url).href;
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`).toString("base64");
  const code = `import {StorageTransactions} from ${JSON.stringify(moduleUrl)};
const kernel=new StorageTransactions({checkpoint:async(point)=>{if(point===${JSON.stringify(checkpoint)}){console.log('PAUSED');setInterval(()=>{},1000);await new Promise(()=>{});}}});
await kernel.run(${JSON.stringify(box.libraryDir)},false,async(session)=>{
const revision=await session.capture();
const catalog=Buffer.from(${JSON.stringify(catalogBytes)},'base64');
const replacements=[{itemId:${JSON.stringify(skillId)},files:[{path:'SKILL.md',mode:493,bytes:Buffer.from(${JSON.stringify(box.skillBytes.toString())})},{path:'docs/added.md',mode:416,bytes:Buffer.from(${JSON.stringify(box.addedBytes.toString())})}]}];
const review=await session.prepareSourcesReview(revision,catalog,replacements);
await session.commit(revision,catalog,replacements,{review,approval:{reviewId:review.reviewId,confirmed:true,approvedSensitivePaths:[]}});
},{requiresNativePlacement:false});`;
  const options = sourceRun ? ["--experimental-transform-types", "--input-type=module", "-e", code] : ["--input-type=module", "-e", code];
  return spawn(process.execPath, options, { cwd: box.root, env: process.env });
}

async function crashAt(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  let close!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { close = resolve; });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("close", (code, signal) => close({ code, signal }));
  const deadline = Date.now() + 10_000;
  while (!output.includes("PAUSED") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!output.includes("PAUSED")) {
    child.kill();
    const exit = await exited;
    throw new Error(`Tree writer did not reach its checkpoint (${exit.code}/${exit.signal}): ${output}`);
  }
  child.kill("SIGKILL");
  assert.equal((await exited).signal, "SIGKILL");
}

async function recover(box: Fixture): Promise<void> {
  await new StorageTransactions({ waitMilliseconds: 100 }).run(box.libraryDir, false, async () => {}, { requiresNativePlacement: false });
}

test("registered tree replacement stages fixed included files and swaps only that item root", async (t) => {
  const box = await fixture(t);
  const targetBefore = await lstat(box.skillRoot);
  const sourcesBefore = await lstat(box.sources);
  const neighborBefore = await lstat(box.neighborRoot);
  const neighborFile = path.join(box.neighborRoot, "neighbor.md");
  const neighborFileBefore = await lstat(neighborFile);
  const unregisteredPath = path.join(box.sources, "unregistered", "note.md");
  const unregisteredBefore = await lstat(unregisteredPath);

  await commit(box);

  const targetAfter = await lstat(box.skillRoot);
  assert.notEqual(`${targetAfter.dev}:${targetAfter.ino}`, `${targetBefore.dev}:${targetBefore.ino}`);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.skillBytes);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "docs", "added.md")), box.addedBytes);
  const committedCatalog = JSON.parse(await readFile(box.catalogPath, "utf8")) as Catalog;
  assert.deepEqual(committedCatalog.items[0]!.files.map(({ path: filePath, mode }) => ({ path: filePath, mode })), [
    { path: "SKILL.md", mode: 0o755 }, { path: "docs/added.md", mode: 0o640 },
  ]);
  await assert.rejects(lstat(path.join(box.skillRoot, "docs", "removed.md")), { code: "ENOENT" });
  assert.equal((await lstat(path.join(box.skillRoot, "SKILL.md"))).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(box.skillRoot, "docs"))).mode & 0o777, 0o700);
  assert.equal((await lstat(box.skillRoot)).mode & 0o777, 0o700);
  assert.equal(`${(await lstat(box.sources)).dev}:${(await lstat(box.sources)).ino}`, `${sourcesBefore.dev}:${sourcesBefore.ino}`);
  assert.equal(`${(await lstat(box.neighborRoot)).dev}:${(await lstat(box.neighborRoot)).ino}`, `${neighborBefore.dev}:${neighborBefore.ino}`);
  assert.equal(`${(await lstat(neighborFile)).dev}:${(await lstat(neighborFile)).ino}`, `${neighborFileBefore.dev}:${neighborFileBefore.ino}`);
  assert.equal(await readFile(neighborFile, "utf8"), "neighbor item\n");
  assert.equal(`${(await lstat(unregisteredPath)).dev}:${(await lstat(unregisteredPath)).ino}`, `${unregisteredBefore.dev}:${unregisteredBefore.ino}`);
  assert.equal(await readFile(unregisteredPath, "utf8"), "unregistered sibling\n");
  assert.deepEqual((await readdir(box.sources)).sort(), [skillId, "neighbor", "unregistered"]);
});

test("tree replacement refuses to delete an unregistered ordinary child without a before review", async (t) => {
  const box = await fixture(t);
  const retainedBytes = Buffer.from("remove me\n");
  box.next.items[0]!.files = [
    { path: "SKILL.md", mode: 0o755, sha256: digest(box.skillBytes) },
    { path: "docs/removed.md", mode: 0o600, sha256: digest(retainedBytes) },
  ];
  box.replacements[0]!.files = [
    { path: "SKILL.md", mode: 0o755, bytes: box.skillBytes },
    { path: "docs/removed.md", mode: 0o600, bytes: retainedBytes },
  ];
  const unreviewedPath = path.join(box.skillRoot, "notes.md");
  const unreviewed = Buffer.from("ordinary unregistered child\\n");
  await writeFile(unreviewedPath, unreviewed, { mode: 0o600 });
  await assert.rejects(commitWithoutReview(box), /unreviewed|unregistered|ordinary child/i);
  assert.deepEqual(await readFile(unreviewedPath), unreviewed);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.initialSkill);
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.catalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("confirmed opaque before review permits deleting captured ordinary tree children", async (t) => {
  const box = await fixture(t);
  const unregisteredPath = path.join(box.skillRoot, "notes.md");
  const unregistered = Buffer.from("ordinary child captured privately before review\n");
  await writeFile(unregisteredPath, unregistered, { mode: 0o600 });
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`);
  await new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const review = await session.prepareSourcesReview(revision, catalogBytes, box.replacements);
    const view = readStorageReview(review);
    assert.deepEqual(view.sensitivePaths, []);
    assert.equal(JSON.stringify(view).includes(unregistered.toString()), false);
    assert.deepEqual(Object.keys(review), ["reviewId"]);
    await session.commit(revision, catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: view.sensitivePaths },
    });
  }, { requiresNativePlacement: false });
  await assert.rejects(lstat(path.join(box.skillRoot, "docs", "removed.md")), { code: "ENOENT" });
  await assert.rejects(lstat(unregisteredPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.skillBytes);
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.next);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("an ordinary tree child is replaced only when its bytes are included in the reviewed content", async (t) => {
  const box = await fixture(t);
  const reviewedPath = path.join(box.skillRoot, "notes.md");
  const reviewedBytes = Buffer.from("reviewed ordinary child\\n");
  await writeFile(reviewedPath, "unreviewed current version\\n", { mode: 0o600 });
  box.next.items[0]!.files.push({ path: "notes.md", mode: 0o600, sha256: digest(reviewedBytes) });
  box.replacements[0]!.files.push({ path: "notes.md", mode: 0o600, bytes: reviewedBytes });
  await commit(box);
  assert.deepEqual(await readFile(reviewedPath), reviewedBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("tree edits after capture are rejected before any transaction is written", async (t) => {
  const box = await fixture(t);
  const kernel = new StorageTransactions();
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`);
    const review = await session.prepareSourcesReview(revision, catalogBytes, box.replacements);
    const approvedSensitivePaths = readStorageReview(review).sensitivePaths;
    await writeFile(path.join(box.skillRoot, "after-capture.md"), "external after capture\\n", { mode: 0o600 });
    await assert.rejects(session.commit(revision, catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths },
    }), /changed|unreviewed|tree/i);
  }, { requiresNativePlacement: false });
  assert.equal(await readFile(path.join(box.skillRoot, "after-capture.md"), "utf8"), "external after capture\\n");
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("tree child additions and deletions at swap and finalization checkpoints are preserved with the journal", async (t) => {
  for (const checkpoint of ["before-swap", "old-renamed", "before-catalog", "finalized"] as const) {
    for (const edit of ["add", "delete"] as const) {
      await t.test(`${checkpoint}/${edit}`, async (st) => {
        const box = await fixture(st);
        const editedRoot = checkpoint === "old-renamed"
          ? path.join(box.libraryDir, ".copi-transaction", "old-0")
          : box.skillRoot;
        const addedPath = path.join(editedRoot, `external-${checkpoint}.md`);
        const deletedPath = path.join(editedRoot, checkpoint === "before-swap" || checkpoint === "old-renamed" ? "docs/removed.md" : "docs/added.md");
        const addedBytes = Buffer.from(`ordinary child added at ${checkpoint}\\n`);
        await assert.rejects(commit(box, async (point) => {
          if (point !== checkpoint) return;
          if (edit === "add") await writeFile(addedPath, addedBytes, { mode: 0o600 });
          else await rm(deletedPath);
          if (checkpoint !== "finalized") throw new Error(`external tree ${edit} at ${checkpoint}`);
        }), /changed|external|recover|tree|finalized/i);
        if (edit === "add") assert.deepEqual(await readFile(addedPath), addedBytes);
        else await assert.rejects(lstat(deletedPath), { code: "ENOENT" });
        assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
        assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), checkpoint === "finalized" ? box.next : box.catalog);
      });
    }
  }
});

test("tree replacement reoperation after normal success leaves no transaction lock", async (t) => {
  const box = await fixture(t);
  await commit(box);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  const second = Buffer.from("second reviewed skill\\n");
  box.next.items[0]!.files = [{ path: "SKILL.md", mode: 0o755, sha256: digest(second) }];
  box.replacements[0]!.files = [{ path: "SKILL.md", mode: 0o755, bytes: second }];
  await commit(box);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), second);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("tree replacement cancellation restores the original root and preserves sibling trees", async (t) => {
  const box = await fixture(t);
  const rootBefore = await lstat(box.skillRoot);
  const skillBefore = await readFile(path.join(box.skillRoot, "SKILL.md"));
  const neighborBefore = await lstat(box.neighborRoot);
  await assert.rejects(commit(box, (point) => { if (point === "before-catalog") throw new Error("cancel tree commit"); }), /cancel tree commit/);
  assert.equal(`${(await lstat(box.skillRoot)).dev}:${(await lstat(box.skillRoot)).ino}`, `${rootBefore.dev}:${rootBefore.ino}`);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), skillBefore);
  assert.equal(await readFile(path.join(box.skillRoot, "docs", "removed.md"), "utf8"), "remove me\n");
  assert.equal(`${(await lstat(box.neighborRoot)).dev}:${(await lstat(box.neighborRoot)).ino}`, `${neighborBefore.dev}:${neighborBefore.ino}`);
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "sources"]);
});

test("tree journal recovery rolls an interrupted root swap back without changing neighboring content", async (t) => {
  const box = await fixture(t);
  await crashAt(crashWriter(box, "new-renamed"));
  await recover(box);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.initialSkill);
  assert.equal(await readFile(path.join(box.skillRoot, "docs", "removed.md"), "utf8"), "remove me\n");
  assert.equal(await readFile(path.join(box.neighborRoot, "neighbor.md"), "utf8"), "neighbor item\n");
  assert.equal(await readFile(path.join(box.sources, "unregistered", "note.md"), "utf8"), "unregistered sibling\n");
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("tree recovery accepts a catalog-swapped commit and cleans only checked tree artifacts", async (t) => {
  const box = await fixture(t);
  await crashAt(crashWriter(box, "catalog-renamed"));
  await recover(box);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.skillBytes);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "docs", "added.md")), box.addedBytes);
  await assert.rejects(lstat(path.join(box.skillRoot, "docs", "removed.md")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("tree commit preserves same-inode external edits at before-swap, old-renamed, and before-catalog", async (t) => {
  for (const checkpoint of ["before-swap", "old-renamed", "before-catalog"] as const) {
    await t.test(checkpoint, async (st) => {
      const box = await fixture(st);
      const external = Buffer.from(`external edit ${checkpoint}\n`);
      let editedPath = path.join(box.skillRoot, "SKILL.md");
      await assert.rejects(commit(box, async (point, root) => {
        if (point !== checkpoint) return;
        if (checkpoint === "old-renamed") editedPath = path.join(root, ".copi-transaction", "old-0", "SKILL.md");
        if (checkpoint === "before-catalog") editedPath = path.join(box.skillRoot, "SKILL.md");
        await writeFile(editedPath, external);
        throw new Error(`external ${checkpoint}`);
      }), /could not safely recover|external|changed/i);
      assert.deepEqual(await readFile(editedPath), external);
      assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
      assert.equal(await readFile(path.join(box.neighborRoot, "neighbor.md"), "utf8"), "neighbor item\n");
    });
  }
});

test("tree replacement requires opaque per-file approval for sensitive staged content", async (t) => {
  const box = await fixture(t);
  const secret = Buffer.from("apiKey=sk_live_tree_transaction_secret123456\n");
  box.next.items[0]!.files = [{ path: "SKILL.md", mode: 0o644, sha256: digest(secret) }];
  box.replacements[0]!.files = [{ path: "SKILL.md", mode: 0o644, bytes: secret }];
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`);
  const approvedSensitivePaths = [`${skillId}/SKILL.md`];
  let privateModes: number[] = [];
  const kernel = new StorageTransactions({ checkpoint: async (point, root) => {
    if (point !== "stage-write") return;
    const stage = path.join(root, ".copi-transaction", "next-0");
    privateModes = [
      (await lstat(stage)).mode & 0o777,
      (await lstat(path.join(stage, "SKILL.md"))).mode & 0o777,
    ];
  } });
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const review = await session.prepareSourcesReview(revision, catalogBytes, box.replacements);
    assert.deepEqual(readStorageReview(review).sensitivePaths, approvedSensitivePaths);
    await assert.rejects(session.commit(revision, catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [] },
    }), /approval|inspection/i);
    await session.commit(revision, catalogBytes, box.replacements, {
      review,
      approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths },
    });
  }, { requiresNativePlacement: false });
  assert.deepEqual(privateModes, [0o700, 0o600]);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), secret);
});

test("tree recovery rejects a symlink inserted into the private stage and preserves its outside target", async (t) => {
  const box = await fixture(t);
  await crashAt(crashWriter(box, "journal"));
  const stage = path.join(box.libraryDir, ".copi-transaction", "next-0");
  const outside = path.join(box.root, "outside.md");
  await writeFile(outside, "outside bytes\n");
  await rm(path.join(stage, "SKILL.md"));
  await symlink(outside, path.join(stage, "SKILL.md"));
  await assert.rejects(recover(box), /altered|unsafe|symbolic|stage|changed/i);
  assert.equal(await readFile(outside, "utf8"), "outside bytes\n");
  assert.ok((await lstat(path.join(stage, "SKILL.md"))).isSymbolicLink());
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
});

test("tree recovery rejects and retains an unknown file added to the staged tree", async (t) => {
  const box = await fixture(t);
  await crashAt(crashWriter(box, "journal"));
  const stage = path.join(box.libraryDir, ".copi-transaction", "next-0");
  const unknownPath = path.join(stage, "unexpected-private-note.md");
  const unknown = Buffer.from("unrecognized stage bytes\n");
  await writeFile(unknownPath, unknown, { mode: 0o600 });
  await assert.rejects(recover(box), /altered|stage|changed|tree/i);
  assert.deepEqual(await readFile(unknownPath), unknown);
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
});

test("finalized tree cleanup preserves unknown files added to the retained old root", async (t) => {
  const box = await fixture(t);
  const unknown = Buffer.from("unexpected old tree bytes\n");
  const unknownPath = path.join(box.libraryDir, ".copi-transaction", "old-0", "private-note.md");
  await assert.rejects(commit(box, async (point) => {
    if (point === "finalized") await writeFile(unknownPath, unknown, { mode: 0o600 });
  }), /changed|cleanup|preserv|recover/i);
  assert.deepEqual(await readFile(unknownPath), unknown);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.skillBytes);
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
});

test("finalized cleanup manifest binds private artifact kind to the tree operation", async (t) => {
  const box = await fixture(t);
  await assert.rejects(commit(box, async (point, root) => {
    if (point !== "finalized") return;
    const lock = path.join(root, ".copi-transaction");
    const manifestPath = path.join(lock, "finalized.json");
    const record = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const cleanup = record.cleanup as { artifacts: Array<{ name: string; kind: string }> };
    const oldArtifact = cleanup.artifacts.find((artifact) => artifact.name === "old-0");
    assert.equal(oldArtifact?.kind, "source-tree");
    oldArtifact!.kind = "source-file";
    const bytes = Buffer.from(JSON.stringify(record));
    await writeFile(manifestPath, bytes);
    await writeFile(path.join(lock, "finalized.digest"), digest(bytes));
  }), /manifest|kind|cleanup|recover/i);
  assert.equal(await readFile(path.join(box.libraryDir, ".copi-transaction", "old-0", "SKILL.md"), "utf8"), "# Original skill\n");
  assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction")));
});

test("tree replacement fails closed and retains the entire original root when excluded private content exists", async (t) => {
  const box = await fixture(t);
  const privateFile = path.join(box.skillRoot, ".envrc");
  const privateBytes = Buffer.from("SECRET=must stay local\n");
  await writeFile(privateFile, privateBytes, { mode: 0o600 });
  const rootBefore = await lstat(box.skillRoot);
  await assert.rejects(commit(box), /private|excluded|unsafe/i);
  assert.equal(`${(await lstat(box.skillRoot)).dev}:${(await lstat(box.skillRoot)).ino}`, `${rootBefore.dev}:${rootBefore.ino}`);
  assert.deepEqual(await readFile(privateFile), privateBytes);
  assert.deepEqual(await readFile(path.join(box.skillRoot, "SKILL.md")), box.initialSkill);
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.catalog);
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "sources"]);
});
