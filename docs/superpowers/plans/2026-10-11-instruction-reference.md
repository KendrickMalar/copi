# instruction 参照導線（Issue #7）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `copi apply` が、Pi に自動で読まれない任意名 instruction を検出して警告し、明示承認があればルートの context file に参照行を追記する。

**Architecture:** 判定・文面・追記内容は純関数として `src/instruction-reference.ts` に置く。`planApply` がルート context file を読み、`ApplyPlan.referenceProposal` と警告を作る。追記は内部計画に通常の書込み候補として保持し、`executeApply` が `decisions.addReference === true` のときだけ既存の backup・変更検出つき書込み経路で書く。ウィザードは既定 no の確認を 1 つ追加する。

**Tech Stack:** TypeScript（strict, ESM, `.ts` import）、Node 22 `node:test`、`@clack/prompts`、`diff`。

**Spec:** `docs/superpowers/specs/2026-10-11-instruction-reference-design.md`

## Global Constraints

- context file 名と優先順: `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`。
- 自動読込とみなす配置先: basename が上記のどれか、または `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`。
- 参照行（1 instruction 1 行）: `` - 作業を始める前に `<path>` を読み、その指示に従うこと。 ``
- 判定範囲はプロジェクトルートのみ。参照ありは「context file の UTF-8 内容が相対パス文字列を含む」。
- 既存ファイルを承認なしで変更しない。確認の既定は no。no でも apply は続行する。
- 新規作成の mode は `0o644`。既存追記は mode を維持し、非公開 backup を取る。
- 1 MB 超・非 UTF-8・symlink・通常ファイル以外の追記先は提案しない（警告のみ）。
- テスト実行は TMPDIR に symlink を含まない実パスを使う（`/tmp` 不可）。例: `export TMPDIR=$(realpath "$SCRATCH")`。ビルドは `npm run build`、単体は `node --test dist/test/<name>.test.js`。

## Review Focus

1. macOS の大文字小文字を区別しない FS では `AGENTS.md` と `AGENTS.MD` が同じファイルになる → 同一 inode を二重に数えず、追記先は 1 つ（Task 2 のテスト「same inode」）。
2. 計画後に追記先が作られた・変わった → 何も書かず `Destination changed` で失敗（Task 3）。
3. group が同時にルートの `AGENTS.md` を配置する → 提案なし、手動手順つき警告（Task 2）。
4. 末尾改行なしの既存ファイル → 改行を補ってから空行と参照行（Task 1）。
5. 承認しない／提案なしで `addReference: true` → 前者は追記なしで他を適用、後者は拒否（Task 3）。

---

### Task 1: 純関数モジュール

**Files:**
- Create: `src/instruction-reference.ts`
- Test: `test/instruction-reference.test.ts`

**Interfaces:**
- Produces:
  - `export const contextFileNames: readonly string[]`
  - `export function isAutoLoadedInstruction(destination: string): boolean`
  - `export function referenceLine(instructionPath: string): string`
  - `export function unreferencedPaths(instructionPaths: readonly string[], contextTexts: readonly string[]): string[]`
  - `export function chooseReferenceTarget(existingNames: readonly string[]): string`
  - `export function appendReferenceLines(existing: string | undefined, instructionPaths: readonly string[]): string`

