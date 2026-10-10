import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeApply, planApply } from "../src/apply.ts";
import { assertModernCatalog, importResource, loadCatalog, prepareResource, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { referenceLine } from "../src/instruction-reference.ts";
import type { ResourceCandidate } from "../src/types.ts";

interface Box { root: string; projectDir: string; libraryDir: string; sourceRoot: string }

async function sandbox(t: test.TestContext): Promise<Box> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  const sourceRoot = path.join(root, "source");
  await Promise.all([mkdir(projectDir), mkdir(sourceRoot), mkdir(path.join(root, "home"))]);
  return { root, projectDir, libraryDir: path.join(root, "home", ".copi"), sourceRoot };
}

async function addInstruction(box: Box, id: string, fileName: string, content: string, destination = fileName) {
  const dir = path.join(box.sourceRoot, id);
  await mkdir(dir, { recursive: true });
  const sourcePath = path.join(dir, fileName);
  await writeFile(sourcePath, content);
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  if (!catalog.groups.some((group) => group.id === "bundle")) catalog.groups.push({ id: "bundle", name: "Bundle", itemIds: [] });
  await saveCatalog(box.libraryDir, catalog);
  const candidate: ResourceCandidate = {
    id, kind: "instruction", source: "synthetic-test", scope: "project", sourceRoot: box.sourceRoot, sourcePath,
    name: id, destination: { kind: "project", path: destination },
  };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importResource(box.libraryDir, candidate, { confirmed: true, groupIds: ["bundle"], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
}

const warned = (plan: Awaited<ReturnType<typeof planApply>>) => plan.warnings.filter((w) => w.code === "instruction-not-loaded").map((w) => w.path);

test("proposes appending to an existing AGENTS.md when an arbitrary instruction is unreferenced", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.projectDir, "AGENTS.md"), "# Project\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(warned(plan), ["RULES.md"]);
  assert.equal(plan.referenceProposal?.path, "AGENTS.md");
  assert.equal(plan.referenceProposal?.status, "append");
  assert.deepEqual(plan.referenceProposal?.instructionPaths, ["RULES.md"]);
  assert.ok(plan.referenceProposal?.preview.kind === "text" && plan.referenceProposal.preview.diff.includes(`+${referenceLine("RULES.md")}`));
  assert.equal(await readFile(path.join(box.projectDir, "AGENTS.md"), "utf8"), "# Project\n");
});

test("proposes creating AGENTS.md when no root context file exists", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.referenceProposal?.path, "AGENTS.md");
  assert.equal(plan.referenceProposal?.status, "new");
});

test("does not warn when any root context file already mentions the path", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n", "docs/RULES.md");
  await writeFile(path.join(box.projectDir, "CLAUDE.md"), "Always read docs/RULES.md.\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(warned(plan), []);
  assert.equal(plan.referenceProposal, undefined);
});

test("ignores instructions Pi already loads", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "agents", "AGENTS.md", "# A\n");
  await addInstruction(box, "append", "APPEND_SYSTEM.md", "# B\n", ".pi/APPEND_SYSTEM.md");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(warned(plan), []);
  assert.equal(plan.referenceProposal, undefined);
});

test("targets AGENTS.override.md when it exists beside AGENTS.md", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.projectDir, "AGENTS.md"), "# A\n");
  await writeFile(path.join(box.projectDir, "AGENTS.override.md"), "# O\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.referenceProposal?.path, "AGENTS.override.md");
});

test("counts one context file once on a case-insensitive filesystem (same inode)", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.projectDir, "AGENTS.md"), "# A\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.referenceProposal?.path, "AGENTS.md");
  assert.deepEqual(warned(plan), ["RULES.md"]);
});

test("only warns with a manual line when the group also places a root context file", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await addInstruction(box, "agents", "AGENTS.md", "# Agents without reference\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.referenceProposal, undefined);
  const warning = plan.warnings.find((w) => w.code === "instruction-not-loaded" && w.path === "RULES.md");
  assert.ok(warning?.message.includes(referenceLine("RULES.md")));
});

