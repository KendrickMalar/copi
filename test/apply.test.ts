import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertModernCatalog, importResource, loadCatalog, prepareResource, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { executeApply, planApply } from "../src/apply.ts";
import type { Catalog, ResourceCandidate, ResourceKind } from "../src/types.ts";
import { addItem, duplicateFixture, sandbox as nameSandbox } from "./helpers/sandbox.ts";

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
  assertModernCatalog(catalog);
  if (!catalog.groups.some((group) => group.id === (options.groupId ?? "bundle"))) {
    catalog.groups.push({ id: options.groupId ?? "bundle", name: options.groupId === "second" ? "Second bundle" : "Bundle", itemIds: [] });
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
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importResource(box.libraryDir, candidate, { confirmed: true, groupIds: [options.groupId ?? "bundle"], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  return item;
}

async function installPrivateSourceFiles(box: Sandbox, catalog: Catalog, extraFiles: Record<string, string | Buffer>): Promise<void> {
  assertModernCatalog(catalog);
  if (catalog.items.length !== 1) throw new Error("Private-path fixture expects one saved item.");
  const item = catalog.items[0]!;
  if (item.content.kind !== "tree") throw new Error("Private-path fixture expects a v2 tree content location.");
  const contentRoot = path.join(box.libraryDir, ...item.content.path.split("/"));
  for (const [relative, content] of Object.entries(extraFiles)) {
    const bytes = Buffer.from(content);
    const target = path.join(contentRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
    item.files.push({ path: relative, mode: 0o600, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(box.libraryDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}

test("blocks apply for library-wide duplicates and rechecks after planning before any destination write", async (t) => {
  const box = await nameSandbox(t);
  const { second } = await duplicateFixture(box);
  await assert.rejects(planApply(box.libraryDir, "daily", box.projectDir), /duplicate|conflict/i);
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  catalog.items.find((item) => item.id === second.id)!.name = "Separate";
  catalog.groups[1]!.name = "Review";
  await writeFile(path.join(box.libraryDir, "catalog.json"), JSON.stringify(catalog));
  const plan = await planApply(box.libraryDir, "daily", box.projectDir);
  const third = await addItem(box, "Third");
  const changed = await loadCatalog(box.libraryDir);
  assertModernCatalog(changed);
  changed.items.find((item) => item.id === third.id)!.name = "STRASSE";
  await writeFile(path.join(box.libraryDir, "catalog.json"), JSON.stringify(changed));
  await assert.rejects(executeApply(box.libraryDir, plan, { secretApprovals: plan.files.map((file) => file.path) }), /duplicate|conflict/i);
  for (const file of plan.files) await assert.rejects(readFile(path.join(box.projectDir, file.path)), { code: "ENOENT" });
});

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
  const backup = result.backups[0]!;
  assert.equal(await readFile(backup.backupPath, "utf8"), "old content\n");
  const manifest = JSON.parse(await readFile(path.join(path.dirname(backup.backupPath), "manifest.json"), "utf8")) as Array<{ path: string; backupFile: string; mode: number }>;
  assert.deepEqual(manifest, [{ path: relative, backupFile: path.basename(backup.backupPath), mode: 0o640 }]);
  assert.equal((await stat(backup.backupPath)).mode & 0o777, 0o600);
  assert.equal(backup.mode, 0o640);
});

test("requires a choice for conflicting group content and applies only the selected snapshot", async (t) => {
  const box = await sandbox(t);
  const first = await addSkill(box, { name: "first", content: "from first\n", destination: ".pi/skills/shared" });
  const second = await addSkill(box, { name: "second", content: "from second\n", destination: ".pi/skills/shared", groupId: "second" });
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
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
  await rm(path.join(box.sourceRoot, "keys"), { recursive: true });
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const secretFile = plan.files.find((file) => file.path === ".pi/skills/keys/keys.json");
  assert.ok(secretFile?.preview.kind === "text");
  assert.ok(!secretFile.preview.diff.includes("sk_live_1234567890abcdef"));
  assert.ok(secretFile.preview.diff.includes("[REDACTED]"));
  await assert.rejects(executeApply(box.libraryDir, plan, {}), /approval|sensitive|secret/i);
  await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/keys/SKILL.md")), { code: "ENOENT" });

  await executeApply(box.libraryDir, plan, { secretApprovals: [".pi/skills/keys/keys.json"] });
  assert.equal(await readFile(path.join(box.projectDir, ".pi/skills/keys/SKILL.md"), "utf8"), "safe\n");
  assert.equal(await readFile(path.join(box.projectDir, ".pi/skills/keys/keys.json"), "utf8"), '{"apiKey":"sk_live_1234567890abcdef"}\n');
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
  await addSkill(box, { name: "asset", files: { "SKILL.md": "asset fixture\n", "asset.bin": Buffer.from([0, 1, 127, 128, 255]) } });
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
  assertModernCatalog(catalog);
  const excludedPaths = [".cache/private.txt", "nested/.npm/private.txt"];
  await installPrivateSourceFiles(box, catalog, Object.fromEntries(excludedPaths.map((relative) => [relative, "private cache content\n"])));
  const readable = await readSnapshotFiles(box.libraryDir, item);
  assert.deepEqual(readable.map((file) => file.path), ["SKILL.md"]);

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(plan.files.map((file) => file.path), [".pi/skills/cached/SKILL.md"]);
  await executeApply(box.libraryDir, plan, {});
  for (const relative of excludedPaths) {
    await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/cached", relative)), { code: "ENOENT" });
  }
});

test("skips dot-env, authentication, history, and cache files while preserving environment helper code", async (t) => {
  const box = await sandbox(t);
  const supportedFiles = {
    "SKILL.md": "portable instructions",
    "README.md": "keep this support file",
    "env_helper.py": "print('environment helper')",
    "envrc": "ordinary support file",
    "env-production": "ordinary environment documentation",
  };
  const item = await addSkill(box, { name: "env-boundary", files: supportedFiles });
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  const excludedPaths = [
    ".envrc",
    ".env-production",
    "nested/.env.local",
    "auth/token.json",
    "auth.json",
    "mcp-auth.json",
    "oauth.json",
    "history/session.jsonl",
    ".cache/private.txt",
    ".npm/cache.json",
  ];
  await installPrivateSourceFiles(box, catalog, Object.fromEntries(excludedPaths.map((relative) => [relative, `synthetic private data for ${relative}`])));
  const readable = await readSnapshotFiles(box.libraryDir, item);
  assert.deepEqual(new Set(readable.map((file) => file.path)), new Set(Object.keys(supportedFiles)));

  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(new Set(plan.files.map((file) => file.path)), new Set([
    ".pi/skills/env-boundary/SKILL.md",
    ".pi/skills/env-boundary/README.md",
    ".pi/skills/env-boundary/env_helper.py",
    ".pi/skills/env-boundary/envrc",
    ".pi/skills/env-boundary/env-production",
  ]));
  await executeApply(box.libraryDir, plan, {});
  for (const [relative, content] of Object.entries(supportedFiles)) {
    assert.equal(await readFile(path.join(box.projectDir, ".pi/skills/env-boundary", relative), "utf8"), content);
  }
  for (const relative of excludedPaths) {
    await assert.rejects(readFile(path.join(box.projectDir, ".pi/skills/env-boundary", relative)), { code: "ENOENT" });
  }
});

test("warns when Pi settings contain relative resource references without rewriting their saved bytes", async (t) => {
  const box = await sandbox(t);
  const content = '{"skills":["skills/review"],"subagents":{"agentScanDirs":["../agents"]},"packages":[{"source":"./local-package"}],"defaultProjectTrust":"trusted"}';
  await addSkill(box, { name: "relative-settings", kind: "pi-settings", destination: ".pi/settings.json", files: { "settings.json": content } });
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.ok(plan.warnings.some((warning) => warning.code === "relative-resource-reference" && warning.path === ".pi/settings.json"));
  assert.ok(plan.warnings.some((warning) => warning.code === "project-setting-restricted"));

  await executeApply(box.libraryDir, plan, {});
  assert.equal(await readFile(path.join(box.projectDir, ".pi/settings.json"), "utf8"), content);
});
