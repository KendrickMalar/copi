import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { LegacyCatalog, LegacySavedItem } from "../src/types.ts";
import { box as guardedBox } from "./helpers/issue3-acceptance.ts";
import { cli, environment, hash, plain, pty, runCli, sourceNodeFlags, type Step } from "./helpers/issue6-acceptance.ts";
import { writeBytes } from "./helpers/legacy-library.ts";

// Built at run time so repository secret scanners do not flag this synthetic key.
const syntheticStripePrefix = ["sk", "live", ""].join("_");
const sourceRelative = "sources/日本語/旅程技能";
const groupId = "51013c26-3c16-4e80-aea4-60f77a402911";
const secretFiles = ["credential.txt", "日本語/秘密.md"] as const;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const wholePrompt = "この masked diff をすべて確認し";
const finalPrompt = "移行を実行しますか";
const sensitivePrompt = (file: string): string => `秘密情報候補 [internal reference]/${file}`;

type Box = Awaited<ReturnType<typeof guardedBox>>;
type TreeEntry = { kind: "directory" | "file" | "symlink" | "other"; mode: number; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; sha256?: string; hex?: string; link?: string };
type TreeSnapshot = { exists: boolean; entries: Record<string, TreeEntry> };

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const entries: Record<string, TreeEntry> = {};
  async function visit(absolute: string, relative: string): Promise<void> {
    const stat = await lstat(absolute, { bigint: true });
    const value: TreeEntry = {
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      mode: Number(stat.mode & 0o7777n), dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isSymbolicLink()) value.link = await (await import("node:fs/promises")).readlink(absolute);
    else if (stat.isFile()) {
      const bytes = await readFile(absolute);
      value.sha256 = digest(bytes);
      value.hex = bytes.toString("hex");
    }
    entries[relative || "."] = value;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    }
  }
  try { await visit(root, ""); return { exists: true, entries }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, entries };
    throw error;
  }
}

function withoutLibraryRootTimes(snapshot: TreeSnapshot): TreeSnapshot {
  const entries = Object.fromEntries(Object.entries(snapshot.entries).map(([relative, entry]) => [
    relative, relative === "." ? { ...entry, mtimeNs: "<read-lock-churn>", ctimeNs: "<read-lock-churn>" } : entry,
  ]));
  return { ...snapshot, entries };
}

// Set COPI_TEST_TRACE=1 to print each recorded case for diagnosis.
function traceRecord(label: string, value: unknown): void {
  if (process.env.COPI_TEST_TRACE) console.log(`R4-F-CLI ${label} ${JSON.stringify(value)}`);
}

interface Fixture {
  box: Box;
  id: string;
  sourcePath: string;
  sourceFiles: Record<string, Buffer>;
  legacyFiles: Record<string, Buffer>;
  item: LegacySavedItem;
  legacyCatalog: LegacyCatalog;
  originalCatalogBytes: Buffer;
}

