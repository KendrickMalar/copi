import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { loadCatalog, readSnapshotFiles } from "./catalog.ts";
import { maskSensitiveText } from "./inspect.ts";
import type { InspectionWarning, SavedItem, SnapshotFileContents } from "./types.ts";

const maxInspectionBytes = 1_000_000;
const excludedNames = new Set([".git", ".cache", ".npm", "node_modules", "cache", "caches", "history", "sessions", "auth"]);
const planState = new WeakMap<ApplyPlan, InternalPlan>();

export type ApplyPreview = { kind: "text"; diff: string } | { kind: "binary"; summary: string };

export interface ApplyFileOption {
  itemId: string;
  sensitive: boolean;
  preview: ApplyPreview;
}

export interface ApplyFilePlan {
  path: string;
  itemId: string;
  status: "new" | "identical" | "different" | "collision";
  sensitive: boolean;
  preview: ApplyPreview;
  alternatives: ApplyFileOption[];
}

export interface ApplyCollision {
  path: string;
  itemIds: string[];
}

export interface ApplyPlan {
  projectDir: string;
  files: ApplyFilePlan[];
  collisions: ApplyCollision[];
  warnings: InspectionWarning[];
  skippedItems: string[];
}

export interface ApplyDecisions {
  collisions?: Record<string, string>;
  existing?: Record<string, "keep" | "replace" | "abort">;
  secretApprovals?: string[];
}

export interface ApplyBackup {
  path: string;
  backupPath: string;
  mode: number;
}

export interface ApplyResult {
  written: string[];
  kept: string[];
  skippedItems: string[];
  backups: ApplyBackup[];
  cancelled: boolean;
}

interface DestinationFile {
  bytes: Buffer;
  mode: number;
  sha256: string;
}

interface SnapshotCandidate {
  itemId: string;
  bytes: Buffer;
  mode: number;
  sha256: string;
  sensitive: boolean;
  preview: ApplyPreview;
}

interface InternalPlan {
  libraryRoot: string;
  projectRoot: string;
  requestedProjectDir: string;
  candidates: Map<string, SnapshotCandidate[]>;
  existing: Map<string, DestinationFile | undefined>;
  skippedItems: string[];
}

interface WriteOperation {
  path: string;
  candidate: SnapshotCandidate;
  before?: DestinationFile;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes(String.fromCharCode(92)) || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..") && path.posix.normalize(value) === value;
}

function isExcludedSnapshotPath(value: string): boolean {
  return value.split("/").some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === "auth.json" || lower === "mcp-auth.json" || lower === "oauth.json" || lower === ".env" || lower.startsWith(".env.") || lower.startsWith("env");
  });
}

