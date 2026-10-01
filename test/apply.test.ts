import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, loadCatalog, saveCatalog } from "../src/catalog.ts";
import { executeApply, planApply } from "../src/apply.ts";
import type { ResourceCandidate, ResourceKind } from "../src/types.ts";

interface Sandbox {
  root: string;
  homeDir: string;
  agentDir: string;
  projectDir: string;
  libraryDir: string;
  sourceRoot: string;
}

async function sandbox(t: test.TestContext): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "synthetic-home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(root, "synthetic-cwd");
  const sourceRoot = path.join(root, "synthetic-source");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir), mkdir(sourceRoot)]);
  return { root, homeDir, agentDir, projectDir, libraryDir: path.join(homeDir, ".copi"), sourceRoot };
}

async function addSkill(box: Sandbox, options: { name: string; content?: string; files?: Record<string, string | Buffer>; destination?: string; groupId?: string; kind?: ResourceKind; mode?: number; globalOnly?: boolean }) {
  const sourcePath = path.join(box.sourceRoot, options.name);
  await mkdir(sourcePath, { recursive: true });
  const files = options.files ?? { "SKILL.md": options.content ?? `# ${options.name}\n` };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(sourcePath, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: options.mode ?? 0o644 });
    if (options.mode !== undefined) await chmod(target, options.mode);
  }
  const catalog = await loadCatalog(box.libraryDir);
  if (!catalog.groups.some((group) => group.id === (options.groupId ?? "bundle"))) {
    catalog.groups.push({ id: options.groupId ?? "bundle", name: "Bundle", itemIds: [] });
  }
  await saveCatalog(box.libraryDir, catalog);
  const candidate: ResourceCandidate = {
    id: options.name,
    kind: options.kind ?? "skill",
    source: "synthetic-test",
    scope: "project",
    sourceRoot: box.sourceRoot,
    sourcePath,
    name: options.name,
    destination: options.globalOnly ? { kind: "global-only" } : { kind: "project", path: options.destination ?? `.pi/skills/${options.name}` },
  };
  const item = await importResource(box.libraryDir, candidate, { confirmed: true, groupIds: [options.groupId ?? "bundle"] });
  assert.ok(item);
  return item;
}

test("plans from verified snapshots after the source is deleted and masks credential text", async (t) => {
  const box = await sandbox(t);
  const item = await addSkill(box, { name: "review", files: { "SKILL.md": "apiKey: sk_live_1234567890abcdef\n" } });
  await rm(path.join(box.sourceRoot, "review"), { recursive: true });

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const entry = plan.files.find((file) => file.path === ".pi/skills/review/SKILL.md");
  assert.equal(entry?.itemId, item.id);
  assert.equal(entry?.status, "new");
  assert.ok(entry?.preview?.kind === "text");
  assert.ok(!entry.preview.diff.includes("sk_live_1234567890abcdef"));
  assert.ok(entry.preview.diff.includes("[REDACTED]"));
  assert.ok(plan.warnings.some((warning) => warning.code === "sensitive-content" && warning.path === entry.path));
});

test("keeps an existing file when the user chooses keep", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "review", content: "new content\n" });
  const target = path.join(box.projectDir, ".pi/skills/review/SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "existing content\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);

  const result = await executeApply(box.libraryDir, plan, { existing: { [".pi/skills/review/SKILL.md"]: "keep" } });
  assert.deepEqual(result.kept, [".pi/skills/review/SKILL.md"]);
  assert.equal(await readFile(target, "utf8"), "existing content\n");
  assert.deepEqual(result.backups, []);
});

test("backs up replaced bytes and mode privately before applying snapshot bytes and mode", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "tool", content: "new executable\n", mode: 0o755 });
  const relative = ".pi/skills/tool/SKILL.md";
  const target = path.join(box.projectDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old content\n", { mode: 0o640 });
  await chmod(target, 0o640);
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);

  const result = await executeApply(box.libraryDir, plan, { existing: { [relative]: "replace" } });
  assert.equal(await readFile(target, "utf8"), "new executable\n");
  assert.equal((await stat(target)).mode & 0o777, 0o755);
  assert.equal(result.backups.length, 1);
  assert.equal(await readFile(result.backups[0]!.backupPath, "utf8"), "old content\n");
  assert.equal((await stat(result.backups[0]!.backupPath)).mode & 0o777, 0o600);
  assert.equal(result.backups[0]!.mode, 0o640);
});

test("requires a choice for conflicting group content and applies only the selected snapshot", async (t) => {
  const box = await sandbox(t);
  const first = await addSkill(box, { name: "first", content: "from first\n", destination: ".pi/skills/shared" });
  const second = await addSkill(box, { name: "second", content: "from second\n", destination: ".pi/skills/shared", groupId: "second" });
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups[0]!.itemIds.push(second.id);
  await saveCatalog(box.libraryDir, catalog);

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(plan.collisions.map(({ path: itemPath, itemIds }) => ({ path: itemPath, itemIds })), [
    { path: ".pi/skills/shared/SKILL.md", itemIds: [first.id, second.id] },
  ]);
  await assert.rejects(executeApply(box.libraryDir, plan, {}), /collision|selection/i);
  await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/shared/SKILL.md")), { code: "ENOENT" });

  await executeApply(box.libraryDir, plan, { collisions: { [".pi/skills/shared/SKILL.md"]: second.id } });
  assert.equal(await readFile(path.join(box.projectDir, ".pi/skills/shared/SKILL.md"), "utf8"), "from second\n");
});