test("treats a reference inside a planned root context file as present", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await addInstruction(box, "agents", "AGENTS.md", "Read RULES.md first.\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.deepEqual(warned(plan), []);
});

test("does not propose editing a symlinked context file", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.root, "outside.md"), "# outside\n");
  await symlink(path.join(box.root, "outside.md"), path.join(box.projectDir, "AGENTS.md"));
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  assert.equal(plan.referenceProposal, undefined);
  assert.deepEqual(warned(plan), ["RULES.md"]);
  assert.equal(await readFile(path.join(box.root, "outside.md"), "utf8"), "# outside\n");
});

test("appends the reference only after approval and backs up the previous file", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  const agents = path.join(box.projectDir, "AGENTS.md");
  await writeFile(agents, "# Project", { mode: 0o640 });
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const result = await executeApply(box.libraryDir, plan, { addReference: true });
  assert.equal(await readFile(agents, "utf8"), `# Project\n\n${referenceLine("RULES.md")}\n`);
  assert.equal((await stat(agents)).mode & 0o777, 0o640);
  assert.equal(result.referenceAdded, "AGENTS.md");
  assert.equal(await readFile(path.join(box.projectDir, "RULES.md"), "utf8"), "# Rules\n");
  const backup = result.backups.find((entry) => entry.path === "AGENTS.md");
  assert.ok(backup);
  assert.equal(await readFile(backup.backupPath, "utf8"), "# Project");
});

test("creates AGENTS.md with mode 0644 when approved and none exists", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const result = await executeApply(box.libraryDir, plan, { addReference: true });
  const agents = path.join(box.projectDir, "AGENTS.md");
  assert.equal(await readFile(agents, "utf8"), `${referenceLine("RULES.md")}\n`);
  assert.equal((await stat(agents)).mode & 0o777, 0o644);
  assert.equal(result.referenceAdded, "AGENTS.md");
});

test("leaves context files untouched when the reference is declined", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.projectDir, "AGENTS.md"), "# Project\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  const result = await executeApply(box.libraryDir, plan, { addReference: false });
  assert.equal(await readFile(path.join(box.projectDir, "AGENTS.md"), "utf8"), "# Project\n");
  assert.equal(await readFile(path.join(box.projectDir, "RULES.md"), "utf8"), "# Rules\n");
  assert.equal(result.referenceAdded, undefined);
  assert.deepEqual(result.backups, []);
});

test("rejects addReference without a proposal", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  await writeFile(path.join(box.projectDir, "AGENTS.md"), "Read RULES.md.\n");
  const plan = await planApply(box.libraryDir, "bundle", box.projectDir);
  await assert.rejects(executeApply(box.libraryDir, plan, { addReference: true }), /no reference proposal/i);
  await assert.rejects(readFile(path.join(box.projectDir, "RULES.md")), { code: "ENOENT" });
});

test("writes nothing when the context file changes or appears after planning", async (t) => {
  const box = await sandbox(t);
  await addInstruction(box, "rules", "RULES.md", "# Rules\n");
  const agents = path.join(box.projectDir, "AGENTS.md");
  await writeFile(agents, "# Project\n");
  const changed = await planApply(box.libraryDir, "bundle", box.projectDir);
  await writeFile(agents, "# Edited\n");
  await assert.rejects(executeApply(box.libraryDir, changed, { addReference: true }), /Destination changed/);
  assert.equal(await readFile(agents, "utf8"), "# Edited\n");
  await assert.rejects(readFile(path.join(box.projectDir, "RULES.md")), { code: "ENOENT" });

  await rm(agents);
  const created = await planApply(box.libraryDir, "bundle", box.projectDir);
  await writeFile(agents, "# Appeared\n");
  await assert.rejects(executeApply(box.libraryDir, created, { addReference: true }), /Destination changed/);
  assert.equal(await readFile(agents, "utf8"), "# Appeared\n");
});