function hasRelativeResourceReferences(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const settings = parsed as Record<string, unknown>;
  const subagentsValue = settings.subagents;
  const subagents = typeof subagentsValue === "object" && subagentsValue !== null && !Array.isArray(subagentsValue)
    ? subagentsValue as Record<string, unknown>
    : undefined;
  const hasRelativeSelections = (value: unknown): boolean => Array.isArray(value) && value.some((entry) =>
    typeof entry === "string" && entry.trim().length > 0 && !path.isAbsolute(entry.trim()) && !entry.startsWith("$") && !entry.startsWith("~/"),
  );
  const packageSelections = Array.isArray(settings.packages) ? settings.packages : [];
  const hasRelativePackage = packageSelections.some((entry) => {
    const selection = typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined;
    const source = typeof entry === "string" ? entry : selection?.source;
    return typeof source === "string" && (source.startsWith("./") || source.startsWith("../") || source.startsWith("file:"));
  });
  return hasRelativeSelections(settings.skills) || hasRelativeSelections(settings.agentScanDirs) ||
    hasRelativeSelections(subagents?.agentScanDirs) || hasRelativePackage;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textFrom(bytes: Buffer): string | undefined {
  if (bytes.length > maxInspectionBytes || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function previewFor(pathname: string, candidate: SnapshotCandidate, existing?: DestinationFile): ApplyPreview {
  const nextText = textFrom(candidate.bytes);
  const oldText = existing ? textFrom(existing.bytes) : "";
  if (nextText === undefined || oldText === undefined) {
    const oldSize = existing ? `${existing.bytes.length} bytes` : "no existing file";
    return { kind: "binary", summary: `${oldSize}; snapshot ${candidate.bytes.length} bytes.` };
  }
  return {
    kind: "text",
    diff: createTwoFilesPatch(
      existing ? pathname : "(new)",
      pathname,
      maskSensitiveText(oldText),
      maskSensitiveText(nextText),
    ),
  };
}

function addWarning(warnings: InspectionWarning[], code: string, message: string, warningPath?: string): void {
  if (warnings.some((warning) => warning.code === code && warning.path === warningPath)) return;
  warnings.push(warningPath === undefined ? { code, message } : { code, message, path: warningPath });
}

function inspectSnapshotText(
  item: SavedItem,
  file: SnapshotFileContents,
  destination: string,
  warnings: InspectionWarning[],
): boolean {
  const text = textFrom(file.bytes);
  if (text === undefined) {
    if (file.bytes.length > maxInspectionBytes) addWarning(warnings, "large-file-skipped", "Content inspection is limited to files no larger than 1 MB.", destination);
    return false;
  }
  addWarning(warnings, "secret-detection-limited", "Secret detection is heuristic and cannot guarantee completeness.");
  const compactText = text.replaceAll(" ", "").replaceAll("\t", "").replaceAll("\r", "").replaceAll("\n", "");
  const namedValue = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?[:=]["']?[A-Za-z0-9_./+=:-]{8,}/i;
  const recognizableToken = /(?:sk_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})/;
  const bearer = /Bearer[ ]+[A-Za-z0-9._~+/=-]{12,}/i;
  const sensitive = namedValue.test(compactText) || recognizableToken.test(text) || bearer.test(text);
  if (sensitive) addWarning(warnings, "sensitive-content", "This file may contain a secret; approve this file explicitly before applying it.", destination);
  if (/[$][{]?[A-Z_][A-Z0-9_]*[}]?/.test(text)) addWarning(warnings, "environment-reference", "This resource refers to environment variables that may need to be configured separately.", destination);
  if (text.includes("/Users/") || text.includes("/home/") || text.includes("~/")) addWarning(warnings, "absolute-path", "This resource contains a path that may not exist in another project.", destination);
  if (path.basename(file.path) === "package.json") {
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      const hasDependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
        (value) => typeof value === "object" && value !== null && Object.keys(value).length > 0,
      );
      if (hasDependencies) addWarning(warnings, "dependency-requirement", "This resource declares dependencies; copi does not install them automatically.", destination);
    } catch {
      addWarning(warnings, "invalid-package-manifest", "This package manifest could not be parsed for dependency warnings.", destination);
    }
  }
  if (item.kind === "pi-settings" && ["\"defaultProjectTrust\"", "\"httpProxy\"", "\"cacheWarming\""].some((key) => text.includes(key))) {
    addWarning(warnings, "project-setting-restricted", "This Pi setting is user-only and may not work in a project; copi preserves its bytes without rewriting it.", destination);
  }
  if (item.kind === "pi-settings" && hasRelativeResourceReferences(text)) {
    addWarning(warnings, "relative-resource-reference", "Pi resource references are relative to the settings file and may resolve differently when applied to a project.", destination);
  }
  return sensitive;
}

async function maybeLstat(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function safeProjectRoot(projectDir: string): Promise<{ requested: string; canonical: string }> {
  const requested = path.resolve(projectDir);
  const rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Project destination must be a real directory, not a symbolic link.");
  return { requested, canonical: await realpath(requested) };
}

async function inspectDestination(root: string, relativePath: string): Promise<DestinationFile | undefined> {
  if (!safeRelativePath(relativePath)) throw new Error("Unsafe relative path in apply plan.");
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await maybeLstat(current);
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new Error(`Destination contains a symbolic link: ${relativePath}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Destination ancestor is not a directory: ${relativePath}`);
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw new Error(`Destination is not a regular file: ${relativePath}`);
      const bytes = await readFile(current);
      return { bytes, mode: stat.mode & 0o777, sha256: sha256(bytes) };
    }
  }
  return undefined;
}

function targetPath(item: SavedItem, filePath: string, fileCount: number): string {
  if (item.destination.kind !== "project") throw new Error("A global-only resource cannot be applied to a project.");
  if (item.kind === "skill") return path.posix.join(item.destination.path, filePath);
  if (fileCount !== 1 || filePath.includes("/")) throw new Error(`A file resource has an invalid snapshot layout: ${item.name}`);
  return item.destination.path;
}

function candidateKey(candidate: SnapshotCandidate): string {
  return `${candidate.sha256}:${candidate.mode}`;
}