async function createFixture(options: { itemsOnly?: boolean } = {}): Promise<Fixture> {
  const box = await guardedBox();
  const id = randomUUID();
  const sourcePath = path.join(box.library, ...sourceRelative.split("/"));
  const sourceFiles: Record<string, Buffer> = options.itemsOnly ? {
    "旅程.md": Buffer.from("移行対象の日本語本文\n"),
  } : {
    "SKILL.md": Buffer.from("# 旅程技能\n日本語の本文です。\n移行後も原文を保持します。\n"),
    "credential.txt": Buffer.from(`apiKey = ${syntheticStripePrefix}R4CliCredential123456\n`),
    "日本語/秘密.md": Buffer.from("password = R4CliJapanesePassword987654\n日本語の秘密本文\n"),
  };
  const legacyFiles: Record<string, Buffer> = options.itemsOnly ? {
    "旅程.md": Buffer.from("登録済み items-only 日本語本文\n"),
  } : {
    "SKILL.md": Buffer.from("# 古い旅程技能\n以前の日本語本文です。\n"),
    "credential.txt": Buffer.from(`apiKey = ${syntheticStripePrefix}R4CliPreviousCredential123456\n`),
    "日本語/秘密.md": Buffer.from("password = R4CliPreviousJapanesePassword987654\n"),
  };
  const modes: Record<string, number> = { "SKILL.md": 0o640, "credential.txt": 0o600, "日本語/秘密.md": 0o644, "旅程.md": 0o640 };
  let itemSourcePath: string;
  let itemKind: LegacySavedItem["kind"];
  if (options.itemsOnly) {
    itemSourcePath = path.join(box.library, "sources", id, "旅程.md");
    itemKind = "instruction";
  } else {
    itemSourcePath = sourcePath;
    itemKind = "skill";
    for (const [relative, bytes] of Object.entries(sourceFiles)) {
      await writeBytes(box.library, `${sourceRelative}/${relative}`, bytes, modes[relative] ?? 0o644);
    }
    await writeBytes(box.library, "sources/隣接/keep-日本語.txt", Buffer.from("未登録の隣接 source を保持\n"), 0o644);
  }
  for (const [relative, bytes] of Object.entries(legacyFiles)) {
    await writeBytes(box.library, `items/${id}/files/${relative}`, bytes, modes[relative] ?? 0o644);
  }
  const item = {
    id, kind: itemKind, source: "synthetic-unavailable-origin", scope: "project" as const,
    sourcePath: itemSourcePath, destination: { kind: "project" as const, path: ".pi/skills/旅程" },
    name: options.itemsOnly ? "items-only 日本語 fixture" : "日本語 旅程技能",
    savedAt: "2026-10-08T12:34:56.000Z",
    files: Object.entries(legacyFiles).map(([filePath, bytes]) => ({ path: filePath, mode: modes[filePath] ?? 0o644, sha256: digest(bytes) })),
  } satisfies LegacySavedItem;
  const legacyCatalog: LegacyCatalog = {
    version: 1,
    items: [item],
    groups: [{ id: groupId, name: "旅程グループ 日本語", itemIds: [id] }],
  };
  const originalCatalogBytes = Buffer.from(`${JSON.stringify(legacyCatalog, null, 2)}\n`);
  await writeBytes(box.library, "catalog.json", originalCatalogBytes, 0o600);
  await chmod(path.join(box.library, "catalog.json"), 0o600);
  return { box, id, sourcePath: itemSourcePath, sourceFiles, legacyFiles, item, legacyCatalog, originalCatalogBytes };
}

function argv(...args: string[]): string[] {
  return [process.execPath, ...sourceNodeFlags, cli, ...args];
}

function approvalSteps(fixture: Fixture): Step[] {
  return [
    { wait: wholePrompt, text: "y\r", checkpoint: true },
    ...secretFiles.map((file): Step => ({ wait: sensitivePrompt(file), text: "y\r", checkpoint: true })),
    { wait: finalPrompt, text: "y\r", checkpoint: true },
  ];
}

function cancellationSteps(fixture: Fixture, stage: string, cancel: "default-no" | "EOF" | "Ctrl-C"): Step[] {
  const selected = cancel === "default-no" ? { text: "\r" } : cancel === "EOF" ? { hex: "04" } : { hex: "03" };
  const prompts: Step[] = [{ wait: wholePrompt, text: "y\r", checkpoint: true }];
  for (const file of secretFiles) prompts.push({ wait: sensitivePrompt(file), text: "y\r", checkpoint: true });
  prompts.push({ wait: finalPrompt, text: "y\r", checkpoint: true });
  const promptIndex = stage === "whole" ? 0 : stage === "secret-1" ? 1 : stage === "secret-2" ? 2 : 3;
  const prompt = prompts[promptIndex]!;
  if (!prompt.wait) throw new Error(`No prompt defined for cancellation stage: ${stage}`);
  prompts.splice(promptIndex, prompts.length - promptIndex, { wait: prompt.wait, checkpoint: true, ...selected });
  return prompts;
}

function assertAllWritesExactlySent(run: Awaited<ReturnType<typeof pty>>): void {
  for (const action of run.timeline) assert.equal(action.written, Buffer.from(action.sentHex, "hex").length, `PTY action ${action.action} was not fully delivered`);
}

async function runTty(box: Box, args: string[], steps: Step[]) {
  return pty(box, argv(...args), steps, "tty", [45, 180]);
}