test("requires per-file secret approval before writing any selected file", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "keys", files: { "SKILL.md": "safe\n", "keys.json": '{"apiKey":"sk_live_1234567890abcdef"}\n' } });
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  await assert.rejects(executeApply(box.libraryDir, plan, {}), /approval|sensitive|secret/i);
  await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/keys/SKILL.md")), { code: "ENOENT" });

  await executeApply(box.libraryDir, plan, { secretApprovals: [".pi/skills/keys/keys.json"] });
  assert.equal(await readFile(path.join(box.projectDir, ".pi/skills/keys/SKILL.md"), "utf8"), "safe\n");
  assert.ok((await readFile(path.join(box.projectDir, ".pi/skills/keys/keys.json"), "utf8")).includes("sk_live_1234567890abcdef"));
});

test("does not apply a global-only item and warns about project-disabled Pi settings without rewriting", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, {
    name: "settings",
    kind: "pi-settings",
    destination: ".pi/settings.json",
    files: { "settings.json": '{"defaultProjectTrust":"trusted","httpProxy":"http://proxy","cacheWarming":true}\n' },
  });
  const reference = await addSkill(box, {
    name: "models",
    groupId: "bundle",
    kind: "model-config",
    globalOnly: true,
    files: { "models.json": "{}\\n" },
  });

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.ok(plan.warnings.some((warning) => warning.code === "project-setting-restricted"));
  const result = await executeApply(box.libraryDir, plan, {});
  assert.ok(result.skippedItems.includes(reference.id));
  assert.equal(await readFile(path.join(box.projectDir, ".pi/settings.json"), "utf8"), '{"defaultProjectTrust":"trusted","httpProxy":"http://proxy","cacheWarming":true}\n');
});

test("rejects destination symlink ancestors before writing outside the project", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "escape" });
  const outside = path.join(box.root, "outside");
  await mkdir(outside);
  await mkdir(path.join(box.projectDir, ".pi"));
  await symlink(outside, path.join(box.projectDir, ".pi", "skills"), "dir");

  await assert.rejects(planApply(box.libraryDir, "bundle", box.projectDir), /symbolic|symlink|safe|outside/i);
  await assert.rejects(readFile(path.join(outside, "escape", "SKILL.md")), { code: "ENOENT" });
});

test("rejects a read-only destination ancestor before any file is written", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "locked" });
  const destinationRoot = path.join(box.projectDir, ".pi/skills/locked");
  await mkdir(destinationRoot, { recursive: true });
  await chmod(destinationRoot, 0o555);
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);

  try {
    await assert.rejects(executeApply(box.libraryDir, plan, {}), /permission|writ|read-only/i);
    await assert.rejects(readFile(path.join(destinationRoot, "SKILL.md")), { code: "ENOENT" });
  } finally {
    await chmod(destinationRoot, 0o755);
  }
});

test("summarizes binary snapshot previews without decoding their bytes as text", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "asset", files: { "asset.bin": Buffer.from([0, 1, 127, 128, 255]) } });
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const preview = plan.files.find((file) => file.path === ".pi/skills/asset/asset.bin")?.preview;
  assert.equal(preview?.kind, "binary");
  assert.match(preview?.kind === "binary" ? preview.summary : "", /5 bytes/);
});

test("cancels the entire apply when any existing-file choice is abort", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "review", content: "new content\n" });
  const existing = path.join(box.projectDir, ".pi/skills/review/SKILL.md");
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, "old content\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);

  const result = await executeApply(box.libraryDir, plan, { existing: { [".pi/skills/review/SKILL.md"]: "abort" } });
  assert.equal(result.cancelled, true);
  assert.equal(await readFile(existing, "utf8"), "old content\n");
});

test("rejects a tampered catalog destination before using it to write", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "tampered" });
  const manifestPath = path.join(box.libraryDir, "catalog.json");
  const catalog = JSON.parse(await readFile(manifestPath, "utf8")) as { items: Array<{ destination: { kind: string; path?: string } }> };
  catalog.items[0]!.destination = { kind: "project", path: "../../outside" };
  await writeFile(manifestPath, JSON.stringify(catalog));

  await assert.rejects(planApply(box.libraryDir, "bundle", box.projectDir), /catalog|invalid|destination/i);
  await assert.rejects(readFile(path.join(box.root, "outside", "tampered", "SKILL.md")), { code: "ENOENT" });
});

test("skips a destination whose bytes and mode already match the snapshot", async (t) => {
  const box = await sandbox(t);
  await addSkill(box, { name: "same", content: "same content" });
  const target = path.join(box.projectDir, ".pi/skills/same/SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "same content", { mode: 0o644 });
  await chmod(target, 0o644);
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.files[0]?.status, "identical");

  const result = await executeApply(box.libraryDir, plan, {});
  assert.deepEqual(result.written, []);
  assert.equal(await readFile(target, "utf8"), "same content");
});

test("does not apply cached private paths even when present in a stored snapshot", async (t) => {
  const box = await sandbox(t);
  const item = await addSkill(box, { name: "cached", content: "supported content\n" });
  const catalog = await loadCatalog(box.libraryDir);
  const saved = catalog.items.find((entry) => entry.id === item.id)!;
  const excludedPaths = [".cache/private.txt", "nested/.npm/private.txt"];
  for (const relative of excludedPaths) {
    const bytes = Buffer.from("private cache content\n");
    const filePath = path.join(box.libraryDir, "items", item.id, "files", ...relative.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    saved.files.push({ path: relative, mode: 0o600, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await saveCatalog(box.libraryDir, catalog);

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(plan.files.map((file) => file.path), [".pi/skills/cached/SKILL.md"]);
  assert.ok(excludedPaths.every((relative) => plan.warnings.some((warning) => warning.code === "private-path-skipped" && warning.path === relative)));
  await executeApply(box.libraryDir, plan, {});
  for (const relative of excludedPaths) {
    await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/cached", relative)), { code: "ENOENT" });
  }
});
