import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertModernCatalog, importResource, loadCatalog, prepareResource, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { executeApply, planApply } from "../src/apply.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import type { ResourceCandidate, SavedItem } from "../src/types.ts";

interface Fixture {
  root: string;
  sourceRoot: string;
  projectDir: string;
  libraryDir: string;
}

interface TreeEntry {
  kind: "directory" | "file" | "link";
  mode: number;
  dev: number;
  ino: number;
  bytes?: string;
  target?: string;
}

type TreeSnapshot = Record<string, TreeEntry>;

async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-sources-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const sourceRoot = path.join(root, "origin");
  const projectDir = path.join(root, "project");
  const libraryDir = path.join(home, ".copi");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sourceRoot), mkdir(projectDir)]);
  return { root, sourceRoot, projectDir, libraryDir };
}

async function saveSkill(
  box: Fixture,
  options: { name?: string; files: Record<string, string | Buffer>; modes?: Record<string, number> },
): Promise<SavedItem> {
  const name = options.name ?? "apply-focus";
  const sourcePath = path.join(box.sourceRoot, name);
  await mkdir(sourcePath, { recursive: true });
  for (const [relative, content] of Object.entries(options.files)) {
    const target = path.join(sourcePath, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const mode = options.modes?.[relative] ?? 0o644;
    await writeFile(target, content, { mode });
    await chmod(target, mode);
  }

  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  catalog.groups.push({ id: "apply-focus", name: "Apply focus", itemIds: [] });
  await saveCatalog(box.libraryDir, catalog);

  const candidate: ResourceCandidate = {
    id: name,
    kind: "skill",
    source: "sources-apply-test",
    scope: "project",
    sourceRoot: box.sourceRoot,
    sourcePath,
    name,
    destination: { kind: "project", path: `.pi/skills/${name}` },
  };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importResource(box.libraryDir, candidate, {
    confirmed: true,
    groupIds: ["apply-focus"],
    inspection,
    approvedSensitivePaths: inspection.sensitivePaths,
  });
  assert.ok(item);
  return item;
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const entries: TreeSnapshot = {};
  async function visit(target: string, relative: string): Promise<void> {
    const stat = await lstat(target);
    const base = { mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
    if (stat.isSymbolicLink()) {
      entries[relative] = { kind: "link", ...base, target: await readlink(target) };
    } else if (stat.isDirectory()) {
      entries[relative] = { kind: "directory", ...base };
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), path.posix.join(relative, name));
    } else if (stat.isFile()) {
      entries[relative] = { kind: "file", ...base, bytes: (await readFile(target)).toString("base64") };
    } else {
      throw new Error(`Unexpected special file in synthetic fixture: ${target}`);
    }
  }
  await visit(root, ".");
  return entries;
}

function treeDigest(tree: TreeSnapshot): string {
  return createHash("sha256").update(JSON.stringify(tree)).digest("hex");
}

function savedContentRoot(box: Fixture, item: SavedItem): string {
  if (item.content.kind !== "tree") throw new Error("Apply-focused skill fixture must use a tree content location.");
  return path.join(box.libraryDir, ...item.content.path.split("/"));
}

function isStalePlanRejection(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Copi library changed after preparation");
}

test("applies current source bytes without repairing stale descriptors; plan is read-only and origin/items are unnecessary", async (t) => {
  const box = await fixture(t);
  const item = await saveSkill(box, {
    files: { "SKILL.md": "approved bytes before direct edit\n", "support.md": "support content\n" },
    modes: { "SKILL.md": 0o755, "support.md": 0o640 },
  });
  const originalDescriptors = structuredClone(item.files);
  const contentRoot = savedContentRoot(box, item);
  const storedSkill = path.join(contentRoot, "SKILL.md");
  const editedBytes = Buffer.from("manual current source edit before preview\n");

  await rm(item.sourcePath, { recursive: true });
  await writeFile(storedSkill, editedBytes);
  await assert.rejects(lstat(path.join(box.libraryDir, "items")), { code: "ENOENT" });
  await assert.rejects(lstat(item.sourcePath), { code: "ENOENT" });
  assert.equal((await lstat(storedSkill)).mode & 0o777, 0o600, "registered source bytes stay private in storage");
  assert.equal(item.files.find((file) => file.path === "SKILL.md")?.mode, 0o755, "descriptor retains the approved distribution mode");

  const libraryBeforePlan = await snapshotTree(box.libraryDir);
  const projectBeforePlan = await snapshotTree(box.projectDir);
  const plan = await planApply(box.libraryDir, "apply-focus", box.projectDir);
  assert.equal(plan.files.find((file) => file.path === ".pi/skills/apply-focus/SKILL.md")?.status, "new");
  assert.equal(treeDigest(await snapshotTree(box.libraryDir)), treeDigest(libraryBeforePlan), "dry-run must not mutate library bytes, modes, or inodes");
  assert.equal(treeDigest(await snapshotTree(box.projectDir)), treeDigest(projectBeforePlan), "dry-run must not mutate the target tree");

  const result = await executeApply(box.libraryDir, plan, {});
  const destination = path.join(box.projectDir, ".pi/skills/apply-focus/SKILL.md");
  assert.deepEqual(result.written, [".pi/skills/apply-focus/SKILL.md", ".pi/skills/apply-focus/support.md"]);
  assert.deepEqual(await readFile(destination), editedBytes);
  assert.equal((await lstat(destination)).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(box.projectDir, ".pi/skills/apply-focus/support.md"))).mode & 0o777, 0o640);

  const current = await loadCatalog(box.libraryDir);
  assertModernCatalog(current);
  assert.deepEqual(current.items[0]?.files, originalDescriptors, "applying current bytes must not auto-repair descriptor SHA or metadata");
  const currentSnapshot = await readSnapshotFiles(box.libraryDir, current.items[0]!);
  assert.deepEqual(currentSnapshot.find((file) => file.path === "SKILL.md")?.bytes, editedBytes);
  assert.notEqual(currentSnapshot.find((file) => file.path === "SKILL.md")?.sha256, originalDescriptors.find((file) => file.path === "SKILL.md")?.sha256);
});