async function backupEvidence(fixture: Fixture, backupDir: string, originalTree: TreeSnapshot) {
  const library = fixture.box.library;
  const backupRoot = path.join(library, ...backupDir.split("/"));
  const manifestPath = path.join(backupRoot, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { version: number; entries: Array<{ originalPath: string; backupPath: string; sha256: string; mode: number }> };
  const manifestStat = await lstat(manifestPath);
  const backupStat = await lstat(backupRoot);
  const backupParentStat = await lstat(path.join(library, ".migration-backups"));
  const filesRootStat = await lstat(path.join(backupRoot, "files"));
  const verified: Array<{ originalPath: string; backupPath: string; expectedHash: string; actualHash: string; originalMode: number; manifestMode: number; backupMode: number; bytes: number }> = [];
  for (const entry of manifest.entries) {
    const original = originalTree.entries[entry.originalPath];
    assert.ok(original && original.kind === "file" && original.hex !== undefined && original.sha256 !== undefined,
      `original input must be present in the pre-migration inventory: ${entry.originalPath}`);
    const backupPath = path.join(backupRoot, ...entry.backupPath.split("/"));
    const backupBytes = await readFile(backupPath);
    const backupFileStat = await lstat(backupPath);
    assert.equal(entry.sha256, original.sha256, `${entry.originalPath} original manifest hash`);
    assert.equal(digest(backupBytes), entry.sha256, `${entry.originalPath} backup content hash`);
    assert.equal(backupBytes.toString("hex"), original.hex, `${entry.originalPath} backup exact original bytes`);
    assert.equal(entry.mode, original.mode & 0o777);
    assert.equal(backupFileStat.mode & 0o777, 0o600);
    verified.push({ originalPath: entry.originalPath, backupPath: entry.backupPath, expectedHash: entry.sha256,
      actualHash: digest(backupBytes), originalMode: original.mode & 0o777, manifestMode: entry.mode,
      backupMode: backupFileStat.mode & 0o777, bytes: backupBytes.length });
  }
  assert.equal(manifest.version, 1);
  const expectedInputPaths = Object.entries(originalTree.entries).filter(([, entry]) => entry.kind === "file").map(([relative]) => relative).sort();
  assert.deepEqual(manifest.entries.map((entry) => entry.originalPath), expectedInputPaths, "manifest covers every original catalog/items/sources file exactly once");
  assert.equal(manifestStat.mode & 0o777, 0o600);
  assert.equal(backupStat.mode & 0o777, 0o700);
  assert.equal(backupParentStat.mode & 0o777, 0o700);
  assert.equal(filesRootStat.mode & 0o777, 0o700);
  assert.ok(manifest.entries.some((entry) => entry.originalPath === "catalog.json"));
  return {
    backupDir, manifestPath, manifestSha256: digest(manifestBytes), manifestBytesHex: manifestBytes.toString("hex"),
    manifestMode: manifestStat.mode & 0o777, backupDirectoryMode: backupStat.mode & 0o777,
    backupParentMode: backupParentStat.mode & 0o777, filesDirectoryMode: filesRootStat.mode & 0o777,
    entries: verified,
  };
}

test("R4-CLI real PTY adopts v1 to v2 with Japanese paths, individually confirmed secrets, full backup custody and a usable next operation", async () => {
  const fixture = await createFixture();
  const { box, id } = fixture;
  const beforeLibrary = await snapshotTree(box.library);
  const beforeHome = await snapshotTree(box.home);
  const beforeSources = await snapshotTree(path.join(box.library, "sources"));
  const beforeItems = await snapshotTree(path.join(box.library, "items"));
  const sourceInodesBefore = Object.fromEntries(Object.keys(fixture.sourceFiles).map((relative) => {
    const filePath = path.join(fixture.sourcePath, relative);
    return [relative, filePath];
  }));
  const sourceStatsBefore = Object.fromEntries(await Promise.all(Object.entries(sourceInodesBefore).map(async ([relative, filePath]) => {
    const stat = await lstat(filePath, { bigint: true });
    return [relative, { dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o777n), bytes: (await readFile(filePath)).toString("hex") }];
  })));
  const steps = approvalSteps(fixture);
  const run = await runTty(box, ["migrate"], steps);
  const afterLibrary = await snapshotTree(box.library);
  const afterHome = await snapshotTree(box.home);
  traceRecord("adopt-success", {
    requirement: "v1-to-v2 real PTY adopt-only success; Japanese path/body; all approvals; backup custody; cleanup; next operation",
    cwd: box.cwd, home: box.home, library: box.library, command: argv("migrate"), exitCode: run.code,
    timeout: run.timeout, reachedAllPrompts: run.actions === steps.length, steps,
    sentHex: run.timeline.map((entry) => entry.sentHex), timeline: run.timeline,
    terminal: { before: run.before, after: run.after, exact: run.exact, checkpoints: run.checkpoints },
    ptyOutput: { sha256: hash(run.raw), text: run.output, tmpPath: run.log, statePath: run.statePath },
    libraryBefore: beforeLibrary, libraryAfter: afterLibrary, homeBefore: beforeHome, homeAfter: afterHome,
    sourceStatsBefore, sourceTreeBefore: beforeSources, itemsTreeBefore: beforeItems,
  });
  assert.equal(run.timeout, false, run.output);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.actions, steps.length, `not every whole/secret/final prompt was reached: ${run.output}`);
  assert.equal(run.exact, true, JSON.stringify({ before: run.before, after: run.after }));
  assertAllWritesExactlySent(run);
  const screen = plain(run.output);
  assert.match(screen, /Legacy migration: ready/);
  assert.match(screen, /日本語 旅程技能/);
  assert.match(screen, /sources\/日本語\/旅程技能/);
  assert.match(screen, /日本語の本文です/);
  assert.match(screen, /\[internal reference\]\/credential\.txt/);
  assert.match(screen, /\[internal reference\]\/日本語\/秘密\.md/);
  assert.equal(screen.includes("R4CliCredential123456"), false, "masked review must not expose synthetic credential contents");
  assert.equal(screen.includes("R4CliJapanesePassword987654"), false, "masked review must not expose synthetic password contents");
  assert.match(screen, /移行が完了しました/);

  const catalogBytes = await readFile(path.join(box.library, "catalog.json"));
  const catalog = JSON.parse(catalogBytes.toString("utf8")) as { version: number; items: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>> };
  assert.equal(catalog.version, 2);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0]?.id, id);
  assert.equal(catalog.items[0]?.name, fixture.item.name);
  assert.equal(catalog.items[0]?.kind, fixture.item.kind);
  assert.equal(catalog.items[0]?.source, fixture.item.source);
  assert.equal(catalog.items[0]?.scope, fixture.item.scope);
  assert.equal(catalog.items[0]?.sourcePath, fixture.item.sourcePath);
  assert.deepEqual(catalog.items[0]?.destination, fixture.item.destination);
  assert.equal(catalog.items[0]?.savedAt, fixture.item.savedAt);
  assert.deepEqual(catalog.items[0]?.files, fixture.item.files);
  assert.deepEqual(catalog.items[0]?.content, { kind: "tree", path: sourceRelative });
  assert.deepEqual(catalog.groups, fixture.legacyCatalog.groups);
  const afterSources = await snapshotTree(path.join(box.library, "sources"));
  assert.deepEqual(afterSources, beforeSources, "adopt must preserve every source path, inode, mode and byte");
  const afterItems = await snapshotTree(path.join(box.library, "items"));
  assert.deepEqual(afterItems, beforeItems, "items remain byte-for-byte and inode-for-inode unchanged after migration");
  for (const [relative, original] of Object.entries(sourceStatsBefore)) {
    const stat = await lstat(sourceInodesBefore[relative]!, { bigint: true });
    assert.deepEqual({ dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o777n), bytes: (await readFile(sourceInodesBefore[relative]!)).toString("hex") }, original);
  }
  assert.deepEqual(catalog.items[0]?.content, { kind: "tree", path: sourceRelative });
  const backupNames = await readdir(path.join(box.library, ".migration-backups"));
  assert.equal(backupNames.length, 1, "exactly one verified migration backup must remain");
  const backupDir = `.migration-backups/${backupNames[0]}`;
  assert.match(screen, /検証済みバックアップ: \.migration-backups\/\[internal reference\]/);
  const backup = await backupEvidence(fixture, backupDir, beforeLibrary);
  for (const artifact of [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
    await assert.rejects(lstat(path.join(box.library, artifact)), { code: "ENOENT" });
  }
  const beforeNext = await snapshotTree(box.library);
  const nextDryRun = runCli(box, ["migrate", "--dry-run"]);
  assert.equal(nextDryRun.status, 0, nextDryRun.stderr);
  assert.match(plain(nextDryRun.stdout), /already-v2|すでに v2/);
  const afterDryRun = await snapshotTree(box.library);
  assert.deepEqual(afterDryRun, beforeNext, "already-v2 migration preview is strictly read-only");
  const list = runCli(box, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(plain(list.stdout), /日本語 旅程技能/);
  const afterNext = await snapshotTree(box.library);
  assert.deepEqual(withoutLibraryRootTimes(afterNext), withoutLibraryRootTimes(beforeNext), "list may acquire/release its transient root lock but changes no entry or file data");
  await assert.rejects(lstat(path.join(box.library, ".copi-transaction")), { code: "ENOENT" });
  traceRecord("adopt-success-verification", {
    requirement: "success postconditions and next CLI operation",
    exitCode: run.code, ptyOutputSha256: hash(run.raw), sourceStatsBefore, sourceTreeBefore: beforeSources,
    sourceTreeAfter: afterSources, catalogV2: catalog, catalogBytesSha256: digest(catalogBytes), itemsTreeAfter: afterItems,
    backup, cleanupArtifactsAbsent: [".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"],
    nextOperations: [
      { command: argv("migrate", "--dry-run"), exitCode: nextDryRun.status, stdout: nextDryRun.stdout, stderr: nextDryRun.stderr },
      { command: argv("list"), exitCode: list.status, stdout: list.stdout, stderr: list.stderr },
    ], libraryBeforeNext: beforeNext, libraryAfterDryRun: afterDryRun, libraryAfterNext: afterNext,
  });
  assert.ok(afterHome.exists);
  assert.deepEqual(afterHome.entries[".copi"], afterLibrary.entries["."], "HOME inventory includes the migrated library root");
});