- [ ] **Step 1: Write the failing test** — `test/instruction-reference.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { appendReferenceLines, chooseReferenceTarget, isAutoLoadedInstruction, referenceLine, unreferencedPaths } from "../src/instruction-reference.ts";

test("treats Pi context files and project system prompts as auto-loaded", () => {
  for (const value of ["AGENTS.md", "AGENTS.MD", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD", "docs/AGENTS.md", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"]) {
    assert.equal(isAutoLoadedInstruction(value), true, value);
  }
  for (const value of ["RULES.md", "docs/RULES.md", "SYSTEM.md", "agents.md", ".pi/rules/SYSTEM.txt"]) {
    assert.equal(isAutoLoadedInstruction(value), false, value);
  }
});

test("renders one Japanese reference line per instruction", () => {
  assert.equal(referenceLine("RULES.md"), "- 作業を始める前に `RULES.md` を読み、その指示に従うこと。");
});

test("reports paths no context text mentions, keeping first-seen order without duplicates", () => {
  assert.deepEqual(unreferencedPaths(["RULES.md", "docs/B.md", "RULES.md"], ["see docs/B.md"]), ["RULES.md"]);
  assert.deepEqual(unreferencedPaths(["RULES.md"], []), ["RULES.md"]);
  assert.deepEqual(unreferencedPaths(["RULES.md"], ["Read RULES.md first."]), []);
});

test("chooses the existing context file Pi prefers, else AGENTS.md", () => {
  assert.equal(chooseReferenceTarget(["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"]), "AGENTS.override.md");
  assert.equal(chooseReferenceTarget(["CLAUDE.MD", "CLAUDE.md"]), "CLAUDE.md");
  assert.equal(chooseReferenceTarget([]), "AGENTS.md");
});

test("appends after a blank line and repairs a missing final newline", () => {
  const line = referenceLine("RULES.md");
  assert.equal(appendReferenceLines(undefined, ["RULES.md"]), `${line}\n`);
  assert.equal(appendReferenceLines("", ["RULES.md"]), `${line}\n`);
  assert.equal(appendReferenceLines("# Project\n", ["RULES.md"]), `# Project\n\n${line}\n`);
  assert.equal(appendReferenceLines("# Project", ["RULES.md", "docs/B.md"]), `# Project\n\n${line}\n${referenceLine("docs/B.md")}\n`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL（`Cannot find module '../src/instruction-reference.ts'` の型エラー）

- [ ] **Step 3: Write minimal implementation** — `src/instruction-reference.ts`

```ts
import path from "node:path";

export const contextFileNames: readonly string[] = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const systemPromptPaths = new Set([".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"]);

export function isAutoLoadedInstruction(destination: string): boolean {
  return contextFileNames.includes(path.posix.basename(destination)) || systemPromptPaths.has(destination);
}

export function referenceLine(instructionPath: string): string {
  return `- 作業を始める前に \`${instructionPath}\` を読み、その指示に従うこと。`;
}

export function unreferencedPaths(instructionPaths: readonly string[], contextTexts: readonly string[]): string[] {
  return [...new Set(instructionPaths)].filter((value) => !contextTexts.some((text) => text.includes(value)));
}

export function chooseReferenceTarget(existingNames: readonly string[]): string {
  return contextFileNames.find((name) => existingNames.includes(name)) ?? "AGENTS.md";
}