for (const mutation of ["ordinary child added", "ordinary child removed"] as const) {
  test(`rejects plan after ${mutation} without further library or destination changes`, async (t) => {
    const box = await fixture(t);
    const item = await saveSkill(box, {
      files: { "SKILL.md": "current skill\n", "notes.md": "ordinary note\n" },
    });
    const plan = await planApply(box.libraryDir, "apply-focus", box.projectDir);
    const contentRoot = savedContentRoot(box, item);
    if (mutation === "ordinary child added") {
      await writeFile(path.join(contentRoot, "later.md"), "new ordinary child\n", { mode: 0o600 });
    } else {
      await rm(path.join(contentRoot, "notes.md"));
    }

    const libraryAfterMutation = await snapshotTree(box.libraryDir);
    const destinationBeforeApply = await snapshotTree(box.projectDir);
    await assert.rejects(executeApply(box.libraryDir, plan, {}), isStalePlanRejection);
    assert.deepEqual(await snapshotTree(box.libraryDir), libraryAfterMutation, "rejection must preserve the post-edit bytes and inodes");
    assert.deepEqual(await snapshotTree(box.projectDir), destinationBeforeApply, "rejection must not create or alter destination files");
  });
}

test("rejects a plan after a private secret is added and retains it outside the project", async (t) => {
  const box = await fixture(t);
  const item = await saveSkill(box, { files: { "SKILL.md": "current skill\n" } });
  const plan = await planApply(box.libraryDir, "apply-focus", box.projectDir);
  const secretPath = path.join(savedContentRoot(box, item), ".env.production");
  const secretBytes = Buffer.from("synthetic API key: sk_live_private_after_plan_123456\n");
  await writeFile(secretPath, secretBytes, { mode: 0o600 });

  const libraryAfterSecret = await snapshotTree(box.libraryDir);
  const destinationBeforeApply = await snapshotTree(box.projectDir);
  await assert.rejects(executeApply(box.libraryDir, plan, {}), isStalePlanRejection);
  assert.deepEqual(await snapshotTree(box.libraryDir), libraryAfterSecret, "the newly added private file and all source inodes must be retained");
  assert.deepEqual(await snapshotTree(box.projectDir), destinationBeforeApply);
  assert.deepEqual(await readFile(secretPath), secretBytes);
  await assert.rejects(lstat(path.join(box.projectDir, ".pi/skills/apply-focus/.env.production")), { code: "ENOENT" });
});

test("rejects a plan after catalog metadata changes without rewriting that catalog or target", async (t) => {
  const box = await fixture(t);
  await saveSkill(box, { files: { "SKILL.md": "current skill\n" } });
  const plan = await planApply(box.libraryDir, "apply-focus", box.projectDir);
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  catalog.groups[0]!.name = "Changed after preview";
  await saveCatalog(box.libraryDir, catalog);

  const libraryAfterCatalogChange = await snapshotTree(box.libraryDir);
  const destinationBeforeApply = await snapshotTree(box.projectDir);
  await assert.rejects(executeApply(box.libraryDir, plan, {}), isStalePlanRejection);
  assert.deepEqual(await snapshotTree(box.libraryDir), libraryAfterCatalogChange, "the deliberate catalog edit must not be overwritten");
  assert.deepEqual(await snapshotTree(box.projectDir), destinationBeforeApply);
});

test("rejects a plan after a registered source file becomes a symlink and preserves the external inode", async (t) => {
  const box = await fixture(t);
  const item = await saveSkill(box, { files: { "SKILL.md": "current skill\n", "ordinary.md": "registered child\n" } });
  const plan = await planApply(box.libraryDir, "apply-focus", box.projectDir);
  const linkedSource = path.join(savedContentRoot(box, item), "ordinary.md");
  const externalFile = path.join(box.root, "held-external-source.md");
  await rename(linkedSource, externalFile);
  await symlink(externalFile, linkedSource);

  const libraryAfterSwap = await snapshotTree(box.libraryDir);
  const externalBefore = await snapshotTree(externalFile);
  const destinationBeforeApply = await snapshotTree(box.projectDir);
  await assert.rejects(executeApply(box.libraryDir, plan, {}), /symbolic link/i);
  assert.deepEqual(await snapshotTree(box.libraryDir), libraryAfterSwap, "the source symlink and catalog must remain exactly as found");
  assert.deepEqual(await snapshotTree(externalFile), externalBefore, "external bytes and inode must not be touched");
  assert.deepEqual(await snapshotTree(box.projectDir), destinationBeforeApply);
  assert.ok((await lstat(linkedSource)).isSymbolicLink());
  assert.equal(await readlink(linkedSource), externalFile);
});