for (const stage of ["whole", "secret-1", "secret-2", "final"] as const) {
  for (const cancel of ["default-no", "EOF", "Ctrl-C"] as const) {
    test(`R4-CLI real PTY ${stage} ${cancel} cancellation exits 1 with exact zero-write library tree`, async () => {
      const fixture = await createFixture();
      const { box } = fixture;
      const beforeLibrary = await snapshotTree(box.library);
      const beforeHome = await snapshotTree(box.home);
      const steps = cancellationSteps(fixture, stage, cancel);
      const run = await runTty(box, ["migrate"], steps);
      const afterLibrary = await snapshotTree(box.library);
      const afterHome = await snapshotTree(box.home);
      traceRecord(`cancel-${stage}-${cancel}`, {
        requirement: `real PTY ${stage} ${cancel} cancellation must exit 1 and write 0`,
        cwd: box.cwd, home: box.home, library: box.library, command: argv("migrate"), exitCode: run.code,
        timeout: run.timeout, stage, cancellation: cancel, reachedExpectedPrompt: run.actions === steps.length,
        steps, sentHex: run.timeline.map((entry) => entry.sentHex), timeline: run.timeline,
        terminal: { before: run.before, after: run.after, exact: run.exact, checkpoints: run.checkpoints },
        ptyOutput: { sha256: hash(run.raw), text: run.output, tmpPath: run.log, statePath: run.statePath },
        libraryBefore: beforeLibrary, libraryAfter: afterLibrary, homeBefore: beforeHome, homeAfter: afterHome,
      });
      assert.equal(run.timeout, false, run.output);
      assert.equal(run.code, 1, run.output);
      assert.equal(run.actions, steps.length, `expected prompt ${stage} was not reached: ${run.output}`);
      assert.equal(run.exact, true, JSON.stringify({ before: run.before, after: run.after }));
      assertAllWritesExactlySent(run);
      assert.deepEqual(afterLibrary, beforeLibrary, `${stage}/${cancel} must not change any library tree node`);
      assert.deepEqual(afterHome, beforeHome, `${stage}/${cancel} must not change HOME (including .copi)`);
      assert.doesNotMatch(run.output, /移行が完了しました/);
      const cancelStep = steps.at(-1)!;
      assert.ok(cancelStep.text === "\r" || cancelStep.hex === "04" || cancelStep.hex === "03");
    });
  }
}