export function appendReferenceLines(existing: string | undefined, instructionPaths: readonly string[]): string {
  const lines = `${instructionPaths.map(referenceLine).join("\n")}\n`;
  if (!existing) return lines;
  return `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${lines}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/test/instruction-reference.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add src/instruction-reference.ts test/instruction-reference.test.ts
git commit -m "feat(apply): add instruction reference helpers (#7)"
```

---

### Task 2: `planApply` で判定・警告・提案を作る

**Files:**
- Modify: `src/apply.ts`（`ApplyPlan`・`InternalPlan` 型、`planApplyLocked`、新関数 `readRootContextFiles`・`planInstructionReference`）
- Test: `test/instruction-reference-apply.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の全関数。
- Produces:
  - `export interface ApplyReferenceProposal { path: string; status: "new" | "append"; instructionPaths: string[]; preview: ApplyPreview }`
  - `ApplyPlan.referenceProposal?: ApplyReferenceProposal`
  - `InternalPlan.reference?: { path: string; candidate: SnapshotCandidate }`（追記前の状態は `InternalPlan.existing` に同じ path で入れる）
  - 警告 code `instruction-not-loaded`（path = instruction の相対パス）

- [ ] **Step 1: Write the failing tests** — `test/instruction-reference-apply.test.ts`

```ts
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
```

（`executeApply`・`stat` は Task 3 で使う。未使用 import が型エラーになる場合は Task 3 まで外しておく。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build`
Expected: FAIL（`referenceProposal` が `ApplyPlan` に無い型エラー）

- [ ] **Step 3: Implement in `src/apply.ts`**

import を追加:

```ts
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { appendReferenceLines, chooseReferenceTarget, contextFileNames, isAutoLoadedInstruction, referenceLine, unreferencedPaths } from "./instruction-reference.ts";
```

型を追加・変更:

```ts
export interface ApplyReferenceProposal {
  path: string;
  status: "new" | "append";
  instructionPaths: string[];
  preview: ApplyPreview;
}

export interface ApplyPlan {
  projectDir: string;
  files: ApplyFilePlan[];
  collisions: ApplyCollision[];
  warnings: InspectionWarning[];
  skippedItems: string[];
  referenceProposal?: ApplyReferenceProposal;
}

interface InternalPlan {
  // 既存フィールドはそのまま
  reference?: { path: string; candidate: SnapshotCandidate };
}
```

`targetPath` の下に追加:

```ts
async function readRootContextFiles(root: string): Promise<Map<string, DestinationFile | "unusable">> {
  const files = new Map<string, DestinationFile | "unusable">();
  const seen = new Set<number>();
  for (const name of contextFileNames) {
    const target = path.join(root, name);
    const stat = await maybeLstat(target);
    if (!stat || seen.has(stat.ino)) continue;
    seen.add(stat.ino);
    if (!stat.isFile()) {
      files.set(name, "unusable");
      continue;
    }
    const bytes = await readFile(target);
    files.set(name, textFrom(bytes) === undefined ? "unusable" : { bytes, mode: stat.mode & 0o777, sha256: sha256(bytes) });
  }
  return files;
}

async function planInstructionReference(
  root: string,
  instructionPaths: readonly string[],
  candidates: Map<string, SnapshotCandidate[]>,
  warnings: InspectionWarning[],
): Promise<{ proposal: ApplyReferenceProposal; path: string; candidate: SnapshotCandidate; before: DestinationFile | undefined } | undefined> {
  const targets = instructionPaths.filter((value) => !isAutoLoadedInstruction(value));
  if (targets.length === 0) return undefined;
  const current = await readRootContextFiles(root);
  const planned = contextFileNames.filter((name) => candidates.has(name));
  const texts: string[] = [];
  for (const name of contextFileNames) {
    const options = candidates.get(name);
    if (options) {
      for (const option of options) {
        const text = textFrom(option.bytes);
        if (text !== undefined) texts.push(text);
      }
      continue;
    }
    const file = current.get(name);
    if (file && file !== "unusable") texts.push(textFrom(file.bytes)!);
  }
  const missing = unreferencedPaths(targets, texts);
  if (missing.length === 0) return undefined;
  const targetName = chooseReferenceTarget([...current.keys(), ...planned]);
  const existing = current.get(targetName);
  const manual = planned.length > 0 || existing === "unusable";
  for (const value of missing) {
    const how = manual
      ? `Add this line to ${targetName} yourself: ${referenceLine(value)}`
      : `Approve the optional reference line for ${targetName} during apply, or add it yourself: ${referenceLine(value)}`;
    addWarning(warnings, "instruction-not-loaded", `Pi does not load this instruction automatically and no root context file mentions it. ${how}`, value);
  }
  if (manual) return undefined;
  const before = existing === undefined || existing === "unusable" ? undefined : existing;
  const bytes = Buffer.from(appendReferenceLines(before ? textFrom(before.bytes) : undefined, missing), "utf8");
  const candidate: SnapshotCandidate = { itemId: "copi-reference", bytes, mode: before?.mode ?? 0o644, sha256: sha256(bytes), sensitive: false, preview: { kind: "binary", summary: "" } };
  candidate.preview = previewFor(targetName, candidate, before);
  return {
    proposal: { path: targetName, status: before ? "append" : "new", instructionPaths: missing, preview: candidate.preview },
    path: targetName,
    candidate,
    before,
  };
}
```

`planApplyLocked` の変更:

```ts
  const instructionPaths: string[] = [];
  // for (const snapshot of snapshotFiles) ループ内、relativePath 算出・安全確認の直後に:
      if (item.kind === "instruction") instructionPaths.push(relativePath);
```

`files` 構築ループの後、`const plan: ApplyPlan = ...` を置き換え:

```ts
  const reference = await planInstructionReference(project.canonical, instructionPaths, candidates, warnings);
  if (reference) existing.set(reference.path, reference.before);
  const plan: ApplyPlan = reference
    ? { projectDir: project.canonical, files, collisions, warnings, skippedItems, referenceProposal: reference.proposal }
    : { projectDir: project.canonical, files, collisions, warnings, skippedItems };
```

`planState.set(plan, { ... })` に追加（`existing` はこの時点で参照前状態を含む）:

```ts
    ...(reference ? { reference: { path: reference.path, candidate: reference.candidate } } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/instruction-reference-apply.test.js dist/test/apply.test.js dist/test/sources-apply.test.js`
Expected: PASS（新規 9 件、既存 apply 系も全件）

- [ ] **Step 5: Commit**

```bash
git add src/apply.ts test/instruction-reference-apply.test.ts
git commit -m "feat(apply): warn and propose a reference for unloaded instructions (#7)"
```

---

### Task 3: `executeApply` で承認時のみ追記する

**Files:**
- Modify: `src/apply.ts`（`ApplyDecisions`、`ApplyResult`、`executeApplyLocked`）
- Test: `test/instruction-reference-apply.test.ts`（追記）

**Interfaces:**
- Consumes: Task 2 の `InternalPlan.reference`、`InternalPlan.existing`。
- Produces: `ApplyDecisions.addReference?: boolean`、`ApplyResult.referenceAdded?: string`。

- [ ] **Step 1: Write the failing tests**（同ファイル末尾に追加）

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build`
Expected: FAIL（`addReference` が `ApplyDecisions` に無い型エラー）

- [ ] **Step 3: Implement**

型:

```ts
export interface ApplyDecisions {
  collisions?: Record<string, string>;
  existing?: Record<string, "keep" | "replace" | "abort">;
  secretApprovals?: string[];
  addReference?: boolean;
}

export interface ApplyResult {
  written: string[];
  kept: string[];
  skippedItems: string[];
  backups: ApplyBackup[];
  cancelled: boolean;
  referenceAdded?: string;
}
```

`executeApplyLocked` で、`for (const [relativePath, options] of internal.candidates)` ループの直後、`if (cancelled) ...` の前に:

```ts
  if (decisions.addReference === true) {
    if (!internal.reference) throw new Error("The apply plan has no reference proposal to add.");
    const before = internal.existing.get(internal.reference.path);
    operations.push(before
      ? { path: internal.reference.path, candidate: internal.reference.candidate, before }
      : { path: internal.reference.path, candidate: internal.reference.candidate });
  }
```

最後の `return` を置き換え:

```ts
  const referenceAdded = internal.reference && written.includes(internal.reference.path) ? internal.reference.path : undefined;
  return referenceAdded
    ? { written, kept, skippedItems: [...internal.skippedItems], backups, cancelled: false, referenceAdded }
    : { written, kept, skippedItems: [...internal.skippedItems], backups, cancelled: false };
```

既存の 2 回の変更検出（書込み前・書込み直前）は `internal.existing` を見るので、追記先にもそのまま効く。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/instruction-reference-apply.test.js dist/test/apply.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/apply.ts test/instruction-reference-apply.test.ts
git commit -m "feat(apply): add the approved instruction reference with backup (#7)"
```

---

### Task 4: dry-run・ウィザード表示、help、README

**Files:**
- Modify: `src/wizard.ts:581-593`（`formatPlan`）、`src/wizard.ts:605-706`（`runApplyWizard`）
- Modify: `src/cli.ts`（help 本文、apply 説明の近く）
- Modify: `README.md`（Commands 節の apply 説明の後）
- Test: `test/cli.test.ts`（追記）

**Interfaces:**
- Consumes: `ApplyPlan.referenceProposal`、`ApplyDecisions.addReference`、`ApplyResult.referenceAdded`。

- [ ] **Step 1: Write the failing test**（`test/cli.test.ts` 末尾）

```ts
test("apply --dry-run explains an unloaded instruction and the optional reference without writing", async (t) => {
  const box = await sandbox(t);
  const sourceRoot = path.join(box.root, "synthetic-source");
  await mkdir(sourceRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "RULES.md");
  await writeFile(sourcePath, "# Rules\n");
  const catalog = newCatalog();
  catalog.groups.push({ id: "bundle", name: "Bundle", itemIds: [] });
  await saveCatalog(box.library, catalog);
  const candidate: ResourceCandidate = {
    id: "rules", kind: "instruction", source: "synthetic-test", scope: "project", sourceRoot, sourcePath,
    name: "RULES.md", destination: { kind: "project", path: "RULES.md" },
  };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  await importResource(box.library, candidate, { confirmed: true, groupIds: ["bundle"], inspection, approvedSensitivePaths: [] });
  await writeFile(path.join(box.project, "AGENTS.md"), "# Project\n");

  const result = runCli(box, ["apply", "bundle", box.project, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warning RULES\.md: Pi does not load this instruction automatically/);
  assert.match(result.stdout, /reference \(optional, approval required during apply\): append: AGENTS\.md/);
  assert.ok(result.stdout.includes("+- 作業を始める前に `RULES.md` を読み、その指示に従うこと。"));
  assert.equal(await readFile(path.join(box.project, "AGENTS.md"), "utf8"), "# Project\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/cli.test.js`
Expected: FAIL（`reference (optional ...` が出力に無い）

- [ ] **Step 3: Implement**

`formatPlan`（`src/wizard.ts`）の `warnings` の前に追加し、return を変更:

```ts
  const proposal = plan.referenceProposal;
  const reference = proposal
    ? [`reference (optional, approval required during apply): ${proposal.status}: ${proposal.path}${proposal.preview.kind === "text" ? `\n${proposal.preview.diff}` : `\n${proposal.preview.summary}`}`]
    : [];
  // ...
  return [...lines, ...reference, ...warnings, ...skipped].join("\n\n") || "No project files need changes.";
```

`runApplyWizard` の `decisions.secretApprovals = [...selectedSecrets];` の後、最終確認の前:

```ts
  if (plan.referenceProposal) {
    const proposal = plan.referenceProposal;
    const addReference = await confirm({
      message: `${proposal.status === "new" ? "Create" : "Append to"} ${proposal.path} with a reference line for ${proposal.instructionPaths.join(", ")}? Pi does not load these files automatically.`,
      initialValue: false,
    });
    if (isCancel(addReference)) {
      cancel("Apply cancelled; project files were not changed.");
      return;
    }
    decisions.addReference = addReference;
  }
```

完了表示:

```ts
  const referenceNote = result.referenceAdded ? ` Added a reference line to ${result.referenceAdded}.` : "";
  outro(`Applied ${result.written.length} file(s); kept ${result.kept.length}; saved ${result.backups.length} private backup(s).${referenceNote}`);
```

`src/cli.ts` の help 本文（`Refresh can reselect ...` 段落の前）に段落を追加:

```text
Pi loads only root context files (AGENTS.override.md, AGENTS.md, AGENTS.MD,
CLAUDE.md, CLAUDE.MD) and .pi/SYSTEM.md or .pi/APPEND_SYSTEM.md automatically.
apply warns when another instruction is not mentioned by a root context file and
can add one reference line after a separate default-no approval; --dry-run shows
the same warning and diff without writing.
```

`README.md` の Commands 節、`groups` / `list` / `apply --dry-run` の段落の直後に追加:

```markdown
Pi automatically loads only context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`) and `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md`. When a group applies another instruction (for example `RULES.md`) and no context file at the project root mentions its path, `apply` warns. If a usable root context file exists, it offers to append one reference line per instruction (`- 作業を始める前に \`RULES.md\` を読み、その指示に従うこと。`) to the file Pi prefers (`AGENTS.override.md` first); otherwise it offers to create `AGENTS.md`. The offer is a separate default-no approval; declining still applies the other files. An existing file is backed up privately before the append. `--dry-run` prints the same warning and diff. No reference is offered when the same group also places a root context file, or when that file is a symbolic link, not a regular file, not UTF-8, or larger than 1 MB; the warning then shows the line to add yourself. Only the project root is checked; parent directories and the Pi agent directory are not.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/cli.test.js dist/test/wizard.test.js`
Expected: PASS

- [ ] **Step 5: Full check と Commit**

Run（承認済み sandbox・Node22。手順はメモリの Copi full check に従う）: `npm run check`
Expected: 全件 PASS（既存 1439 件＋新規）

```bash
git add src/wizard.ts src/cli.ts README.md test/cli.test.ts
git commit -m "feat(apply): show and confirm the instruction reference in dry-run and apply (#7)"
```