export async function planApply(libraryDir: string, groupId: string, projectDir: string): Promise<ApplyPlan> {
  const catalog = await loadCatalog(libraryDir);
  const group = catalog.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Unknown group: ${groupId}`);
  const storeRoot = await realpath(libraryDir);
  const project = await safeProjectRoot(projectDir);
  const warnings: InspectionWarning[] = [];
  const skippedItems: string[] = [];
  const candidates = new Map<string, SnapshotCandidate[]>();
  const existing = new Map<string, DestinationFile | undefined>();
  for (const itemId of group.itemIds) {
    const item = catalog.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error(`Group references an unavailable item: ${itemId}`);
    if (item.destination.kind === "global-only") {
      skippedItems.push(item.id);
      addWarning(warnings, "global-only", "This resource is saved for reference and cannot be applied to a project.", item.name);
      continue;
    }
    const snapshotFiles = await readSnapshotFiles(storeRoot, item);
    for (const snapshot of snapshotFiles) {
      if (isExcludedSnapshotPath(snapshot.path)) {
        addWarning(warnings, "private-path-skipped", "Authentication, environment, history, and cache files are not applied.", snapshot.path);
        continue;
      }
      const destination = targetPath(item, snapshot.path, snapshotFiles.length);
      const relativePath = path.posix.normalize(destination);
      if (!safeRelativePath(relativePath)) throw new Error(`Unsafe project destination in catalog: ${relativePath}`);
      const fileCandidates = candidates.get(relativePath) ?? [];
      const candidate: SnapshotCandidate = {
        itemId: item.id,
        bytes: snapshot.bytes,
        mode: snapshot.mode,
        sha256: snapshot.sha256,
        sensitive: inspectSnapshotText(item, snapshot, relativePath, warnings),
        preview: { kind: "binary", summary: "" },
      };
      fileCandidates.push(candidate);
      candidates.set(relativePath, fileCandidates);
      if (!existing.has(relativePath)) existing.set(relativePath, await inspectDestination(project.canonical, relativePath));
    }
  }
  const files: ApplyFilePlan[] = [];
  const collisions: ApplyCollision[] = [];
  for (const [relativePath, allCandidates] of candidates) {
    const uniqueCandidates = [...new Map(allCandidates.map((candidate) => [candidateKey(candidate), candidate])).values()];
    const current = existing.get(relativePath);
    for (const candidate of uniqueCandidates) candidate.preview = previewFor(relativePath, candidate, current);
    const collision = uniqueCandidates.length > 1;
    if (collision) collisions.push({ path: relativePath, itemIds: uniqueCandidates.map((candidate) => candidate.itemId) });
    const selected = uniqueCandidates[0]!;
    const identical = current !== undefined && current.sha256 === selected.sha256 && current.mode === selected.mode;
    let status: ApplyFilePlan["status"];
    if (collision) status = "collision";
    else if (identical) status = "identical";
    else if (current) status = "different";
    else status = "new";
    files.push({
      path: relativePath,
      itemId: selected.itemId,
      status,
      sensitive: selected.sensitive,
      preview: selected.preview,
      alternatives: uniqueCandidates.map(({ itemId, sensitive, preview }) => ({ itemId, sensitive, preview })),
    });
  }
  const plan: ApplyPlan = { projectDir: project.canonical, files, collisions, warnings, skippedItems };
  planState.set(plan, {
    libraryRoot: storeRoot,
    projectRoot: project.canonical,
    requestedProjectDir: project.requested,
    candidates: new Map([...candidates].map(([key, values]) => [key, [...new Map(values.map((candidate) => [candidateKey(candidate), candidate])).values()]])),
    existing,
    skippedItems: [...skippedItems],
  });
  return plan;
}

async function assertWritableParent(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;
  let parentForWrite = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await maybeLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe destination ancestor: ${relativePath}`);
    await access(current, constants.X_OK);
    parentForWrite = current;
  }
  const stat = await lstat(parentForWrite);
  if ((stat.mode & 0o222) === 0) throw new Error(`Destination parent is not writable: ${relativePath}`);
  await access(parentForWrite, constants.W_OK);
}