test("R4-CLI real PTY rejects an edited source after the displayed preview before any migration write", async () => {
  const fixture = await createFixture();
  const { box } = fixture;
  const sourceFile = path.join(fixture.sourcePath, "SKILL.md");
  const beforeLibrary = await snapshotTree(box.library);
  const beforeHome = await snapshotTree(box.home);
  const beforeItems = await snapshotTree(path.join(box.library, "items"));
  const edited = Buffer.from("移行 preview の後に編集された日本語本文\n");
  const steps: Step[] = [
    { wait: wholePrompt, text: "y\r", checkpoint: true, probe: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(sourceFile)}, Buffer.from(${JSON.stringify(edited.toString())}))`] },
    ...secretFiles.map((file): Step => ({ wait: sensitivePrompt(file), text: "y\r", checkpoint: true })),
    { wait: finalPrompt, text: "y\r", checkpoint: true },
  ];
  const run = await runTty(box, ["migrate"], steps);
  const afterLibrary = await snapshotTree(box.library);
  const afterHome = await snapshotTree(box.home);
  traceRecord("preview-stale-rejected", {
    requirement: "preview accepted by user, then source changed before commit; stale review rejected write-free",
    cwd: box.cwd, home: box.home, library: box.library, command: argv("migrate"), exitCode: run.code,
    timeout: run.timeout, editedPath: sourceFile, externallyWrittenHex: edited.toString("hex"), steps,
    sentHex: run.timeline.map((entry) => entry.sentHex), timeline: run.timeline, probes: run.probes,
    terminal: { before: run.before, after: run.after, exact: run.exact, checkpoints: run.checkpoints },
    ptyOutput: { sha256: hash(run.raw), text: run.output, tmpPath: run.log, statePath: run.statePath },
    libraryBefore: beforeLibrary, libraryAfter: afterLibrary, homeBefore: beforeHome, homeAfter: afterHome,
  });
  assert.equal(run.timeout, false, run.output);
  assert.equal(run.code, 1, run.output);
  assert.equal(run.actions, steps.length, run.output);
  assert.equal(run.exact, true, JSON.stringify({ before: run.before, after: run.after }));
  assertAllWritesExactlySent(run);
  assert.equal(run.probes.length, 1);
  assert.equal(run.probes[0]?.code, 0, JSON.stringify(run.probes));
  assert.equal(afterLibrary.entries["sources/日本語/旅程技能/SKILL.md"]?.hex, edited.toString("hex"));
  assert.equal(afterLibrary.entries["catalog.json"]?.sha256, beforeLibrary.entries["catalog.json"]?.sha256);
  assert.deepEqual(await snapshotTree(path.join(box.library, "items")), beforeItems, "items remain intact after stale review rejection");
  for (const artifact of [".migration-backups", ".copi-transaction", ".copi-transaction-recovery", ".copi-migration-resolution.json"]) {
    await assert.rejects(lstat(path.join(box.library, artifact)), { code: "ENOENT" });
  }
  assert.match(run.output, /changed|review|migration/i);
  assert.doesNotMatch(run.output, /移行が完了しました/, "the user-facing success line must not be emitted for stale plans");
  assert.notDeepEqual(afterLibrary.entries["sources/日本語/旅程技能/SKILL.md"], beforeLibrary.entries["sources/日本語/旅程技能/SKILL.md"]);
  assert.deepEqual(afterHome.entries[".copi"], afterLibrary.entries["."], "only the deliberate source edit is reflected in HOME");
});

test("R4-CLI non-TTY real migrate dry-run is read-only across the complete library and HOME inventory", async () => {
  const fixture = await createFixture();
  const { box } = fixture;
  const beforeLibrary = await snapshotTree(box.library);
  const beforeHome = await snapshotTree(box.home);
  const run = await pty(box, argv("migrate", "--dry-run"), [], "both-pipe", [45, 180]);
  const afterLibrary = await snapshotTree(box.library);
  const afterHome = await snapshotTree(box.home);
  traceRecord("non-tty-dry-run", {
    requirement: "non-TTY actual CLI migration dry-run read-only over full library and HOME inventory",
    cwd: box.cwd, home: box.home, library: box.library, mode: "both-pipe", command: argv("migrate", "--dry-run"),
    exitCode: run.code, timeout: run.timeout, actions: run.actions, steps: [], terminal: { before: run.before, after: run.after, exact: run.exact },
    ptyOutput: { sha256: hash(run.raw), text: run.output, tmpPath: run.log, statePath: run.statePath },
    libraryBefore: beforeLibrary, libraryAfter: afterLibrary, homeBefore: beforeHome, homeAfter: afterHome,
  });
  assert.equal(run.timeout, false, run.output);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.actions, 0);
  assert.equal(run.exact, true, JSON.stringify({ before: run.before, after: run.after }));
  assert.match(run.output, /Legacy migration: ready/);
  assert.match(run.output, /日本語 旅程技能/);
  assert.deepEqual(afterLibrary, beforeLibrary, "non-TTY --dry-run must write no file or metadata in .copi");
  assert.deepEqual(afterHome, beforeHome, "non-TTY --dry-run must not modify any HOME entry");
});

test("R4-CLI items-only ready dry-run is not migration permission and commit rejects with write 0", async () => {
  const fixture = await createFixture({ itemsOnly: true });
  const { box } = fixture;
  const beforeLibrary = await snapshotTree(box.library);
  const beforeHome = await snapshotTree(box.home);
  const preview = await pty(box, argv("migrate", "--dry-run"), [], "both-pipe", [45, 180]);
  const afterPreviewLibrary = await snapshotTree(box.library);
  const afterPreviewHome = await snapshotTree(box.home);
  const steps: Step[] = [
    { wait: wholePrompt, text: "y\r", checkpoint: true },
    { wait: finalPrompt, text: "y\r", checkpoint: true },
  ];
  const commit = await runTty(box, ["migrate"], steps);
  const afterCommitLibrary = await snapshotTree(box.library);
  const afterCommitHome = await snapshotTree(box.home);
  traceRecord("items-only-rejected", {
    requirement: "items-only fixture may preview ready but ordinary migration commit rejects before any write",
    cwd: box.cwd, home: box.home, library: box.library,
    preview: { command: argv("migrate", "--dry-run"), exitCode: preview.code, timeout: preview.timeout, mode: "both-pipe",
      outputSha256: hash(preview.raw), output: preview.output, tmpPath: preview.log, statePath: preview.statePath },
    commit: { command: argv("migrate"), exitCode: commit.code, timeout: commit.timeout, steps,
      sentHex: commit.timeline.map((entry) => entry.sentHex), timeline: commit.timeline,
      terminal: { before: commit.before, after: commit.after, exact: commit.exact, checkpoints: commit.checkpoints },
      outputSha256: hash(commit.raw), output: commit.output, tmpPath: commit.log, statePath: commit.statePath },
    beforeLibrary, afterPreviewLibrary, afterCommitLibrary, beforeHome, afterPreviewHome, afterCommitHome,
  });
  assert.equal(preview.timeout, false, preview.output);
  assert.equal(preview.code, 0, preview.output);
  assert.match(preview.output, /Legacy migration: ready/);
  assert.match(preview.output, /\(items\)/);
  assert.deepEqual(afterPreviewLibrary, beforeLibrary);
  assert.deepEqual(afterPreviewHome, beforeHome);
  assert.equal(commit.timeout, false, commit.output);
  assert.equal(commit.code, 1, commit.output);
  assert.equal(commit.actions, steps.length, commit.output);
  assert.equal(commit.exact, true, JSON.stringify({ before: commit.before, after: commit.after }));
  assertAllWritesExactlySent(commit);
  assert.match(commit.output, /items-only and new-source additions are not implemented/);
  assert.doesNotMatch(commit.output, /移行が完了しました/);
  assert.deepEqual(afterCommitLibrary, beforeLibrary, "items-only commit refusal must have write count 0");
  assert.deepEqual(afterCommitHome, beforeHome, "items-only refusal leaves the complete HOME unchanged");
});