async function ensureParentDirectories(root: string, relativePath: string): Promise<string> {
  let current = root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await maybeLstat(current);
    if (!stat) {
      await mkdir(current, { mode: 0o755 });
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe destination ancestor: ${relativePath}`);
    }
    const verified = await lstat(current);
    if (verified.isSymbolicLink() || !verified.isDirectory()) throw new Error(`Unsafe destination ancestor: ${relativePath}`);
  }
  const canonicalParent = await realpath(current);
  if (!isWithin(root, canonicalParent)) throw new Error(`Destination escapes the project through a symbolic link: ${relativePath}`);
  return current;
}

async function createBackupSet(storeRoot: string, operations: WriteOperation[]): Promise<ApplyBackup[]> {
  const replacing = operations.filter((operation) => operation.before !== undefined);
  if (replacing.length === 0) return [];
  const backupRoot = path.join(storeRoot, "backups");
  const existingRoot = await maybeLstat(backupRoot);
  if (!existingRoot) await mkdir(backupRoot, { mode: 0o700 });
  const checkedRoot = await lstat(backupRoot);
  if (checkedRoot.isSymbolicLink() || !checkedRoot.isDirectory()) throw new Error("Copi backup path is not a safe directory.");
  await chmod(backupRoot, 0o700);
  const transactionRoot = path.join(backupRoot, randomUUID());
  await mkdir(transactionRoot, { mode: 0o700 });
  const backups: ApplyBackup[] = [];
  const manifest: Array<{ path: string; backupFile: string; mode: number }> = [];
  try {
    for (const [index, operation] of replacing.entries()) {
      const before = operation.before!;
      const filename = `${String(index).padStart(4, "0")}.bin`;
      const backupPath = path.join(transactionRoot, filename);
      const handle = await open(backupPath, "wx", 0o600);
      try {
        await handle.writeFile(before.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(backupPath, 0o600);
      backups.push({ path: operation.path, backupPath, mode: before.mode });
      manifest.push({ path: operation.path, backupFile: filename, mode: before.mode });
    }
    const manifestHandle = await open(path.join(transactionRoot, "manifest.json"), "wx", 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}${String.fromCharCode(10)}`, "utf8");
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    return backups;
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeSnapshotFile(root: string, relativePath: string, candidate: SnapshotCandidate): Promise<void> {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, target)) throw new Error(`Destination escapes the project: ${relativePath}`);
  const parent = await ensureParentDirectories(root, relativePath);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.copi-tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(candidate.bytes);
    await handle.chmod(candidate.mode);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function executeApply(libraryDir: string, plan: ApplyPlan, decisions: ApplyDecisions): Promise<ApplyResult> {
  const internal = planState.get(plan);
  if (!internal) throw new Error("Apply plan is not a verified plan created by planApply.");
  if (await realpath(libraryDir) !== internal.libraryRoot) throw new Error("Apply plan belongs to a different copi library.");
  if (await realpath(internal.requestedProjectDir) !== internal.projectRoot) throw new Error("Project destination changed after planning.");
  const operations: WriteOperation[] = [];
  const kept: string[] = [];
  let cancelled = false;
  for (const [relativePath, options] of internal.candidates) {
    let candidate = options[0];
    if (!candidate) throw new Error(`Apply plan lost snapshot bytes for ${relativePath}.`);
    if (options.length > 1) {
      const itemId = decisions.collisions?.[relativePath];
      if (!itemId) throw new Error(`A collision selection is required for ${relativePath}.`);
      const selected = options.find((option) => option.itemId === itemId);
      if (!selected) throw new Error(`Invalid collision selection for ${relativePath}.`);
      candidate = selected;
    }
    const previous = internal.existing.get(relativePath);
    if (previous && previous.sha256 === candidate.sha256 && previous.mode === candidate.mode) continue;
    if (previous) {
      const choice = decisions.existing?.[relativePath];
      if (choice !== "keep" && choice !== "replace" && choice !== "abort") throw new Error(`Choose keep, replace, or abort for existing file ${relativePath}.`);
      if (choice === "abort") {
        cancelled = true;
        continue;
      }
      if (choice === "keep") {
        kept.push(relativePath);
        continue;
      }
    }
    if (candidate.sensitive && !decisions.secretApprovals?.includes(relativePath)) throw new Error(`Explicit secret approval is required for ${relativePath}.`);
    if (previous) operations.push({ path: relativePath, candidate, before: previous });
    else operations.push({ path: relativePath, candidate });
  }
  if (cancelled) return { written: [], kept: [], skippedItems: [...internal.skippedItems], backups: [], cancelled: true };
  for (const operation of operations) {
    const current = await inspectDestination(internal.projectRoot, operation.path);
    const expected = internal.existing.get(operation.path);
    if ((current?.sha256 ?? undefined) !== (expected?.sha256 ?? undefined) || (current?.mode ?? undefined) !== (expected?.mode ?? undefined)) {
      throw new Error(`Destination changed after planning: ${operation.path}`);
    }
    await assertWritableParent(internal.projectRoot, operation.path);
  }
  const backups = await createBackupSet(internal.libraryRoot, operations);
  const written: string[] = [];
  for (const operation of operations) {
    const current = await inspectDestination(internal.projectRoot, operation.path);
    const expected = internal.existing.get(operation.path);
    if ((current?.sha256 ?? undefined) !== (expected?.sha256 ?? undefined) || (current?.mode ?? undefined) !== (expected?.mode ?? undefined)) {
      throw new Error(`Destination changed during apply: ${operation.path}`);
    }
    await writeSnapshotFile(internal.projectRoot, operation.path, operation.candidate);
    written.push(operation.path);
  }
  return { written, kept, skippedItems: [...internal.skippedItems], backups, cancelled: false };
}
