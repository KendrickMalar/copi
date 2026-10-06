import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertModernCatalog, parseStoredCatalog } from "./catalog.ts";
import { readSourceContent } from "./source-content.ts";
import { parseStorageJournal, validateSourcesJournalTargets, type SourcesStorageJournal } from "./storage-journal.ts";
import { renameExclusiveReviewedSource } from "./native-placement.ts";
import { inspectFixedResource } from "./inspect.ts";
import { assertNoNameConflicts, findNameConflicts, nameKey } from "./names.ts";
import type { Catalog, InspectionWarning, SavedItem } from "./types.ts";

const lockName = ".copi-transaction";
const privateNames = new Set([".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions", "auth.json", "mcp-auth.json", "oauth.json"]);
const itemPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export interface StorageFile { readonly path: string; readonly bytes: Buffer; readonly mode: number }
export interface StorageReplacement { readonly itemId: string; readonly files: readonly StorageFile[] }
declare const storageReviewBrand: unique symbol;
export interface StorageReview { readonly [storageReviewBrand]: true; readonly reviewId: string }
export interface StorageReviewView { readonly sensitivePaths: readonly string[]; readonly warnings: readonly InspectionWarning[] }
export interface StorageAuthorization { readonly review: StorageReview; readonly approval: { readonly reviewId: string; readonly confirmed: boolean; readonly approvedSensitivePaths: readonly string[] } }
interface ReviewState { catalog: Buffer; replacements: StorageReplacement[]; sensitivePaths: string[]; warnings: InspectionWarning[] }
const reviews = new WeakMap<StorageReview, ReviewState>();
interface TreeEntry { path: string; kind: "directory" | "file" | "link"; value: string; mode: number; dev?: number; ino?: number }
export interface StorageRevision { readonly root: string; readonly catalog: string | null; readonly catalogIdentity: string | null; readonly format: "v1" | "v2"; readonly tree: string }
export type StorageCheckpoint = "stage-write" | "stage-sync" | "journal" | "before-swap" | "old-renamed" | "new-renamed" | "before-catalog" | "catalog-held" | "catalog-renamed" | "directory-sync" | "committed" | "rollback-started" | "rollback-displaced" | "rollback-restored" | "rollback-catalog-held" | "finalized" | "rollback-finalized";
export interface StorageOptions { checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>; waitMilliseconds?: number }
interface Owner { version: 1; pid: number; host: string; token: string; blocked?: boolean }
interface DirectoryIdentity { dev: number; ino: number }
interface InFlightControl { signal: AbortSignal; recovering: boolean }
interface SessionLease {
  root: string; lock: string; owner: Owner;
  stop: AbortController; pending: Set<Promise<void>>; operation?: InFlightControl;
  unjournaledArtifacts: Map<string, UnjournaledArtifact>;
  rootIdentity: DirectoryIdentity; lockIdentity: DirectoryIdentity;
  recoveryClaim?: { path: string; identity: DirectoryIdentity };
}
// Only run/recoverDead issue leases. Public constructor calls cannot register themselves.
const sessionLeases = new WeakMap<StorageSession, SessionLease>();
type SourcesOperation = SourcesStorageJournal["operations"][number];
interface FinalizedCleanupArtifact { name: string; kind: "file" | "source-file" | "source-tree"; commitment: string }
interface FinalizedCleanupManifest { version: 1; root: string; token: string; operationCount: number; operationKinds?: Array<"file" | "tree">; operationStageKinds?: Array<"file" | "tree">; artifacts: FinalizedCleanupArtifact[] }
type UnjournaledArtifact = { identity: DirectoryIdentity; kind: "file" | "tree"; commitment: string }

export function safeStoragePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
export function privateStoragePath(value: string): boolean {
  return value.split("/").some((part) => privateNames.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env"));
}
function replacementSignature(replacements: readonly StorageReplacement[]): string {
  return JSON.stringify(replacements.map((replacement) => ({ itemId: replacement.itemId, files: replacement.files.map((file) => ({ path: file.path, mode: file.mode, sha256: hash(file.bytes) })) })));
}

/** @internal Opaque review for callers of the generalized transaction adapter. Fixed bytes, no approval bypass flags. */
export function prepareStorageReview(catalog: Buffer, replacements: readonly StorageReplacement[]): StorageReview {
  const fixed = Buffer.from(catalog);
  const parsed = parseStoredCatalog(JSON.parse(fixed.toString("utf8")) as unknown);
  const copies = replacements.map((replacement) => ({ itemId: replacement.itemId, files: replacement.files.map((file) => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.bytes) })) }));
  if (new Set(copies.map((replacement) => replacement.itemId)).size !== copies.length) throw new Error("Duplicate snapshot replacement.");
  const sensitivePaths: string[] = [];
  const warnings: InspectionWarning[] = [];
  for (const replacement of copies) {
    const item = parsed.items.find((item) => item.id === replacement.itemId);
    if (!item || !itemPattern.test(replacement.itemId)) throw new Error("Snapshot replacement must refer to an item in the new catalog.");
    const descriptors = replacement.files.map((file) => ({ path: file.path, mode: file.mode, sha256: hash(file.bytes) }));
    if (JSON.stringify(descriptors) !== JSON.stringify(item.files)) throw new Error("Snapshot bytes, paths, modes and catalog checksums do not match.");
    if (replacement.files.length === 0 || replacement.files.some((file) => !safeStoragePath(file.path) || privateStoragePath(file.path))) throw new Error("Unsafe or private/excluded snapshot path in storage replacement.");
    const inspection = inspectFixedResource({ candidate: { ...item, sourceRoot: path.dirname(item.sourcePath) }, files: replacement.files, excludedPaths: [] });
    sensitivePaths.push(...inspection.sensitivePaths.map((filePath) => `${replacement.itemId}/${filePath}`));
    warnings.push(...inspection.warnings.map((warning) => warning.path ? { ...warning, path: `${replacement.itemId}/${warning.path}` } : { ...warning }));
  }
  const review = Object.freeze({ reviewId: randomUUID() }) as StorageReview;
  reviews.set(review, { catalog: fixed, replacements: copies, sensitivePaths: [...new Set(sensitivePaths)].sort(), warnings });
  return review;
}
export function readStorageReview(review: StorageReview): StorageReviewView {
  const state = reviews.get(review);
  if (!state) throw new Error("Invalid prepared storage review token.");
  return { sensitivePaths: [...state.sensitivePaths], warnings: structuredClone(state.warnings) };
}
function approvedStorage(catalog: Buffer, replacements: readonly StorageReplacement[], authorization?: StorageAuthorization): ReviewState {
  const review = authorization?.review ?? prepareStorageReview(catalog, replacements);
  const state = reviews.get(review);
  if (!state || !state.catalog.equals(catalog) || replacementSignature(state.replacements) !== replacementSignature(replacements)) throw new Error("Storage review does not match these fixed bytes or catalog.");
  // Reinspect the private fixed bytes at commit, never a caller-supplied warning/path view.
  const checked = reviews.get(prepareStorageReview(state.catalog, state.replacements))!;
  if (!authorization) {
    if (checked.sensitivePaths.length > 0) throw new Error("A prepared storage inspection and individual secret approval are required.");
    return state;
  }
  const approved = new Set(authorization.approval.approvedSensitivePaths);
  if (authorization.approval.confirmed !== true || authorization.approval.reviewId !== review.reviewId || approved.size !== authorization.approval.approvedSensitivePaths.length || approved.size !== checked.sensitivePaths.length || checked.sensitivePaths.some((filePath) => !approved.has(filePath))) throw new Error("Storage approval must match the prepared review and every sensitive file.");
  return state;
}

async function statMaybe(target: string) {
  return lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
}
async function checkedFile(target: string): Promise<Buffer | undefined> {
  const stat = await statMaybe(target);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link or non-file in copi storage: ${target}`);
  return readFile(target);
}
async function checkedDirectory(target: string): Promise<boolean> {
  const stat = await statMaybe(target);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link or non-directory in copi storage: ${target}`);
  return true;
}
async function tree(target: string, replacements?: ReadonlyMap<string, string>, includeIdentity = false, omittedPaths: ReadonlySet<string> = new Set()): Promise<string | null> {
  if (!await statMaybe(target)) return null;
  const entries: TreeEntry[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    const stat = await lstat(current);
    const identity = includeIdentity ? { dev: stat.dev, ino: stat.ino } : {};
    if (stat.isSymbolicLink()) entries.push({ path: relative, kind: "link", value: await readlink(current), mode: stat.mode & 0o777, ...identity });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", value: "", mode: stat.mode & 0o777, ...identity });
      const names = await readdir(current);
      const prefix = relative === "." ? "" : `${relative}/`;
      const mappedChildren = [...(replacements?.keys() ?? [])].flatMap((mapped) => {
        const remainder = relative === "." ? mapped : path.posix.relative(relative, mapped);
        if (!remainder || remainder === ".." || remainder.startsWith("../") || path.posix.isAbsolute(remainder)) return [];
        return [remainder.split("/")[0]!];
      });
      for (const entry of [...new Set([...names, ...mappedChildren])].sort()) {
        const childRelative = `${prefix}${entry}`;
        if (omittedPaths.has(childRelative)) continue;
        const replacement = replacements?.get(childRelative);
        await visit(replacement ?? path.join(current, entry), childRelative);
      }
    } else if (stat.isFile()) entries.push({ path: relative, kind: "file", value: hash(await readFile(current)), mode: stat.mode & 0o777, ...identity });
    else throw new Error("Unsupported special file in copi storage.");
  }
  await visit(target, ".");
  return hash(JSON.stringify(entries));
}
function validateMutationNames(previous: Catalog, next: Catalog, replacements: readonly StorageReplacement[]): void {
  const conflicts = findNameConflicts(previous);
  if (conflicts.length === 0) { assertNoNameConflicts(next); return; }
  if (replacements.length > 0) throw new Error("Duplicate names must be resolved before content changes.");
  const restored = structuredClone(next);
  for (const namespace of ["item", "group"] as const) {
    const before = namespace === "item" ? previous.items : previous.groups;
    const after = namespace === "item" ? restored.items : restored.groups;
    if (before.length !== after.length) throw new Error("Only conflicting names may change until duplicate names are resolved.");
    for (const [index, entry] of after.entries()) {
      const old = before[index];
      if (!old || old.id !== entry.id) throw new Error("Conflict resolution must preserve catalog identities and order.");
      if (old.name !== entry.name) {
        if (!conflicts.some((conflict) => conflict.namespace === namespace && conflict.ids.includes(entry.id))) throw new Error("Only conflicting names may change until duplicate names are resolved.");
        const all = namespace === "item" ? next.items : next.groups;
        if (all.some((other) => other.id !== entry.id && nameKey(other.name) === nameKey(entry.name))) throw new Error("Duplicate name in conflict resolution.");
      }
      entry.name = old.name;
    }
  }
  if (JSON.stringify(restored) !== JSON.stringify(previous)) throw new Error("Conflict resolution must preserve all metadata, files and group references.");
}
async function checkedSourceFileTarget(root: string, target: string, allowMissing = false): Promise<string | undefined> {
  if (!safeStoragePath(target) || !target.startsWith("sources/") || privateStoragePath(target)) throw new Error("Unsafe registered sources file target.");
  const segments = target.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await statMaybe(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Registered sources file has a missing, unsafe, or symbolic-link parent directory.");
  }
  const absolute = path.join(current, segments.at(-1)!);
  const stat = await statMaybe(absolute);
  if (!stat && allowMissing) return undefined;
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error("Registered sources content must be a regular non-symlink file.");
  return absolute;
}

async function checkedSourceTreeTarget(root: string, target: string, allowMissing = false): Promise<string | undefined> {
  if (!safeStoragePath(target) || !target.startsWith("sources/") || privateStoragePath(target)) throw new Error("Unsafe registered sources tree target.");
  const segments = target.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await statMaybe(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Registered sources tree has a missing, unsafe, or symbolic-link parent directory.");
  }
  const absolute = path.join(current, segments.at(-1)!);
  const stat = await statMaybe(absolute);
  if (!stat && allowMissing) return undefined;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Registered sources content root must be a regular non-symlink directory.");
  return absolute;
}

async function renameNewSourcesStageExclusive(libraryDir: string, stagePath: string, targetPath: string): Promise<void> {
  const [stage, parent] = await Promise.all([
    lstat(stagePath, { bigint: true }),
    lstat(path.dirname(targetPath), { bigint: true }),
  ]);
  if (!stage.isDirectory() || stage.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("New source placement requires a checked private stage and target parent directory.");
  }
  await renameExclusiveReviewedSource({
    libraryDir,
    stagePath,
    targetPath,
    expectedStage: { dev: stage.dev.toString(), ino: stage.ino.toString() },
    expectedParent: { dev: parent.dev.toString(), ino: parent.ino.toString() },
  });
}

async function assertNoExcludedTreeNodes(root: string): Promise<void> {
  async function visit(directory: string, relative: string): Promise<void> {
    const rootStat = await lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Sources tree contains an unsafe directory.");
    for (const name of await readdir(directory)) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (privateStoragePath(childRelative)) throw new Error("Excluded/private files in a registered sources tree require preservation; refusing tree replacement.");
      const child = path.join(directory, name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) throw new Error("Sources tree contains an unsafe symbolic link; refusing replacement.");
      if (stat.isDirectory()) await visit(child, childRelative);
      else if (!stat.isFile()) throw new Error("Sources tree contains an unsupported special file; refusing replacement.");
    }
  }
  await visit(root, "");
}

async function assertNewSourcesTargetVacant(root: string, item: SavedItem): Promise<void> {
  const sourcesRoot = path.join(root, "sources");
  const sourcesStat = await statMaybe(sourcesRoot);
  if (!sourcesStat) return;
  if (!sourcesStat.isDirectory() || sourcesStat.isSymbolicLink()) throw new Error("Unsafe or symbolic-link sources root for a new content target.");
  const itemRoot = path.join(sourcesRoot, item.id);
  const itemStat = await statMaybe(itemRoot);
  if (itemStat?.isSymbolicLink()) throw new Error("A new content target has a symbolic-link parent; refusing to follow it.");
  if (itemStat) throw new Error("New registered content target already exists; refusing to adopt or overwrite it.");
}

function validateNewItemDescriptors(item: SavedItem, replacement: StorageReplacement): void {
  if (replacement.files.length === 0 || replacement.files.some((file) => !safeStoragePath(file.path) || privateStoragePath(file.path)) ||
      new Set(replacement.files.map((file) => file.path)).size !== replacement.files.length ||
      replacement.files.some((file) => replacement.files.some((other) => other.path !== file.path && other.path.startsWith(`${file.path}/`))) ||
      JSON.stringify(replacement.files.map(({ path: filePath, mode, bytes }) => ({ path: filePath, mode, sha256: hash(bytes) }))) !== JSON.stringify(item.files)) {
    throw new Error("A new sources item must contain only unique, safe reviewed files matching its catalog descriptors.");
  }
  if (item.content.kind === "file") {
    const file = replacement.files[0];
    const parts = item.content.path.split("/");
    if (item.files.length !== 1 || replacement.files.length !== 1 || !file || parts.length !== 3 || parts[0] !== "sources" ||
        parts[1] !== item.id || parts[2] !== path.posix.basename(file.path) || file.path !== parts[2]) {
      throw new Error("A new sources file target must be sources/<item UUID>/<reviewed basename>.");
    }
  } else if (item.content.path !== `sources/${item.id}` || item.kind !== "skill" || !replacement.files.some((file) => file.path === "SKILL.md")) {
    throw new Error("A new sources tree target must be sources/<item UUID> and include its root SKILL.md.");
  }
}

async function validateSourcesTransition(root: string, previous: Catalog, next: Catalog, replacements: readonly StorageReplacement[]): Promise<SourcesOperation[]> {
  validateMutationNames(previous, next, replacements);
  if (next.items.length < previous.items.length || next.groups.length !== previous.groups.length) {
    throw new Error("A sources transaction cannot remove items or create groups.");
  }
  const additions = next.items.slice(previous.items.length);
  const addedIds = new Set(additions.map((item) => item.id));
  for (const [index, oldItem] of previous.items.entries()) {
    const nextItem = next.items[index];
    if (!nextItem || nextItem.id !== oldItem.id) throw new Error("Sources transaction must preserve existing catalog item order and identity.");
    if (additions.length > 0 && JSON.stringify(nextItem) !== JSON.stringify(oldItem)) {
      throw new Error("Adding a new source item cannot also modify existing item metadata or content.");
    }
  }
  for (const [index, oldGroup] of previous.groups.entries()) {
    const nextGroup = next.groups[index];
    if (!nextGroup || nextGroup.id !== oldGroup.id || nextGroup.name !== oldGroup.name ||
        JSON.stringify(nextGroup.itemIds.slice(0, oldGroup.itemIds.length)) !== JSON.stringify(oldGroup.itemIds) ||
        nextGroup.itemIds.slice(oldGroup.itemIds.length).some((id) => !addedIds.has(id))) {
      throw new Error("A new source item may only be appended to existing group relations without changing existing membership.");
    }
  }

  const replacementById = new Map<string, StorageReplacement>();
  for (const replacement of replacements) {
    if (!itemPattern.test(replacement.itemId) || replacementById.has(replacement.itemId)) throw new Error("Duplicate or invalid sources replacement item.");
    replacementById.set(replacement.itemId, replacement);
  }
  const operations: SourcesOperation[] = [];
  for (const [index, oldItem] of previous.items.entries()) {
    const nextItem = next.items[index]!;
    const replacement = replacementById.get(oldItem.id);
    if (!replacement) {
      if (JSON.stringify(nextItem) !== JSON.stringify(oldItem)) throw new Error("Unreplaced catalog items must remain byte-for-byte unchanged.");
      continue;
    }
    if (additions.length > 0) throw new Error("New-item content transactions cannot replace existing source targets.");
    if (oldItem.content.kind !== nextItem.content.kind || oldItem.content.path !== nextItem.content.path) {
      throw new Error("A sources replacement must keep its registered content kind and original root.");
    }
    const target = nextItem.content.path;
    if (!safeStoragePath(target) || !target.startsWith("sources/") || privateStoragePath(target)) throw new Error("Unsafe registered sources content target.");
    const expectedItem = { ...oldItem, files: nextItem.files };
    if (JSON.stringify(expectedItem) !== JSON.stringify(nextItem)) throw new Error("A sources content replacement may update only its reviewed file descriptors.");

    if (nextItem.content.kind === "file") {
      const basename = path.posix.basename(target);
      const oldFile = oldItem.files[0];
      const nextFile = nextItem.files[0];
      const file = replacement.files[0];
      if (replacement.files.length !== 1 || oldItem.files.length !== 1 || nextItem.files.length !== 1 || !oldFile || !nextFile || !file ||
          file.path !== basename || nextFile.path !== basename || oldFile.path !== basename ||
          file.mode !== oldFile.mode || nextFile.mode !== oldFile.mode || nextFile.sha256 !== hash(file.bytes) || privateStoragePath(file.path)) {
        throw new Error("A sources file replacement must contain exactly the registered basename and preserve its approved mode and catalog checksum.");
      }
      const currentFiles = await readSourceContent(root, oldItem);
      if (currentFiles.length !== 1 || currentFiles[0]!.path !== basename) throw new Error("Registered sources file did not resolve to exactly its catalog basename.");
      await checkedSourceFileTarget(root, target);
      operations.push({ itemId: oldItem.id, target, kind: "file", oldTree: null, newTree: "0".repeat(64) });
      continue;
    }

    if (replacement.files.length === 0 || replacement.files.some((file) => !safeStoragePath(file.path) || privateStoragePath(file.path)) ||
        new Set(replacement.files.map((file) => file.path)).size !== replacement.files.length ||
        replacement.files.some((file) => replacement.files.some((other) => other.path !== file.path && other.path.startsWith(`${file.path}/`))) ||
        JSON.stringify(replacement.files.map(({ path: filePath, mode, bytes }) => ({ path: filePath, mode, sha256: hash(bytes) }))) !== JSON.stringify(nextItem.files)) {
      throw new Error("A sources tree replacement must contain only unique, safe reviewed files matching its catalog descriptors.");
    }
    if (nextItem.kind !== "skill" || !replacement.files.some((file) => file.path === "SKILL.md")) {
      throw new Error("A registered skill tree replacement must include its root SKILL.md.");
    }
    const targetPath = await checkedSourceTreeTarget(root, target);
    if (!targetPath) throw new Error("Registered sources tree root disappeared before staging.");
    await assertNoExcludedTreeNodes(targetPath);
    const currentFiles = await readSourceContent(root, oldItem);
    if (!currentFiles.some((file) => file.path === "SKILL.md")) throw new Error("Registered skill tree is missing its required root SKILL.md.");
    operations.push({ itemId: oldItem.id, target, kind: "tree", oldTree: null, newTree: "0".repeat(64) });
  }
  for (const item of additions) {
    const replacement = replacementById.get(item.id);
    if (!replacement || !itemPattern.test(item.id)) throw new Error("Every new v2 item requires one reviewed storage replacement with a UUID.");
    validateNewItemDescriptors(item, replacement);
    await assertNewSourcesTargetVacant(root, item);
    operations.push({ itemId: item.id, target: item.content.path, kind: item.content.kind, oldTree: null, newTree: "0".repeat(64) });
  }
  if (replacementById.size !== operations.length) throw new Error("A sources replacement refers to an unknown catalog item.");
  return operations;
}

function validateSourcesCatalogTransition(previous: Catalog | null, next: Catalog, operations: readonly SourcesOperation[]): void {
  const previousItems = previous?.items ?? [];
  const previousGroups = previous?.groups ?? [];
  if (next.items.length < previousItems.length || next.groups.length !== previousGroups.length) throw new Error("Sources journal changed catalog membership outside a new-item transaction.");
  const additions = next.items.slice(previousItems.length);
  const addedIds = new Set(additions.map((item) => item.id));
  for (const [index, oldGroup] of previousGroups.entries()) {
    const nextGroup = next.groups[index];
    if (!nextGroup || nextGroup.id !== oldGroup.id || nextGroup.name !== oldGroup.name ||
        JSON.stringify(nextGroup.itemIds.slice(0, oldGroup.itemIds.length)) !== JSON.stringify(oldGroup.itemIds) ||
        nextGroup.itemIds.slice(oldGroup.itemIds.length).some((id) => !addedIds.has(id))) {
      throw new Error("Sources journal changed an existing group relation beyond adding a new item.");
    }
  }
  const byId = new Map(operations.map((operation) => [operation.itemId, operation]));
  for (const [index, oldItem] of previousItems.entries()) {
    const nextItem = next.items[index];
    if (!nextItem || nextItem.id !== oldItem.id) throw new Error("Sources journal catalogs changed existing item order or identity.");
    const operation = byId.get(oldItem.id);
    if (!operation) {
      if (JSON.stringify(nextItem) !== JSON.stringify(oldItem)) throw new Error("Sources journal contains an unrecorded catalog item change.");
      continue;
    }
    if (additions.length > 0) throw new Error("New-item journal cannot also replace existing source content.");
    if (oldItem.content.kind !== operation.kind || nextItem.content.kind !== operation.kind ||
        oldItem.content.path !== operation.target || nextItem.content.path !== operation.target ||
        JSON.stringify({ ...oldItem, files: nextItem.files }) !== JSON.stringify(nextItem)) {
      throw new Error("Sources journal operation does not match a descriptor-only update to its registered content root.");
    }
    if (operation.kind === "file") {
      const oldFile = oldItem.files[0];
      const nextFile = nextItem.files[0];
      if (!oldFile || !nextFile || oldItem.files.length !== 1 || nextItem.files.length !== 1 || oldFile.path !== path.posix.basename(operation.target) ||
          nextFile.path !== oldFile.path || nextFile.mode !== oldFile.mode) {
        throw new Error("Sources journal file operation does not preserve its registered path and mode.");
      }
    } else if (nextItem.kind !== "skill" || !nextItem.files.some((file) => file.path === "SKILL.md")) {
      throw new Error("Sources journal tree operation has no root SKILL.md descriptor.");
    }
  }
  for (const item of additions) {
    const operation = byId.get(item.id);
    if (!operation || operation.oldTree !== null || operation.target !== item.content.path || operation.kind !== item.content.kind ||
        (item.content.kind === "file" && (item.files.length !== 1 || item.files[0]!.path !== path.posix.basename(item.content.path))) ||
        (item.content.kind === "tree" && (item.kind !== "skill" || !item.files.some((file) => file.path === "SKILL.md")))) {
      throw new Error("Sources journal operation does not match a new item and its reviewed content target.");
    }
  }
  if (byId.size !== operations.length || additions.length !== operations.filter((operation) => !previousItems.some((item) => item.id === operation.itemId)).length) {
    throw new Error("Sources journal refers to an unknown or unrecorded catalog item.");
  }
}

async function sourceArtifactTreeIfPresent(target: string, kind: "file" | "tree"): Promise<string | null> {
  const stat = await statMaybe(target);
  if (!stat) return null;
  if (kind === "file" ? !stat.isFile() || stat.isSymbolicLink() : !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Sources transaction ${kind} target, stage, or backup has an unsafe kind.`);
  }
  return tree(target, undefined, true);
}

function sourcesRelativeTarget(operation: SourcesOperation): string {
  return operation.target.slice("sources/".length);
}

function operationStageContentPath(lock: string, journal: SourcesStorageJournal, index: number): string {
  const operation = journal.operations[index]!;
  const relative = sourcesRelativeTarget(operation);
  if (operation.oldTree === null && journal.stableSourcesTree === "absent") return path.join(lock, "next-sources", ...relative.split("/"));
  if (operation.oldTree === null && operation.kind === "file") return path.join(lock, `next-${index}`, path.posix.basename(operation.target));
  return path.join(lock, `next-${index}`);
}

function operationStageContainerPath(lock: string, journal: SourcesStorageJournal, index: number): string {
  const operation = journal.operations[index]!;
  if (operation.oldTree === null && journal.stableSourcesTree === "absent") return path.join(lock, "next-sources");
  return path.join(lock, `next-${index}`);
}

function operationIsStagedFileParent(journal: SourcesStorageJournal, index: number): boolean {
  const operation = journal.operations[index]!;
  return operation.oldTree === null && operation.kind === "file" && journal.stableSourcesTree !== "absent";
}

function ownedSourceDirectory(journal: SourcesStorageJournal, relativePath: string): NonNullable<SourcesStorageJournal["ownedDirectories"]>[number] | undefined {
  return journal.ownedDirectories?.find((directory) => directory.path === relativePath);
}

function ownedDirectoryStagePath(lock: string, directory: NonNullable<SourcesStorageJournal["ownedDirectories"]>[number]): string {
  const stageRoot = path.join(lock, directory.stage);
  if (directory.path === "sources" || directory.stage !== "next-sources") return stageRoot;
  return path.join(stageRoot, ...directory.path.slice("sources/".length).split("/"));
}

async function verifyOwnedDirectory(target: string, expected: NonNullable<SourcesStorageJournal["ownedDirectories"]>[number], allowMissing = false): Promise<boolean> {
  const stat = await statMaybe(target);
  if (!stat && allowMissing) return false;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
      stat.dev !== expected.dev || stat.ino !== expected.ino || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`Owned new sources directory ${expected.path} changed identity, type, or private mode.`);
  }
  return true;
}

async function checkedSourcesOperationTarget(root: string, operation: SourcesOperation, allowMissing = false): Promise<string | undefined> {
  if (!safeStoragePath(operation.target) || !operation.target.startsWith("sources/") || privateStoragePath(operation.target)) {
    throw new Error("Unsafe registered sources content target.");
  }
  const parts = operation.target.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await statMaybe(current);
    if (!stat && allowMissing) return undefined;
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Registered sources target has a missing, unsafe, or symbolic-link parent.");
  }
  const target = path.join(current, parts.at(-1)!);
  const stat = await statMaybe(target);
  if (!stat && allowMissing) return undefined;
  if (!stat || (operation.kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink()) {
    throw new Error(`Registered sources ${operation.kind} target has an unsafe kind.`);
  }
  return target;
}

interface StoredTreeFile { path: string; sha256: string }
async function strictTreeFiles(root: string): Promise<StoredTreeFile[]> {
  await assertNoExcludedTreeNodes(root);
  const files: StoredTreeFile[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const beforeDirectory = await lstat(directory);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) throw new Error("Sources tree contains an unsafe directory.");
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relativePath = relative ? `${relative}/${name}` : name;
      const target = path.join(directory, name);
      const before = await lstat(target);
      if (before.isSymbolicLink()) throw new Error("Sources tree contains an unsafe symbolic link.");
      if (before.isDirectory()) await visit(target, relativePath);
      else if (before.isFile()) {
        const bytes = await readFile(target);
        const after = await lstat(target);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) {
          throw new Error("Sources tree file changed while it was being inspected.");
        }
        files.push({ path: relativePath, sha256: hash(bytes) });
      } else throw new Error("Sources tree contains an unsupported special file.");
    }
    const afterDirectory = await lstat(directory);
    if (!afterDirectory.isDirectory() || afterDirectory.isSymbolicLink() || beforeDirectory.dev !== afterDirectory.dev ||
        beforeDirectory.ino !== afterDirectory.ino || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) {
      throw new Error("Sources tree directory changed while it was being inspected.");
    }
  }
  await visit(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertTreeMatchesDescriptors(root: string, descriptors: SavedItem["files"]): Promise<void> {
  const actual = await strictTreeFiles(root);
  const expected = descriptors.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Staged sources tree files do not match the next catalog descriptors.");
}

interface TreeCleanupNode { path: string; kind: "file" | "directory"; identity: DirectoryIdentity; mode: number; commitment?: string }
async function removeOwnedTreeArtifact(target: string, commitment: string): Promise<void> {
  if (await sourceArtifactTreeIfPresent(target, "tree") !== commitment) throw new Error("Private sources tree artifact changed; preserving it.");
  const nodes: TreeCleanupNode[] = [];
  async function collect(directory: string): Promise<void> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private sources tree cleanup found an unsafe directory.");
    for (const name of await readdir(directory)) {
      const child = path.join(directory, name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) throw new Error("Private sources tree cleanup found an unknown symbolic link; preserving it.");
      if (childStat.isDirectory()) await collect(child);
      else if (childStat.isFile()) nodes.push({ path: child, kind: "file", identity: { dev: childStat.dev, ino: childStat.ino }, mode: childStat.mode & 0o777, commitment: hash(await readFile(child)) });
      else throw new Error("Private sources tree cleanup found an unknown node; preserving it.");
    }
    nodes.push({ path: directory, kind: "directory", identity: { dev: stat.dev, ino: stat.ino }, mode: stat.mode & 0o777 });
  }
  await collect(target);
  for (const node of nodes) {
    const current = await statMaybe(node.path);
    if (!current || !sameDirectory({ dev: current.dev, ino: current.ino }, node.identity) || (current.mode & 0o777) !== node.mode ||
        (node.kind === "file" ? !current.isFile() || current.isSymbolicLink() : !current.isDirectory() || current.isSymbolicLink())) {
      throw new Error("Private sources tree node changed before cleanup; preserving the tree.");
    }
    if (node.kind === "file") {
      const bytes = await readFile(node.path);
      if (hash(bytes) !== node.commitment) throw new Error("Private sources tree file changed before cleanup; preserving it.");
      await unlink(node.path);
    } else await rmdir(node.path);
  }
}

const finalizedFileArtifacts = new Set(["journal.digest", "next-catalog", "old-catalog", "held-catalog", "displaced-catalog", "rollback.json"]);
function v2LockEntries(journal: SourcesStorageJournal): Set<string> {
  const entries = new Set(["owner.json", "journal.json", "journal.digest", "next-catalog", "old-catalog", "held-catalog", "displaced-catalog", "rollback.json", "finalized.json", "finalized.digest"]);
  if (journal.nextSourcesTree !== undefined && journal.stableSourcesTree === "absent") entries.add("next-sources");
  for (const index of journal.operations.keys()) {
    entries.add(`next-${index}`);
    entries.add(`old-${index}`);
    entries.add(`displaced-${index}`);
  }
  return entries;
}
function parseFinalizedCleanup(value: unknown, expected: { root: string; token: string }): FinalizedCleanupManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Finalized v2 cleanup manifest is malformed; refusing cleanup.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasOperationKinds = Object.hasOwn(record, "operationKinds");
  const hasOperationStageKinds = Object.hasOwn(record, "operationStageKinds");
  if (keys.length < 5 || keys.length > 7 || !["version", "root", "token", "operationCount", "artifacts"].every((key) => Object.hasOwn(record, key)) ||
      keys.some((key) => !["version", "root", "token", "operationCount", "operationKinds", "operationStageKinds", "artifacts"].includes(key)) ||
      record.version !== 1 || record.root !== expected.root || record.token !== expected.token ||
      typeof record.operationCount !== "number" || !Number.isSafeInteger(record.operationCount) || record.operationCount < 0 || !Array.isArray(record.artifacts) ||
      (hasOperationKinds && (!Array.isArray(record.operationKinds) || record.operationKinds.length !== record.operationCount ||
        record.operationKinds.some((kind) => kind !== "file" && kind !== "tree"))) ||
      (hasOperationStageKinds && (!hasOperationKinds || !Array.isArray(record.operationStageKinds) || record.operationStageKinds.length !== record.operationCount ||
        record.operationStageKinds.some((kind) => kind !== "file" && kind !== "tree"))) || (!hasOperationKinds && record.operationCount > 0 &&
        record.artifacts.some((artifact) => typeof artifact === "object" && artifact !== null && /^(next|old|displaced)-/.test(String((artifact as Record<string, unknown>).name)) && (artifact as Record<string, unknown>).kind !== "source-file"))) {
    throw new Error("Finalized v2 cleanup manifest is malformed or belongs to another session.");
  }
  const operationKinds = hasOperationKinds ? record.operationKinds as Array<"file" | "tree"> : undefined;
  const operationStageKinds = hasOperationStageKinds ? record.operationStageKinds as Array<"file" | "tree"> : undefined;
  const artifacts: FinalizedCleanupArtifact[] = [];
  const names = new Set<string>();
  for (const valueArtifact of record.artifacts) {
    if (typeof valueArtifact !== "object" || valueArtifact === null || Array.isArray(valueArtifact)) throw new Error("Finalized v2 cleanup artifact is malformed.");
    const artifact = valueArtifact as Record<string, unknown>;
    const artifactKeys = Object.keys(artifact);
    if (artifactKeys.length !== 3 || !["name", "kind", "commitment"].every((key) => Object.hasOwn(artifact, key)) ||
        typeof artifact.name !== "string" || typeof artifact.commitment !== "string" || !/^[0-9a-f]{64}$/.test(artifact.commitment) || names.has(artifact.name)) {
      throw new Error("Finalized v2 cleanup artifact is malformed or duplicated.");
    }
    const indexMatch = /^(next|old|displaced)-(0|[1-9][0-9]*)$/.exec(artifact.name);
    const index = indexMatch ? Number(indexMatch[2]) : -1;
    const operationKind = indexMatch && Number.isSafeInteger(index) && index < (record.operationCount as number) ? operationKinds?.[index] ?? "file" : undefined;
    const stageKind = indexMatch && Number.isSafeInteger(index) && index < (record.operationCount as number) ? operationStageKinds?.[index] ?? operationKind : undefined;
    const permittedKinds: readonly FinalizedCleanupArtifact["kind"][] = finalizedFileArtifacts.has(artifact.name) ? ["file"]
      : artifact.name === "next-sources" ? ["source-tree"]
        : indexMatch?.[1] === "next" ? stageKind === "file" ? ["source-file"] : stageKind === "tree" ? ["source-tree"] : []
          : operationKind === "tree" ? ["source-tree"] : operationKind === "file" ? ["source-file"] : [];
    if (permittedKinds.length === 0 || !permittedKinds.includes(artifact.kind as FinalizedCleanupArtifact["kind"])) throw new Error("Finalized v2 cleanup artifact name or file/tree kind is not bound to its operation count.");
    names.add(artifact.name);
    artifacts.push({ name: artifact.name, kind: artifact.kind as FinalizedCleanupArtifact["kind"], commitment: artifact.commitment });
  }
  return { version: 1, root: expected.root, token: expected.token, operationCount: record.operationCount as number,
    ...(operationKinds ? { operationKinds } : {}), ...(operationStageKinds ? { operationStageKinds } : {}), artifacts };
}
async function captureStorageRevision(root: string): Promise<StorageRevision> {
  const catalogPath = path.join(root, "catalog.json");
  const before = await statMaybe(catalogPath);
  const catalog = await checkedFile(catalogPath);
  const after = await statMaybe(catalogPath);
  const beforeIdentity = before ? `${before.dev}:${before.ino}` : null;
  const catalogIdentity = after ? `${after.dev}:${after.ino}` : null;
  if (beforeIdentity !== catalogIdentity) throw new Error("Copi catalog changed while capturing its revision.");
  const format = catalog === undefined ? "v2" : parseStoredCatalog(JSON.parse(catalog.toString("utf8")) as unknown).version === 1 ? "v1" : "v2";
  return Object.freeze({
    root,
    catalog: catalog?.toString("base64") ?? null,
    catalogIdentity,
    format,
    tree: await tree(path.join(root, format === "v2" ? "sources" : "items"), undefined, format === "v2") ?? "absent",
  });
}
async function readFinalizedMetadata(root: string, lock: string, token: string, revision: StorageRevision): Promise<{ format: "v1" | "v2"; cleanup?: FinalizedCleanupManifest } | undefined> {
  const raw = await checkedFile(path.join(lock, "finalized.json"));
  if (!raw) {
    if (await statMaybe(path.join(lock, "finalized.digest"))) throw new Error("Finalized transaction digest exists without its record; refusing cleanup.");
    return undefined;
  }
  const digest = await checkedFile(path.join(lock, "finalized.digest"));
  if (!digest || digest.toString("utf8") !== hash(raw)) throw new Error("Finalized transaction information is missing or altered; inspect the private journal.");
  const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const catalog = revision.catalog === null ? null : hash(Buffer.from(revision.catalog, "base64"));
  if (value.version !== 1 || value.root !== root || value.token !== token || value.catalog !== catalog || value.tree !== revision.tree) throw new Error("Finalized transaction state was changed externally; refusing cleanup or rollback.");
  const cleanup = Object.hasOwn(value, "cleanup") ? parseFinalizedCleanup(value.cleanup, { root, token }) : undefined;
  return { format: revision.format, ...(cleanup ? { cleanup } : {}) };
}
async function createFinalizedCleanup(lock: string, journal: SourcesStorageJournal, rawJournal: Buffer): Promise<FinalizedCleanupManifest> {
  const allowed = v2LockEntries(journal);
  const entries = await readdir(lock);
  if (entries.some((entry) => !allowed.has(entry))) throw new Error("Unknown files in v2 sources transaction lock; refusing finalized cleanup.");
  const storedJournal = await checkedFile(path.join(lock, "journal.json"));
  const journalDigest = await checkedFile(path.join(lock, "journal.digest"));
  if (!storedJournal?.equals(rawJournal) || !journalDigest || journalDigest.toString("utf8") !== hash(rawJournal)) throw new Error("V2 journal changed before cleanup custody was recorded.");
  const artifacts: FinalizedCleanupArtifact[] = [];
  const present = new Set(entries);
  for (const name of entries) {
    if (name === "owner.json" || name === "journal.json" || name === "finalized.json" || name === "finalized.digest") continue;
    if (name === "journal.digest") {
      artifacts.push({ name, kind: "file", commitment: hash(journalDigest) });
      continue;
    }
    if (finalizedFileArtifacts.has(name)) {
      const file = await checkedFile(path.join(lock, name));
      const expected = name === "next-catalog" ? journal.newCatalog
        : name === "old-catalog" || name === "held-catalog" ? journal.oldCatalog
          : name === "displaced-catalog" ? journal.newCatalog
            : journal.token;
      if (!file || (name === "rollback.json" ? file.toString("utf8") !== expected : hash(file) !== expected)) throw new Error(`Finalized v2 cleanup artifact ${name} changed.`);
      artifacts.push({ name, kind: "file", commitment: hash(file) });
      continue;
    }
    if (name === "next-sources") {
      const actual = await sourceArtifactTreeIfPresent(path.join(lock, name), "tree");
      if (!actual || actual !== journal.nextSourcesTree) throw new Error("Finalized new sources-root stage changed.");
      artifacts.push({ name, kind: "source-tree", commitment: actual });
      continue;
    }
    const match = /^(next|old|displaced)-(0|[1-9][0-9]*)$/.exec(name);
    if (!match) throw new Error("Unknown file in v2 sources transaction lock; refusing finalized cleanup.");
    const index = Number(match[2]);
    const operation = journal.operations[index];
    if (!operation || String(index) !== match[2]) throw new Error("Unknown v2 operation index in finalized cleanup.");
    if (match[1] === "old" && operation.oldTree === null) throw new Error("New target journal unexpectedly contains an old source artifact.");
    const isParentStage = match[1] === "next" && operationIsStagedFileParent(journal, index);
    const artifactKind = isParentStage ? "tree" : operation.kind;
    const actual = await sourceArtifactTreeIfPresent(path.join(lock, name), artifactKind);
    if (actual === null) throw new Error(`Finalized v2 cleanup artifact ${name} is missing.`);
    if (isParentStage) {
      const parentStage = path.join(lock, name);
      const content = await sourceArtifactTreeIfPresent(operationStageContentPath(lock, journal, index), "file");
      if (content !== operation.newTree || JSON.stringify((await readdir(parentStage)).sort()) !== JSON.stringify([path.posix.basename(operation.target)])) {
        throw new Error(`Finalized new-file parent stage ${name} changed.`);
      }
    } else {
      const expected = match[1] === "old" ? operation.oldTree : operation.newTree;
      if (actual !== expected) throw new Error(`Finalized v2 cleanup artifact ${name} changed.`);
    }
    artifacts.push({ name, kind: `source-${artifactKind}`, commitment: actual });
  }
  if (!present.has("next-catalog") || !present.has("journal.digest") ||
      (journal.oldCatalog === null ? present.has("old-catalog") : !present.has("old-catalog"))) throw new Error("Required v2 cleanup artifacts are missing.");
  artifacts.sort((left, right) => left.name.localeCompare(right.name));
  return {
    version: 1,
    root: journal.root,
    token: journal.token,
    operationCount: journal.operations.length,
    operationKinds: journal.operations.map((operation) => operation.kind),
    ...(journal.nextSourcesTree ? { operationStageKinds: journal.operations.map((operation, index) => operationIsStagedFileParent(journal, index) ? "tree" : operation.kind) } : {}),
    artifacts,
  };
}
async function cleanupFinalizedSourcesLock(root: string, lock: string, token: string, lease: SessionLease): Promise<void> {
  const revision = await captureStorageRevision(root);
  if (revision.format !== "v2") throw new Error("V2 finalized cleanup found a legacy catalog; refusing cleanup.");
  const metadata = await readFinalizedMetadata(root, lock, token, revision);
  const manifest = metadata?.cleanup;
  if (!manifest) throw new Error("V2 finalized cleanup custody information is missing; inspect the transaction lock.");
  const expected = new Set(["owner.json", "finalized.json", "finalized.digest", ...manifest.artifacts.map((artifact) => artifact.name)]);
  const entries = await readdir(lock);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) throw new Error("Unknown or missing files in finalized v2 transaction lock; refusing cleanup.");
  for (const artifact of manifest.artifacts) {
    const target = path.join(lock, artifact.name);
    if (artifact.kind === "file") {
      const bytes = await checkedFile(target);
      if (!bytes || hash(bytes) !== artifact.commitment) throw new Error(`Finalized v2 cleanup artifact ${artifact.name} changed; preserving it.`);
    } else if (await sourceArtifactTreeIfPresent(target, artifact.kind === "source-tree" ? "tree" : "file") !== artifact.commitment) {
      throw new Error(`Finalized v2 cleanup artifact ${artifact.name} changed; preserving it.`);
    }
  }
  await assertLeaseOwner(lease);
  for (const artifact of manifest.artifacts) {
    const target = path.join(lock, artifact.name);
    if (artifact.kind === "source-tree") await removeOwnedTreeArtifact(target, artifact.commitment);
    else await unlink(target);
  }
  await unlink(path.join(lock, "finalized.json"));
  await unlink(path.join(lock, "finalized.digest"));
  await unlink(path.join(lock, "owner.json"));
  await rmdir(lock);
  await syncDirectory(root);
}
async function cleanupUnjournaledLock(root: string, lock: string, lease: SessionLease): Promise<void> {
  const expected = new Set(["owner.json", ...lease.unjournaledArtifacts.keys()]);
  const entries = await readdir(lock);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) throw new Error("Unknown files in an unjournaled transaction lock; refusing cleanup.");
  for (const [name, artifact] of lease.unjournaledArtifacts) {
    const target = path.join(lock, name);
    const stat = await statMaybe(target);
    if (!stat || !sameDirectory({ dev: stat.dev, ino: stat.ino }, artifact.identity)) throw new Error(`Unjournaled artifact ${name} changed; preserving it.`);
    const commitment = artifact.kind === "file" ? hash((await checkedFile(target)) ?? Buffer.alloc(0)) : await sourceArtifactTreeIfPresent(target, "tree");
    if (commitment !== artifact.commitment) throw new Error(`Unjournaled artifact ${name} changed; preserving it.`);
  }
  await assertLeaseOwner(lease);
  for (const [name, artifact] of lease.unjournaledArtifacts) {
    const target = path.join(lock, name);
    if (artifact.kind === "tree") await removeOwnedTreeArtifact(target, artifact.commitment);
    else await unlink(target);
  }
  await unlink(path.join(lock, "owner.json"));
  await rmdir(lock);
  await syncDirectory(root);
}
async function cleanupTransactionLock(root: string, lock: string, token: string, lease: SessionLease): Promise<void> {
  await assertLeaseOwner(lease);
  const revision = await captureStorageRevision(root);
  const finalized = await readFinalizedMetadata(root, lock, token, revision);
  if (finalized?.format === "v2") await cleanupFinalizedSourcesLock(root, lock, token, lease);
  else if (finalized?.format === "v1") { await rm(lock, { recursive: true }); await syncDirectory(root); }
  else await cleanupUnjournaledLock(root, lock, lease);
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function createPrivateTree(stage: string, files: readonly StorageFile[]): Promise<void> {
  await mkdir(stage, { mode: 0o700 });
  await chmod(stage, 0o700);
  for (const file of files) {
    let directory = stage;
    for (const segment of file.path.split("/").slice(0, -1)) {
      directory = path.join(directory, segment);
      const existing = await statMaybe(directory);
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Unsafe directory in private tree stage.");
      } else {
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
      }
    }
    const target = path.join(stage, ...file.path.split("/"));
    await writePrivate(target, file.bytes);
    await chmod(target, 0o600);
    await syncDirectory(directory);
  }
}
async function writePrivate(target: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function replacePrivate(target: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(target, "w", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function canonicalRoot(libraryDir: string, create: boolean): Promise<string | undefined> {
  const requested = path.resolve(libraryDir);
  if (requested === path.parse(requested).root) throw new Error("Refusing to use the filesystem root as a copi directory.");
  if (!await statMaybe(requested)) {
    if (!create) return undefined;
    await mkdir(requested, { recursive: true, mode: 0o700 });
  }
  await checkedDirectory(requested);
  if (create) await chmod(requested, 0o700);
  return realpath(requested);
}
export async function absentStorageRevision(libraryDir: string): Promise<StorageRevision> {
  let existing = path.resolve(libraryDir);
  const missing: string[] = [];
  while (!await statMaybe(existing)) { missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
  const root = path.join(await realpath(existing), ...missing);
  return Object.freeze({ root, catalog: null, catalogIdentity: null, format: "v2", tree: "absent" });
}

function ownerFrom(value: unknown): Owner {
  const owner = value as Partial<Owner> | null;
  if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== "number" || owner.pid < 1 || typeof owner.host !== "string" || typeof owner.token !== "string" || !itemPattern.test(owner.token)) throw new Error("Copi transaction lock owner is missing or malformed; inspect the lock before recovery.");
  return owner as Owner;
}
function alive(owner: Owner): boolean {
  if (owner.host !== os.hostname()) throw new Error("Copi transaction lock belongs to an unknown host; automatic recovery is unsafe.");
  try { process.kill(owner.pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("Cannot establish copi lock ownership; automatic recovery is unsafe.", { cause: error });
  }
}
async function readOwner(lock: string): Promise<Owner> {
  await directoryIdentity(lock);
  const bytes = await checkedFile(path.join(lock, "owner.json"));
  try { return ownerFrom(bytes ? JSON.parse(bytes.toString("utf8")) as unknown : null); } catch (error) { throw new Error("Copi transaction lock owner is missing or malformed; inspect the lock before recovery.", { cause: error }); }
}

async function directoryIdentity(target: string): Promise<DirectoryIdentity> {
  const stat = await statMaybe(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Copi session directory is missing, unsafe, or a symbolic link; refusing mutation or cleanup.");
  return { dev: stat.dev, ino: stat.ino };
}
async function storageDirectories(root: string, lock: string, checkItems = true): Promise<void> {
  await directoryIdentity(root);
  if (await realpath(root) !== root) throw new Error("Copi storage root changed through a symbolic link.");
  await directoryIdentity(lock);
  if (checkItems) await checkedDirectory(path.join(root, "items"));
}
function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
async function issueSessionLease(session: StorageSession, root: string, lock: string, owner: Owner, claim?: string): Promise<SessionLease> {
  const lease: SessionLease = {
    root, lock, owner: { ...owner }, stop: new AbortController(), pending: new Set(), unjournaledArtifacts: new Map(),
    rootIdentity: await directoryIdentity(root), lockIdentity: await directoryIdentity(lock),
    ...(claim ? { recoveryClaim: { path: claim, identity: await directoryIdentity(claim) } } : {}),
  };
  await assertLeaseOwner(lease);
  sessionLeases.set(session, lease);
  return lease;
}
async function assertLeaseOwner(lease: SessionLease): Promise<void> {
  await storageDirectories(lease.root, lease.lock, false);
  if (!sameDirectory(await directoryIdentity(lease.root), lease.rootIdentity) || !sameDirectory(await directoryIdentity(lease.lock), lease.lockIdentity)) throw new Error("Copi session root or lock directory changed; refusing mutation or cleanup.");
  const actual = await readOwner(lease.lock);
  if (actual.pid !== lease.owner.pid || actual.host !== lease.owner.host || actual.token !== lease.owner.token || actual.blocked !== lease.owner.blocked) throw new Error("Copi session lock owner changed; refusing mutation or cleanup.");
  if (lease.recoveryClaim) {
    if (!sameDirectory(await directoryIdentity(lease.recoveryClaim.path), lease.recoveryClaim.identity) || alive(actual)) throw new Error("Copi recovery lease changed or its previous owner is active; refusing recovery.");
  } else if (actual.pid !== process.pid || actual.host !== os.hostname()) throw new Error("Copi session does not belong to this process and host.");
}
function rememberUnjournaledArtifact(session: StorageSession, name: string, identity: DirectoryIdentity, kind: "file" | "tree", commitment: string): void {
  const lease = sessionLeases.get(session);
  if (!lease) throw new Error("Invalid or expired copi storage session; refusing to track lock artifacts.");
  lease.unjournaledArtifacts.set(name, { identity, kind, commitment });
}
async function rememberUnjournaledFile(session: StorageSession, name: string, target: string, bytes: Buffer | string): Promise<void> {
  const stat = await statMaybe(target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe unjournaled transaction artifact; refusing cleanup.");
  rememberUnjournaledArtifact(session, name, { dev: stat.dev, ino: stat.ino }, "file", hash(bytes));
}
function forgetUnjournaledArtifact(session: StorageSession, name: string): void {
  sessionLeases.get(session)?.unjournaledArtifacts.delete(name);
}
async function inFlightCheckpoint(callback: StorageOptions["checkpoint"], control: InFlightControl, point: StorageCheckpoint, root: string): Promise<void> {
  if (control.signal.aborted) {
    if (control.recovering) return;
    throw new Error("Copi storage session expired during its in-flight commit.");
  }
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Copi storage session expired during its in-flight checkpoint."));
    control.signal.addEventListener("abort", abort, { once: true });
  });
  try { await Promise.race([Promise.resolve().then(() => callback?.(point, root)), stopped]); }
  catch (error) {
    if (!control.recovering || !control.signal.aborted) throw error;
  } finally { control.signal.removeEventListener("abort", abort); }
}
/** @internal Generalized fixed-byte persistence adapter. Inspection/approval are enforced here too; instance-bound faults cannot disable checks. */
export class StorageTransactions {
  constructor(private readonly options: StorageOptions = {}) {}
  async run<T>(libraryDir: string, create: boolean, operation: (session: StorageSession | undefined) => Promise<T>): Promise<T> {
    const root = await canonicalRoot(libraryDir, create);
    if (!root) return operation(undefined);
    const lock = path.join(root, lockName);
    const owner: Owner = { version: 1, pid: process.pid, host: os.hostname(), token: randomUUID() };
    const deadline = Date.now() + (this.options.waitMilliseconds ?? 5_000);
    while (true) {
      // Recovery claims prevent two readers from replaying a dead writer's journal together.
      if (await statMaybe(path.join(root, `${lockName}-recovery`))) {
        if (Date.now() >= deadline) throw new Error("Copi recovery lock has an unknown owner; inspect it before continuing.");
        await delay(10); continue;
      }
      try {
        await mkdir(lock, { mode: 0o700 });
        await writePrivate(path.join(lock, "owner.json"), JSON.stringify(owner));
        await syncDirectory(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let previous: Owner;
        try { previous = await readOwner(lock); } catch (error) {
          // The owner file may still be being created by a cooperating writer.
          if (Date.now() < deadline) { await delay(10); continue; }
          throw error;
        }
        if (previous.blocked) throw new Error("Copi transaction recovery stopped after an external change; inspect its owner-only journal. No external bytes were overwritten.");
        if (!alive(previous)) {
          await this.recoverDead(root, previous); continue;
        }
        if (Date.now() >= deadline) throw new Error("Copi library is locked by an active process; retry after that operation finishes.");
        await delay(10);
      }
    }
    const session = new StorageSession(root, lock, owner.token, this.options.checkpoint);
    const lease = await issueSessionLease(session, root, lock, owner);
    try { return await operation(session); } finally {
      sessionLeases.delete(session); // Reject new calls immediately; private in-flight leases are not exposed.
      lease.stop.abort(); // Interrupt checkpoints rather than waiting for caller-owned deferred values.
      await Promise.allSettled([...lease.pending]); // Finish safe rollback before cleanup/releasing the lock.
      await assertLeaseOwner(lease);
      if (await statMaybe(path.join(lock, "journal.json"))) {
        // A failed recovery deliberately retains all evidence, and prevents readers seeing mixed state.
        const handle = await open(path.join(lock, "owner.json"), "w", 0o600);
        try { await handle.writeFile(JSON.stringify({ ...owner, blocked: true })); await handle.sync(); } finally { await handle.close(); }
      } else { await cleanupTransactionLock(root, lock, owner.token, lease); }
    }
  }
  private async recoverDead(root: string, expected: Owner): Promise<void> {
    const claim = path.join(root, `${lockName}-recovery`);
    try { await mkdir(claim, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
    const rootIdentity = await directoryIdentity(root);
    const claimIdentity = await directoryIdentity(claim);
    try {
      const lock = path.join(root, lockName);
      const current = await readOwner(lock);
      if (current.token !== expected.token || alive(current)) return;
      const session = new StorageSession(root, lock, current.token);
      const lease = await issueSessionLease(session, root, lock, current, claim);
      try {
        await session.recover(false);
        await assertLeaseOwner(lease);
        await cleanupTransactionLock(root, lock, current.token, lease);
      } finally { sessionLeases.delete(session); }
    } finally {
      if (await realpath(root) !== root || !sameDirectory(await directoryIdentity(root), rootIdentity) || !sameDirectory(await directoryIdentity(claim), claimIdentity)) throw new Error("Copi recovery claim or root changed; refusing cleanup.");
      await rm(claim, { recursive: true });
    }
  }
}

export class StorageSession {
  constructor(readonly root: string, private readonly lock: string, private readonly token: string, private readonly checkpoint?: StorageOptions["checkpoint"], private readonly checkLegacyItems = true) {}
  private async assertLease(checkItems = this.checkLegacyItems): Promise<void> {
    const lease = sessionLeases.get(this);
    if (!lease) throw new Error("Invalid or expired copi storage session; use the issued session inside its run callback.");
    if (lease.operation?.signal.aborted && !lease.operation.recovering) throw new Error("Copi storage session expired during its in-flight commit.");
    if (this.root !== lease.root || this.lock !== lease.lock || this.token !== lease.owner.token) throw new Error("Copi session identity changed; refusing mutation.");
    await assertLeaseOwner(lease);
    if (checkItems) await checkedDirectory(path.join(this.root, "items"));
    if (sessionLeases.get(this) !== lease || (lease.operation?.signal.aborted && !lease.operation.recovering)) throw new Error("Copi storage session expired while checking its lease.");
  }
  async capture(): Promise<StorageRevision> {
    await this.assertLease(false);
    const catalogPath = path.join(this.root, "catalog.json");
    const beforeCatalog = await statMaybe(catalogPath);
    const catalog = await checkedFile(catalogPath);
    const afterCatalog = await statMaybe(catalogPath);
    const beforeIdentity = beforeCatalog ? `${beforeCatalog.dev}:${beforeCatalog.ino}` : null;
    const catalogIdentity = afterCatalog ? `${afterCatalog.dev}:${afterCatalog.ino}` : null;
    if (beforeIdentity !== catalogIdentity) throw new Error("Copi catalog changed while capturing its revision.");
    const format = catalog === undefined ? "v2" : parseStoredCatalog(JSON.parse(catalog.toString("utf8")) as unknown).version === 1 ? "v1" : "v2";
    const revision = Object.freeze({
      root: this.root,
      catalog: catalog?.toString("base64") ?? null,
      catalogIdentity,
      format,
      tree: await tree(path.join(this.root, format === "v2" ? "sources" : "items"), undefined, format === "v2") ?? "absent",
    });
    await this.assertLease(format === "v1");
    return revision;
  }
  async assertRevision(expected: StorageRevision): Promise<void> {
    if (JSON.stringify(await this.capture()) !== JSON.stringify(expected)) throw new Error("Copi library changed after preparation (catalog or saved bytes); reload and review before retrying. A manual checksum mismatch must not be repaired automatically.");
  }
  async commit(expected: StorageRevision, catalog: Buffer, replacements: readonly StorageReplacement[] = [], authorization?: StorageAuthorization): Promise<void> {
    const lease = sessionLeases.get(this);
    if (!lease || lease.stop.signal.aborted) throw new Error("Invalid or expired copi storage session; refusing a new commit.");
    if (this.root !== lease.root || this.lock !== lease.lock || this.token !== lease.owner.token) throw new Error("Copi session identity changed; refusing mutation.");
    const control: InFlightControl = { signal: lease.stop.signal, recovering: false };
    const worker = new StorageSession(lease.root, lease.lock, lease.owner.token,
      (point, root) => inFlightCheckpoint(this.checkpoint, control, point, root), expected.format === "v1");
    sessionLeases.set(worker, { ...lease, pending: new Set(), operation: control });
    const operation = worker.#commitInFlight(expected, catalog, replacements, authorization);
    lease.pending.add(operation);
    try { await operation; }
    finally { lease.pending.delete(operation); sessionLeases.delete(worker); }
  }
  async #commitInFlight(expected: StorageRevision, catalog: Buffer, replacements: readonly StorageReplacement[], authorization?: StorageAuthorization): Promise<void> {
    await this.assertLease();
    const prepared = approvedStorage(catalog, replacements, authorization);
    catalog = prepared.catalog;
    replacements = prepared.replacements;
    await this.assertLease();
    await this.assertRevision(expected);
    const previousStored = expected.catalog === null ? { version: 2 as const, items: [], groups: [] } : parseStoredCatalog(JSON.parse(Buffer.from(expected.catalog, "base64").toString("utf8")) as unknown);
    const nextStored = parseStoredCatalog(JSON.parse(catalog.toString("utf8")) as unknown);
    if (expected.format !== "v2" || previousStored.version !== 2 || nextStored.version !== 2) throw new Error("Ordinary storage commits require catalog v2; explicitly migrate legacy v1 storage first.");
    assertModernCatalog(previousStored);
    assertModernCatalog(nextStored);
    await this.#commitSources(expected, previousStored, nextStored, catalog, replacements);
  }
  async #commitNewItems(expected: StorageRevision, previous: Catalog, next: Catalog, catalog: Buffer, replacements: readonly StorageReplacement[], operations: SourcesOperation[]): Promise<void> {
    if (operations.length === 0 || operations.some((operation) => operation.oldTree !== null) || next.items.length <= previous.items.length) {
      throw new Error("New-item storage requires a complete set of additions-only source operations.");
    }
    const sourcesRoot = path.join(this.root, "sources");
    const sourcesStat = await statMaybe(sourcesRoot);
    if (sourcesStat && (!sourcesStat.isDirectory() || sourcesStat.isSymbolicLink())) throw new Error("Unsafe or symbolic-link sources root for new content.");
    const sourcesWereAbsent = !sourcesStat;
    const additions = next.items.slice(previous.items.length);
    const replacementById = new Map(replacements.map((replacement) => [replacement.itemId, replacement]));
    const targets = new Set(operations.map((operation) => sourcesRelativeTarget(operation)));
    const ownedDirectories: NonNullable<SourcesStorageJournal["ownedDirectories"]> = [];
    let nextSourcesTree: string;
    let stableSourcesTreeNext: string;
    let stableSourcesTree: string;
    const nextSourcesStage = path.join(this.lock, "next-sources");

    await this.assertRevision(expected);
    if (sourcesWereAbsent) {
      const stagedFiles = additions.flatMap((item) => {
        const replacement = replacementById.get(item.id);
        if (!replacement) throw new Error("Reviewed content for a new item disappeared before staging.");
        return replacement.files.map((file) => ({ ...file, path: `${item.id}/${file.path}` }));
      });
      await createPrivateTree(nextSourcesStage, stagedFiles);
      const rootStat = await lstat(nextSourcesStage);
      ownedDirectories.push({ path: "sources", stage: "next-sources", dev: rootStat.dev, ino: rootStat.ino });
      for (const operation of operations) {
        if (operation.kind !== "file") continue;
        const parent = path.join(nextSourcesStage, operation.itemId);
        const stat = await lstat(parent);
        ownedDirectories.push({ path: `sources/${operation.itemId}`, stage: "next-sources", dev: stat.dev, ino: stat.ino });
      }
      const stagedTree = await tree(nextSourcesStage, undefined, true);
      if (!stagedTree) throw new Error("Private new sources root stage disappeared.");
      rememberUnjournaledArtifact(this, "next-sources", { dev: rootStat.dev, ino: rootStat.ino }, "tree", stagedTree);
      await this.checkpoint?.("stage-write", this.root);
      await this.assertLease(false);
      await this.checkpoint?.("stage-sync", this.root);
      await this.assertLease(false);
      const allDescriptors = additions.flatMap((item) => item.files.map((file) => ({ path: `${item.id}/${file.path}`, sha256: file.sha256 })));
      await assertTreeMatchesDescriptors(nextSourcesStage, allDescriptors);
      for (const [index, operation] of operations.entries()) {
        const item = additions.find((entry) => entry.id === operation.itemId)!;
        const stageTarget = path.join(nextSourcesStage, ...sourcesRelativeTarget(operation).split("/"));
        const replacementTree = await sourceArtifactTreeIfPresent(stageTarget, operation.kind);
        if (!replacementTree) throw new Error(`Private new ${operation.kind} target disappeared before journaling.`);
        if (operation.kind === "file") await assertTreeMatchesDescriptors(path.dirname(stageTarget), item.files);
        else await assertTreeMatchesDescriptors(stageTarget, item.files);
        operations[index] = { ...operation, newTree: replacementTree };
      }
      nextSourcesTree = stagedTree;
      stableSourcesTreeNext = await tree(nextSourcesStage, undefined, true, targets) ?? "absent";
      stableSourcesTree = "absent";
    } else {
      stableSourcesTree = await tree(sourcesRoot, undefined, true) ?? "absent";
      const stagedByItem = new Map<string, string>();
      for (const [index, operation] of operations.entries()) {
        const stage = path.join(this.lock, `next-${index}`);
        const replacement = replacementById.get(operation.itemId);
        const item = additions.find((entry) => entry.id === operation.itemId);
        if (!replacement || !item) throw new Error("Reviewed new item or bytes disappeared before staging.");
        await this.assertLease(false);
        if (operation.kind === "file") {
          await createPrivateTree(stage, replacement.files);
          const stat = await lstat(stage);
          ownedDirectories.push({ path: `sources/${item.id}`, stage: `next-${index}`, dev: stat.dev, ino: stat.ino });
          await assertTreeMatchesDescriptors(stage, item.files);
        } else {
          await createPrivateTree(stage, replacement.files);
          await assertTreeMatchesDescriptors(stage, item.files);
        }
        const stageStat = await lstat(stage);
        const stagedTree = await tree(stage, undefined, true);
        if (!stagedTree) throw new Error("Private new item stage disappeared.");
        rememberUnjournaledArtifact(this, `next-${index}`, { dev: stageStat.dev, ino: stageStat.ino }, "tree", stagedTree);
        await this.checkpoint?.("stage-write", this.root);
        await this.assertLease(false);
        await this.checkpoint?.("stage-sync", this.root);
        await this.assertLease(false);
        const contentPath = operation.kind === "file" ? path.join(stage, path.posix.basename(operation.target)) : stage;
        const replacementTree = await sourceArtifactTreeIfPresent(contentPath, operation.kind);
        if (!replacementTree) throw new Error(`Private new ${operation.kind} target disappeared before journaling.`);
        operations[index] = { ...operation, newTree: replacementTree };
        stagedByItem.set(item.id, stage);
      }
      const substitutions = new Map(operations.map((operation) => [operation.itemId, stagedByItem.get(operation.itemId)!]));
      const replacementsBySourcesPath = new Map(operations.map((operation) => [operation.itemId, substitutions.get(operation.itemId)!]));
      const mapped = new Map<string, string>();
      for (const operation of operations) mapped.set(operation.itemId, replacementsBySourcesPath.get(operation.itemId)!);
      const plannedSources = await tree(sourcesRoot, mapped, true);
      const plannedStable = await tree(sourcesRoot, mapped, true, targets);
      if (!plannedSources || !plannedStable) throw new Error("Cannot compute the checked new sources revision.");
      nextSourcesTree = plannedSources;
      stableSourcesTreeNext = plannedStable;
    }
    await this.assertRevision(expected);

    const catalogStage = path.join(this.lock, "next-catalog");
    await this.assertLease(false);
    const catalogHandle = await open(catalogStage, "wx", 0o600);
    try {
      const catalogStat = await catalogHandle.stat();
      rememberUnjournaledArtifact(this, "next-catalog", { dev: catalogStat.dev, ino: catalogStat.ino }, "file", hash(catalog));
      await catalogHandle.writeFile(catalog);
      await this.checkpoint?.("stage-write", this.root);
      await this.assertLease(false);
      await this.checkpoint?.("stage-sync", this.root);
      await this.assertLease(false);
      await catalogHandle.sync();
    } finally { await catalogHandle.close(); }
    const stagedCatalog = await checkedFile(catalogStage);
    if (!stagedCatalog || !stagedCatalog.equals(catalog)) throw new Error("Staged catalog changed before new sources swap; refusing commit.");
    await this.assertLease(false);
    if (expected.catalog !== null) {
      const oldCatalogPath = path.join(this.lock, "old-catalog");
      const oldCatalogBytes = Buffer.from(expected.catalog, "base64");
      await writePrivate(oldCatalogPath, oldCatalogBytes);
      await rememberUnjournaledFile(this, "old-catalog", oldCatalogPath, oldCatalogBytes);
    }
    const journal: SourcesStorageJournal = {
      version: 2,
      root: this.root,
      token: this.token,
      oldCatalog: expected.catalog === null ? null : hash(Buffer.from(expected.catalog, "base64")),
      newCatalog: hash(catalog),
      stableSourcesTree,
      stableSourcesTreeNext,
      nextSourcesTree,
      ownedDirectories,
      operations,
    };
    const journalBytes = Buffer.from(JSON.stringify(journal));
    const journalTemp = path.join(this.lock, "journal.tmp");
    await writePrivate(journalTemp, journalBytes);
    await rememberUnjournaledFile(this, "journal.tmp", journalTemp, journalBytes);
    await rename(journalTemp, path.join(this.lock, "journal.json"));
    forgetUnjournaledArtifact(this, "journal.tmp");
    await writePrivate(path.join(this.lock, "journal.digest"), hash(journalBytes));
    await syncDirectory(this.lock);
    try {
      await this.checkpoint?.("journal", this.root);
      await this.assertLease(false);
      const rawJournal = await checkedFile(path.join(this.lock, "journal.json"));
      const journalDigest = await checkedFile(path.join(this.lock, "journal.digest"));
      if (!rawJournal?.equals(journalBytes) || !journalDigest || journalDigest.toString("utf8") !== hash(rawJournal)) throw new Error("Sources journal or raw digest changed before new-target swap; refusing commit.");
      await this.assertRevision(expected);
      if ((await tree(sourcesRoot, undefined, true) ?? "absent") !== expected.tree) throw new Error("Sources changed after capture; refusing new-target swap.");
      validateSourcesJournalTargets(journal, previous, next);

      if (sourcesWereAbsent) {
        if (await statMaybe(sourcesRoot)) throw new Error("A sources root appeared after the new-target review; refusing to adopt it.");
        if (await sourceArtifactTreeIfPresent(nextSourcesStage, "tree") !== journal.nextSourcesTree) throw new Error("Private new sources root changed after journaling.");
        for (const directory of ownedDirectories) {
          const stagedPath = directory.path === "sources" ? nextSourcesStage : path.join(nextSourcesStage, ...directory.path.slice("sources/".length).split("/"));
          await verifyOwnedDirectory(stagedPath, directory);
        }
        await renameNewSourcesStageExclusive(this.root, nextSourcesStage, sourcesRoot);
        for (const directory of ownedDirectories) {
          const livePath = path.join(this.root, ...directory.path.split("/"));
          await verifyOwnedDirectory(livePath, directory);
        }
        await this.checkpoint?.("new-renamed", this.root);
        await this.assertLease(false);
      } else {
        for (const [index, operation] of operations.entries()) {
          const item = next.items.find((entry) => entry.id === operation.itemId)!;
          const stage = path.join(this.lock, `next-${index}`);
          const target = path.join(this.root, ...operation.target.split("/"));
          const targetParent = path.dirname(target);
          await this.checkpoint?.("before-swap", this.root);
          await this.assertLease(false);
          await assertNewSourcesTargetVacant(this.root, item);
          if (operation.kind === "file") {
            const directory = ownedSourceDirectory(journal, `sources/${item.id}`);
            if (!directory) throw new Error("New file target has no journaled private parent directory.");
            await verifyOwnedDirectory(stage, directory);
            if (await sourceArtifactTreeIfPresent(path.join(stage, path.posix.basename(operation.target)), "file") !== operation.newTree) throw new Error("Private new file stage changed before installation.");
            await renameNewSourcesStageExclusive(this.root, stage, targetParent);
            await verifyOwnedDirectory(targetParent, directory);
          } else {
            if (await sourceArtifactTreeIfPresent(stage, "tree") !== operation.newTree) throw new Error("Private new tree stage changed before installation.");
            await renameNewSourcesStageExclusive(this.root, stage, target);
          }
          const installed = await checkedSourcesOperationTarget(this.root, operation);
          if (!installed || await sourceArtifactTreeIfPresent(installed, operation.kind) !== operation.newTree) throw new Error("New sources target changed during its installation.");
          await this.checkpoint?.("new-renamed", this.root);
          await this.assertLease(false);
        }
      }
      await this.checkpoint?.("before-catalog", this.root);
      await this.assertLease(false);
      if ((await tree(sourcesRoot, undefined, true) ?? "absent") !== journal.nextSourcesTree ||
          (await tree(sourcesRoot, undefined, true, targets) ?? "absent") !== journal.stableSourcesTreeNext) {
        throw new Error("Sources tree, new target, or adjacent/unregistered inode changed before catalog update.");
      }
      const actual = await checkedFile(path.join(this.root, "catalog.json"));
      if ((actual ? hash(actual) : null) !== journal.oldCatalog) throw new Error("Catalog changed during new-item commit; refusing overwrite.");
      for (const operation of operations) {
        const target = await checkedSourcesOperationTarget(this.root, operation);
        if (!target || await sourceArtifactTreeIfPresent(target, operation.kind) !== operation.newTree) throw new Error("New registered content changed before catalog update.");
        if (operation.kind === "tree") await assertTreeMatchesDescriptors(target, next.items.find((item) => item.id === operation.itemId)!.files);
        else {
          const parent = path.dirname(target);
          const directory = ownedSourceDirectory(journal, `sources/${operation.itemId}`);
          if (!directory) throw new Error("New file target parent is not owned by this journal.");
          await verifyOwnedDirectory(parent, directory);
          if (JSON.stringify(await readdir(parent)) !== JSON.stringify([path.posix.basename(target)])) throw new Error("New file target parent contains an unknown artifact.");
        }
      }
      if (!(await checkedFile(catalogStage))?.equals(catalog)) throw new Error("Staged catalog changed before commit.");
      const catalogPath = path.join(this.root, "catalog.json");
      const heldPath = path.join(this.lock, "held-catalog");
      const beforeCatalogStat = await statMaybe(catalogPath);
      if (beforeCatalogStat && expected.catalogIdentity !== `${beforeCatalogStat.dev}:${beforeCatalogStat.ino}`) throw new Error("Original catalog inode changed before it was held.");
      if (await statMaybe(heldPath)) throw new Error("Unexpected held catalog; refusing overwrite.");
      if (actual) await rename(catalogPath, heldPath);
      await this.checkpoint?.("catalog-held", this.root);
      await this.assertLease(false);
      const held = await checkedFile(heldPath);
      if ((held ? hash(held) : null) !== journal.oldCatalog) throw new Error("Original catalog changed in its held inode; retained external bytes.");
      const heldStat = await statMaybe(heldPath);
      if (heldStat && expected.catalogIdentity !== `${heldStat.dev}:${heldStat.ino}`) throw new Error("Original held catalog inode changed; retained it.");
      await link(catalogStage, catalogPath);
      await this.checkpoint?.("catalog-renamed", this.root);
      await this.assertLease(false);
      await this.checkpoint?.("directory-sync", this.root);
      await this.assertLease(false);
      for (const operation of operations) {
        const target = await checkedSourcesOperationTarget(this.root, operation);
        if (target) await syncDirectory(path.dirname(target));
      }
      await syncDirectory(this.root);
      await this.checkpoint?.("committed", this.root);
      await this.assertLease(false);
      if ((await tree(sourcesRoot, undefined, true) ?? "absent") !== journal.nextSourcesTree ||
          (await tree(sourcesRoot, undefined, true, targets) ?? "absent") !== journal.stableSourcesTreeNext ||
          hash((await checkedFile(catalogPath))!) !== journal.newCatalog) throw new Error("New sources library changed during commit finalization.");
      const heldAtFinish = await checkedFile(heldPath);
      const heldAtFinishStat = await statMaybe(heldPath);
      if ((heldAtFinish ? hash(heldAtFinish) : null) !== journal.oldCatalog || (heldAtFinishStat && expected.catalogIdentity !== `${heldAtFinishStat.dev}:${heldAtFinishStat.ino}`)) throw new Error("Original held catalog changed during finalization; retaining external bytes.");
      const cleanup = await createFinalizedCleanup(this.lock, journal, journalBytes);
      await this.markFinalized(cleanup);
      await rm(path.join(this.lock, "journal.json"));
      await this.checkpoint?.("finalized", this.root);
    } catch (error) {
      const operation = sessionLeases.get(this)?.operation;
      if (operation) operation.recovering = true;
      try { await this.recover(true); } catch (recoveryError) { throw new Error("Copi new-item transaction could not safely recover an external change; retained private journal and source bytes.", { cause: new AggregateError([error, recoveryError]) }); }
      throw error;
    }
  }
  async #commitSources(expected: StorageRevision, previous: Catalog, next: Catalog, catalog: Buffer, replacements: readonly StorageReplacement[]): Promise<void> {
    const operations = await validateSourcesTransition(this.root, previous, next, replacements);
    if (next.items.length > previous.items.length) {
      await this.#commitNewItems(expected, previous, next, catalog, replacements, operations);
      return;
    }
    const sourcesRoot = path.join(this.root, "sources");
    const targets = new Set(operations.map((operation) => operation.target.slice("sources/".length)));
    const stableSourcesTree = operations.length > 0
      ? await tree(sourcesRoot, undefined, true, targets)
      : await tree(sourcesRoot, undefined, true);
    if (stableSourcesTree === null) throw new Error("Registered sources root is missing.");
    await this.assertRevision(expected);

    for (const [index, operation] of operations.entries()) {
      const target = operation.kind === "file"
        ? await checkedSourceFileTarget(this.root, operation.target)
        : await checkedSourceTreeTarget(this.root, operation.target);
      if (!target) throw new Error(`Registered sources ${operation.kind} disappeared before staging.`);
      const stage = path.join(this.lock, `next-${index}`);
      const replacement = replacements.find((entry) => entry.itemId === operation.itemId);
      const nextItem = next.items.find((item) => item.id === operation.itemId);
      if (!replacement || !nextItem) throw new Error("Registered sources replacement disappeared before staging.");
      await this.assertLease(false);
      if (operation.kind === "file") {
        const handle = await open(stage, "wx", 0o600);
        const stageBytes = replacement.files[0]!.bytes;
        try {
          const stageStat = await handle.stat();
          rememberUnjournaledArtifact(this, `next-${index}`, { dev: stageStat.dev, ino: stageStat.ino }, "file", hash(stageBytes));
          await handle.writeFile(stageBytes);
          await this.checkpoint?.("stage-write", this.root);
          await this.assertLease(false);
          await this.checkpoint?.("stage-sync", this.root);
          await this.assertLease(false);
          await handle.sync();
        } finally { await handle.close(); }
        const staged = await checkedFile(stage);
        if (!staged || !staged.equals(stageBytes)) throw new Error("Staged sources bytes changed from the fixed inspected bytes; refusing save.");
      } else {
        await createPrivateTree(stage, replacement.files);
        await assertTreeMatchesDescriptors(stage, nextItem.files);
        const stageStat = await lstat(stage);
        const stagedTree = await tree(stage, undefined, true);
        if (stagedTree === null) throw new Error("Private sources tree stage disappeared.");
        rememberUnjournaledArtifact(this, `next-${index}`, { dev: stageStat.dev, ino: stageStat.ino }, "tree", stagedTree);
        await this.checkpoint?.("stage-write", this.root);
        await this.assertLease(false);
        await this.checkpoint?.("stage-sync", this.root);
        await this.assertLease(false);
        await assertTreeMatchesDescriptors(stage, nextItem.files);
      }
      const oldTree = await sourceArtifactTreeIfPresent(target, operation.kind);
      const newTree = await sourceArtifactTreeIfPresent(stage, operation.kind);
      if (oldTree === null || newTree === null) throw new Error(`Registered sources ${operation.kind} or its private stage disappeared.`);
      operations[index] = { ...operation, oldTree, newTree };
    }

    const catalogStage = path.join(this.lock, "next-catalog");
    await this.assertLease(false);
    const catalogHandle = await open(catalogStage, "wx", 0o600);
    try {
      const catalogStat = await catalogHandle.stat();
      rememberUnjournaledArtifact(this, "next-catalog", { dev: catalogStat.dev, ino: catalogStat.ino }, "file", hash(catalog));
      await catalogHandle.writeFile(catalog);
      await this.checkpoint?.("stage-write", this.root);
      await this.assertLease(false);
      await this.checkpoint?.("stage-sync", this.root);
      await this.assertLease(false);
      await catalogHandle.sync();
    } finally { await catalogHandle.close(); }
    const stagedCatalog = await checkedFile(catalogStage);
    if (!stagedCatalog || !stagedCatalog.equals(catalog)) throw new Error("Staged catalog changed before sources swap; refusing commit.");
    await this.assertLease(false);
    if (expected.catalog !== null) {
      const oldCatalogPath = path.join(this.lock, "old-catalog");
      const oldCatalogBytes = Buffer.from(expected.catalog, "base64");
      await writePrivate(oldCatalogPath, oldCatalogBytes);
      await rememberUnjournaledFile(this, "old-catalog", oldCatalogPath, oldCatalogBytes);
    }
    const journal: SourcesStorageJournal = {
      version: 2,
      root: this.root,
      token: this.token,
      oldCatalog: expected.catalog === null ? null : hash(Buffer.from(expected.catalog, "base64")),
      newCatalog: hash(catalog),
      stableSourcesTree,
      operations,
    };
    const journalBytes = Buffer.from(JSON.stringify(journal));
    const journalTemp = path.join(this.lock, "journal.tmp");
    await writePrivate(journalTemp, journalBytes);
    await rememberUnjournaledFile(this, "journal.tmp", journalTemp, journalBytes);
    await rename(journalTemp, path.join(this.lock, "journal.json"));
    forgetUnjournaledArtifact(this, "journal.tmp");
    await writePrivate(path.join(this.lock, "journal.digest"), hash(journalBytes));
    await syncDirectory(this.lock);
    try {
      await this.checkpoint?.("journal", this.root);
      await this.assertLease(false);
      const rawJournal = await checkedFile(path.join(this.lock, "journal.json"));
      const journalDigest = await checkedFile(path.join(this.lock, "journal.digest"));
      if (!rawJournal || !rawJournal.equals(journalBytes) || !journalDigest || journalDigest.toString("utf8") !== hash(rawJournal)) throw new Error("Sources journal or raw digest changed before swap; refusing commit.");
      await this.assertRevision(expected);
      const previousSourcesTree = await tree(sourcesRoot, undefined, true);
      if (previousSourcesTree !== expected.tree) throw new Error("Sources changed after capture; refusing swap.");
      const stageByTarget = new Map(operations.map((operation, index) => [operation.target.slice("sources/".length), path.join(this.lock, `next-${index}`)]));
      const expectedNextTree = await tree(sourcesRoot, stageByTarget, true);
      if (expectedNextTree === null) throw new Error("Cannot compute the expected sources tree.");
      validateSourcesJournalTargets(journal, previous, next);

      for (const [index, operation] of operations.entries()) {
        const target = operation.kind === "file"
          ? await checkedSourceFileTarget(this.root, operation.target)
          : await checkedSourceTreeTarget(this.root, operation.target);
        if (!target) throw new Error(`Registered sources ${operation.kind} disappeared during commit.`);
        const oldPath = path.join(this.lock, `old-${index}`);
        await this.checkpoint?.("before-swap", this.root);
        await this.assertLease(false);
        if (await sourceArtifactTreeIfPresent(target, operation.kind) !== operation.oldTree) throw new Error(`Registered sources ${operation.kind} changed during commit; refusing overwrite.`);
        await rename(target, oldPath);
        await this.checkpoint?.("old-renamed", this.root);
        await this.assertLease(false);
        if (await sourceArtifactTreeIfPresent(oldPath, operation.kind) !== operation.oldTree) throw new Error("Original sources inode changed after rename; retained external bytes instead of deleting them.");
        if (await statMaybe(target)) throw new Error(`A source ${operation.kind} appeared at the registered target during commit.`);
        const stage = path.join(this.lock, `next-${index}`);
        if (await sourceArtifactTreeIfPresent(stage, operation.kind) !== operation.newTree) throw new Error("Private sources stage changed during commit.");
        await rename(stage, target);
        await this.checkpoint?.("new-renamed", this.root);
        await this.assertLease(false);
      }
      await this.checkpoint?.("before-catalog", this.root);
      await this.assertLease(false);
      if (await tree(sourcesRoot, undefined, true) !== expectedNextTree || await tree(sourcesRoot, undefined, true, targets) !== stableSourcesTree) throw new Error("Sources tree or an adjacent/unregistered inode changed during swap; refusing catalog update.");
      const actual = await checkedFile(path.join(this.root, "catalog.json"));
      if ((actual ? hash(actual) : null) !== journal.oldCatalog) throw new Error("Catalog changed during sources commit; refusing overwrite.");
      for (const [index, operation] of operations.entries()) {
        const target = operation.kind === "file"
          ? await checkedSourceFileTarget(this.root, operation.target)
          : await checkedSourceTreeTarget(this.root, operation.target);
        if (!target || await sourceArtifactTreeIfPresent(target, operation.kind) !== operation.newTree) throw new Error(`Registered sources ${operation.kind} changed before catalog update.`);
        if (await sourceArtifactTreeIfPresent(path.join(this.lock, `old-${index}`), operation.kind) !== operation.oldTree) throw new Error("Original sources inode changed; retaining the external bytes.");
      }
      if (!(await checkedFile(catalogStage))?.equals(catalog)) throw new Error("Staged catalog changed before commit.");
      const catalogPath = path.join(this.root, "catalog.json");
      const heldPath = path.join(this.lock, "held-catalog");
      const beforeCatalogStat = await statMaybe(catalogPath);
      if (beforeCatalogStat && expected.catalogIdentity !== `${beforeCatalogStat.dev}:${beforeCatalogStat.ino}`) throw new Error("Original catalog inode changed before it was held.");
      if (await statMaybe(heldPath)) throw new Error("Unexpected held catalog; refusing overwrite.");
      if (actual) await rename(catalogPath, heldPath);
      await this.checkpoint?.("catalog-held", this.root);
      await this.assertLease(false);
      const held = await checkedFile(heldPath);
      if ((held ? hash(held) : null) !== journal.oldCatalog) throw new Error("Original catalog changed in its held inode; retained external bytes.");
      const heldStat = await statMaybe(heldPath);
      if (heldStat && expected.catalogIdentity !== `${heldStat.dev}:${heldStat.ino}`) throw new Error("Original held catalog inode changed; retained it.");
      await link(catalogStage, catalogPath);
      await this.checkpoint?.("catalog-renamed", this.root);
      await this.assertLease(false);
      await this.checkpoint?.("directory-sync", this.root);
      await this.assertLease(false);
      for (const operation of operations) {
        const target = operation.kind === "file"
          ? await checkedSourceFileTarget(this.root, operation.target)
          : await checkedSourceTreeTarget(this.root, operation.target);
        if (target) await syncDirectory(path.dirname(target));
      }
      await syncDirectory(this.root);
      await this.checkpoint?.("committed", this.root);
      await this.assertLease(false);
      if (await tree(sourcesRoot, undefined, true) !== expectedNextTree || await tree(sourcesRoot, undefined, true, targets) !== stableSourcesTree || hash((await checkedFile(catalogPath))!) !== journal.newCatalog) throw new Error("Sources library changed during commit finalization.");
      for (const [index, operation] of operations.entries()) if (await sourceArtifactTreeIfPresent(path.join(this.lock, `old-${index}`), operation.kind) !== operation.oldTree) throw new Error("Original sources inode changed during finalization; retaining external bytes.");
      const heldAtFinish = await checkedFile(heldPath);
      const heldAtFinishStat = await statMaybe(heldPath);
      if ((heldAtFinish ? hash(heldAtFinish) : null) !== journal.oldCatalog || (heldAtFinishStat && expected.catalogIdentity !== `${heldAtFinishStat.dev}:${heldAtFinishStat.ino}`)) throw new Error("Original held catalog changed during finalization; retaining external bytes.");
      const cleanup = await createFinalizedCleanup(this.lock, journal, journalBytes);
      await this.markFinalized(cleanup);
      await rm(path.join(this.lock, "journal.json"));
      await this.checkpoint?.("finalized", this.root);
    } catch (error) {
      const operation = sessionLeases.get(this)?.operation;
      if (operation) operation.recovering = true;
      try { await this.recover(true); } catch (recoveryError) { throw new Error("Copi sources transaction could not safely recover an external change; retained private journal and source bytes.", { cause: new AggregateError([error, recoveryError]) }); }
      throw error;
    }
  }
  private async markFinalized(cleanup?: FinalizedCleanupManifest): Promise<void> {
    const revision = await this.capture();
    const value = {
      version: 1,
      root: this.root,
      token: this.token,
      catalog: revision.catalog === null ? null : hash(Buffer.from(revision.catalog, "base64")),
      tree: revision.tree,
      ...(cleanup ? { cleanup } : {}),
    };
    const record = Buffer.from(JSON.stringify(value));
    const finalizedPath = path.join(this.lock, "finalized.json");
    const digestPath = path.join(this.lock, "finalized.digest");
    const existing = await checkedFile(finalizedPath);
    if (existing) {
      const existingDigest = await checkedFile(digestPath);
      if (!existingDigest || existingDigest.toString("utf8") !== hash(existing)) throw new Error("Existing finalized transaction information is altered; refusing replacement.");
      const oldValue = JSON.parse(existing.toString("utf8")) as Record<string, unknown>;
      if (oldValue.version !== value.version || oldValue.root !== value.root || oldValue.token !== value.token || oldValue.catalog !== value.catalog || oldValue.tree !== value.tree) throw new Error("Existing finalized transaction state changed; refusing replacement.");
      if (Object.hasOwn(oldValue, "cleanup")) {
        if (JSON.stringify(oldValue.cleanup) !== JSON.stringify(cleanup)) throw new Error("Existing finalized cleanup custody record changed.");
        return;
      }
      if (!cleanup) return;
      await replacePrivate(finalizedPath, record);
      await replacePrivate(digestPath, hash(record));
    } else {
      await writePrivate(finalizedPath, record);
      await writePrivate(digestPath, hash(record));
    }
    await syncDirectory(this.lock);
  }
  private async verifyFinalized(): Promise<boolean> {
    const raw = await checkedFile(path.join(this.lock, "finalized.json"));
    if (!raw) return false;
    const digest = await checkedFile(path.join(this.lock, "finalized.digest"));
    if (!digest || digest.toString("utf8") !== hash(raw)) throw new Error("Finalized transaction information is missing or altered; inspect the private journal.");
    const value = JSON.parse(raw.toString("utf8")) as { version?: unknown; root?: unknown; token?: unknown; catalog?: unknown; tree?: unknown };
    const revision = await this.capture();
    const catalog = revision.catalog === null ? null : hash(Buffer.from(revision.catalog, "base64"));
    if (value.version !== 1 || value.root !== this.root || value.token !== this.token || value.catalog !== catalog || value.tree !== revision.tree) throw new Error("Finalized transaction state was changed externally; refusing cleanup or rollback.");
    return true;
  }
  private async recoverNewSources(journal: SourcesStorageJournal, rollback: boolean, rawJournal: Buffer, previous: Catalog | null, nextCatalog: Catalog, rawOld: Buffer | undefined): Promise<void> {
    const rollbackMarker = await checkedFile(path.join(this.lock, "rollback.json"));
    if (rollbackMarker) {
      if (rollbackMarker.toString("utf8") !== this.token) throw new Error("Invalid new-target rollback marker; refusing recovery.");
      rollback = true;
    }
    const catalogPath = path.join(this.root, "catalog.json");
    const currentCatalog = await checkedFile(catalogPath);
    const currentHash = currentCatalog ? hash(currentCatalog) : null;
    const heldPath = path.join(this.lock, "held-catalog");
    const held = await checkedFile(heldPath);
    const heldHash = held ? hash(held) : null;
    if (held && heldHash !== journal.oldCatalog) throw new Error("Original v2 catalog changed in its held inode; refusing new-target recovery.");
    const catalogInTransit = currentHash === null && journal.oldCatalog !== null && heldHash === journal.oldCatalog;
    if (currentHash !== journal.oldCatalog && currentHash !== journal.newCatalog && !catalogInTransit) throw new Error("Catalog changed externally; refusing new-target recovery.");
    const committed = currentHash === journal.newCatalog;
    if (committed && journal.oldCatalog !== null && heldHash !== journal.oldCatalog) throw new Error("Original v2 held catalog is missing; refusing new-target recovery.");
    const displacedCatalog = await checkedFile(path.join(this.lock, "displaced-catalog"));
    if (displacedCatalog && hash(displacedCatalog) !== journal.newCatalog) throw new Error("Displaced v2 catalog was changed externally.");
    if (committed && (!currentCatalog || hash(currentCatalog) !== journal.newCatalog)) throw new Error("Current new-item catalog does not match its journal commitment.");

    const sourcesRoot = path.join(this.root, "sources");
    const lockEntries = await readdir(this.lock);
    if (journal.stableSourcesTree === "absent" && lockEntries.some((entry) => /^next-(?:0|[1-9][0-9]*)$/.test(entry))) {
      throw new Error("Unknown per-item stage exists alongside the journaled new sources-root stage.");
    }
    const targets = new Set(journal.operations.map(sourcesRelativeTarget));
    const stageSourcesRoot = path.join(this.lock, "next-sources");
    const stagedSourcesCommitment = await sourceArtifactTreeIfPresent(stageSourcesRoot, "tree");
    if (stagedSourcesCommitment !== null && stagedSourcesCommitment !== journal.nextSourcesTree) throw new Error("Private new sources root stage is altered or unsafe.");
    const sourcesRootIdentity = ownedSourceDirectory(journal, "sources");
    if (journal.stableSourcesTree === "absent" && !sourcesRootIdentity) throw new Error("New sources root is missing its journaled identity.");
    if (sourcesRootIdentity) {
      if (stagedSourcesCommitment !== null) await verifyOwnedDirectory(stageSourcesRoot, sourcesRootIdentity);
      await verifyOwnedDirectory(sourcesRoot, sourcesRootIdentity, true);
    } else if (!await checkedDirectory(sourcesRoot)) {
      throw new Error("Existing sources root disappeared during new-item recovery.");
    }
    for (const directory of journal.ownedDirectories ?? []) {
      const staged = ownedDirectoryStagePath(this.lock, directory);
      const stagedStat = await statMaybe(staged);
      if (stagedStat) await verifyOwnedDirectory(staged, directory);
      const live = path.join(this.root, ...directory.path.split("/"));
      const liveStat = await statMaybe(live);
      if (liveStat) await verifyOwnedDirectory(live, directory);
      if (stagedStat && liveStat) throw new Error(`Owned source directory ${directory.path} exists both in stage and live storage.`);
    }

    const stableNow = await tree(sourcesRoot, undefined, true, targets) ?? "absent";
    const currentSourcesTree = await tree(sourcesRoot, undefined, true) ?? "absent";
    const states: Array<{ operation: SourcesOperation; current: string | null; stage: string | null; displaced: string | null }> = [];
    for (const [index, operation] of journal.operations.entries()) {
      const target = path.join(this.root, ...operation.target.split("/"));
      const checkedTarget = await checkedSourcesOperationTarget(this.root, operation, true);
      const current = checkedTarget ? await sourceArtifactTreeIfPresent(checkedTarget, operation.kind) : null;
      const backupPath = path.join(this.lock, `old-${index}`);
      if (await statMaybe(backupPath)) throw new Error("A new-item journal unexpectedly contains an old source backup.");
      const stagedContent = operationStageContentPath(this.lock, journal, index);
      const stage = await sourceArtifactTreeIfPresent(stagedContent, operation.kind);
      const displacedPath = path.join(this.lock, `displaced-${index}`);
      const displaced = await sourceArtifactTreeIfPresent(displacedPath, operation.kind);
      if (current !== null && current !== operation.newTree) throw new Error("New registered target was externally added or changed; preserving it.");
      if (stage !== null && stage !== operation.newTree) throw new Error("Private new-target stage is altered or unsafe.");
      if (displaced !== null && displaced !== operation.newTree) throw new Error("Displaced new-target bytes were altered externally.");
      if (Number(current === operation.newTree) + Number(stage === operation.newTree) + Number(displaced === operation.newTree) !== 1) {
        throw new Error("New-target recovery does not have exactly one checked current, staged, or displaced content inode.");
      }
      if (committed && !rollback && current !== operation.newTree) throw new Error("Committed new source content is missing or altered.");
      if (operationIsStagedFileParent(journal, index) && stage !== null) {
        const parentStage = operationStageContainerPath(this.lock, journal, index);
        const parentIdentity = ownedSourceDirectory(journal, `sources/${operation.itemId}`);
        if (!parentIdentity) throw new Error("New file stage has no owned parent-directory identity.");
        await verifyOwnedDirectory(parentStage, parentIdentity);
        if (JSON.stringify((await readdir(parentStage)).sort()) !== JSON.stringify([path.posix.basename(operation.target)])) {
          throw new Error("Private new-file stage contains an unknown artifact.");
        }
      }
      if (operation.kind === "file" && stage !== null && journal.stableSourcesTree === "absent") {
        const stagedParent = path.dirname(stagedContent);
        if (JSON.stringify(await readdir(stagedParent).then((names) => names.sort())) !== JSON.stringify([path.posix.basename(operation.target)])) {
          throw new Error("Private new-file stage contains an unknown artifact.");
        }
      }
      const item = nextCatalog.items.find((entry) => entry.id === operation.itemId);
      if (!item) throw new Error("New-target journal references a missing catalog item.");
      const contentPath = current === operation.newTree ? checkedTarget! : stage === operation.newTree ? stagedContent : displacedPath;
      if (operation.kind === "file") {
        if (item.files.length !== 1 || hash(await readFile(contentPath)) !== item.files[0]!.sha256) throw new Error("New file bytes do not match the fixed catalog descriptor.");
      } else await assertTreeMatchesDescriptors(contentPath, item.files);
      states.push({ operation, current, stage, displaced });
    }

    if (await this.verifyFinalized()) {
      if (!committed || rollback || currentSourcesTree !== journal.nextSourcesTree || stableNow !== journal.stableSourcesTreeNext ||
          states.some((state) => state.current !== state.operation.newTree)) throw new Error("Finalized new-item transaction no longer matches its committed source tree.");
      await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
      await rm(path.join(this.lock, "journal.json"));
      return;
    }
    if (committed && !rollback) {
      if (currentSourcesTree !== journal.nextSourcesTree || stableNow !== journal.stableSourcesTreeNext ||
          states.some((state) => state.current !== state.operation.newTree)) throw new Error("Unregistered or adjacent sources changed; refusing to finalize new-item commit.");
      await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
      await rm(path.join(this.lock, "journal.json"));
      return;
    }

    if (!rollbackMarker) { await writePrivate(path.join(this.lock, "rollback.json"), this.token); await syncDirectory(this.lock); }
    await this.checkpoint?.("rollback-started", this.root);
    for (const state of states) {
      const { operation } = state;
      await this.assertLease(false);
      const checkedTarget = await checkedSourcesOperationTarget(this.root, operation, true);
      if (checkedTarget && await sourceArtifactTreeIfPresent(checkedTarget, operation.kind) === operation.newTree) {
        const index = journal.operations.indexOf(operation);
        const displacedPath = path.join(this.lock, `displaced-${index}`);
        if (await statMaybe(displacedPath)) throw new Error("Unexpected displaced new-target artifact during rollback.");
        await rename(checkedTarget, displacedPath);
        if (await sourceArtifactTreeIfPresent(displacedPath, operation.kind) !== operation.newTree) throw new Error("New target changed while being displaced; preserving it.");
        await this.checkpoint?.("rollback-displaced", this.root);
      }
      await this.assertLease(false);
      if (await checkedSourcesOperationTarget(this.root, operation, true)) throw new Error("A new target appeared during rollback; preserving the external content.");
    }
    const owned = [...(journal.ownedDirectories ?? [])].sort((left, right) => right.path.length - left.path.length);
    for (const directory of owned) {
      const live = path.join(this.root, ...directory.path.split("/"));
      if (!await statMaybe(live)) continue;
      await verifyOwnedDirectory(live, directory);
      if ((await readdir(live)).length !== 0) throw new Error(`Owned directory ${directory.path} contains an unknown artifact; preserving it.`);
      await rmdir(live);
    }
    if (committed || catalogInTransit) {
      if (committed) {
        const displacedPath = path.join(this.lock, "displaced-catalog");
        if (await statMaybe(displacedPath)) throw new Error("Unexpected displaced catalog during new-item rollback.");
        await rename(catalogPath, displacedPath);
        const displaced = await checkedFile(displacedPath);
        if (!displaced || hash(displaced) !== journal.newCatalog) throw new Error("New catalog changed during rollback; preserving it.");
        await this.checkpoint?.("rollback-catalog-held", this.root);
      }
      if (rawOld) {
        await this.assertLease(false);
        const checkedHeld = await checkedFile(heldPath);
        if (!checkedHeld || hash(checkedHeld) !== journal.oldCatalog) throw new Error("Original v2 catalog is missing or altered.");
        if (await statMaybe(catalogPath)) throw new Error("An external catalog appeared during new-item rollback.");
        await link(heldPath, catalogPath);
      }
    }
    for (const [index, state] of states.entries()) {
      const current = await checkedSourcesOperationTarget(this.root, state.operation, true);
      if (current || await sourceArtifactTreeIfPresent(path.join(this.lock, `old-${index}`), state.operation.kind) !== null) {
        throw new Error("New-item rollback did not restore an absent target without inventing an old source.");
      }
      const stage = await sourceArtifactTreeIfPresent(operationStageContentPath(this.lock, journal, index), state.operation.kind);
      const displaced = await sourceArtifactTreeIfPresent(path.join(this.lock, `displaced-${index}`), state.operation.kind);
      if ((stage !== null && stage !== state.operation.newTree) || (displaced !== null && displaced !== state.operation.newTree)) {
        throw new Error("Retained new-target stage or displaced inode changed during recovery.");
      }
    }
    if ((await tree(sourcesRoot, undefined, true) ?? "absent") !== journal.stableSourcesTree) throw new Error("Adjacent, unregistered, or newly added sources changed; checked new targets were retracted and the journal is retained.");
    const restoredCatalog = await checkedFile(catalogPath);
    if ((restoredCatalog ? hash(restoredCatalog) : null) !== journal.oldCatalog) throw new Error("New-item rollback failed to restore the exact original catalog state.");
    await syncDirectory(this.root);
    await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
    await rm(path.join(this.lock, "journal.json"));
    await this.checkpoint?.("rollback-finalized", this.root);
  }
  private async recoverSources(journal: SourcesStorageJournal, rollback: boolean, rawJournal: Buffer): Promise<void> {
    const allowedEntries = v2LockEntries(journal);
    const lockEntries = await readdir(this.lock);
    if (lockEntries.some((entry) => !allowedEntries.has(entry))) {
      throw new Error("Unknown files in v2 sources transaction lock; inspect before recovery.");
    }
    const rawNext = await checkedFile(path.join(this.lock, "next-catalog"));
    if (!rawNext || hash(rawNext) !== journal.newCatalog) throw new Error("V2 journal next catalog is missing or altered.");
    const nextStored = parseStoredCatalog(JSON.parse(rawNext.toString("utf8")) as unknown);
    assertModernCatalog(nextStored);
    const rawOld = journal.oldCatalog === null ? undefined : await checkedFile(path.join(this.lock, "old-catalog"));
    if (journal.oldCatalog !== null && (!rawOld || hash(rawOld) !== journal.oldCatalog)) throw new Error("V2 journal old catalog is missing or altered.");
    if (journal.oldCatalog === null && await statMaybe(path.join(this.lock, "old-catalog"))) throw new Error("Unexpected old catalog for an initially absent v2 catalog.");
    const previousStored = rawOld ? parseStoredCatalog(JSON.parse(rawOld.toString("utf8")) as unknown) : null;
    if (previousStored && previousStored.version !== 2) throw new Error("V2 source recovery cannot use a legacy v1 catalog.");
    const previous = previousStored?.version === 2 ? previousStored : null;
    validateSourcesJournalTargets(journal, previous, nextStored);
    validateSourcesCatalogTransition(previous, nextStored, journal.operations);
    if (journal.operations.some((operation) => operation.oldTree === null)) {
      await this.recoverNewSources(journal, rollback, rawJournal, previous, nextStored, rawOld);
      return;
    }

    const rollbackMarker = await checkedFile(path.join(this.lock, "rollback.json"));
    if (rollbackMarker) {
      if (rollbackMarker.toString("utf8") !== this.token) throw new Error("Invalid rollback recovery marker; refusing v2 recovery.");
      rollback = true;
    }
    const currentCatalog = await checkedFile(path.join(this.root, "catalog.json"));
    const currentHash = currentCatalog ? hash(currentCatalog) : null;
    const heldPath = path.join(this.lock, "held-catalog");
    const held = await checkedFile(heldPath);
    const heldHash = held ? hash(held) : null;
    if (held && heldHash !== journal.oldCatalog) throw new Error("Original v2 catalog changed in its held inode; refusing recovery.");
    const catalogInTransit = currentHash === null && journal.oldCatalog !== null && heldHash === journal.oldCatalog;
    if (currentHash !== journal.oldCatalog && currentHash !== journal.newCatalog && !catalogInTransit) throw new Error("V2 catalog changed externally; refusing recovery.");
    const committed = currentHash === journal.newCatalog;
    if (committed && journal.oldCatalog !== null && heldHash !== journal.oldCatalog) throw new Error("Original v2 held catalog is missing; refusing recovery.");
    const displacedCatalog = await checkedFile(path.join(this.lock, "displaced-catalog"));
    if (displacedCatalog && hash(displacedCatalog) !== journal.newCatalog) throw new Error("Displaced v2 catalog was changed externally.");
    if (committed && (hash(currentCatalog!) !== journal.newCatalog || !rawNext.equals(currentCatalog!))) throw new Error("Current v2 catalog does not match its staged next catalog.");

    const targets = new Set(journal.operations.map((operation) => operation.target.slice("sources/".length)));
    const sourcesRoot = path.join(this.root, "sources");
    const stableNow = await tree(sourcesRoot, undefined, true, targets);
    if (stableNow === null) throw new Error("V2 sources root disappeared during recovery.");
    const stableMatches = stableNow === journal.stableSourcesTree;
    const states: Array<{ operation: SourcesOperation; current: string | null; backup: string | null; stage: string | null; displaced: string | null; target: string }> = [];
    for (const [index, operation] of journal.operations.entries()) {
      const target = path.join(this.root, ...operation.target.split("/"));
      if (operation.kind === "file") await checkedSourceFileTarget(this.root, operation.target, true);
      else await checkedSourceTreeTarget(this.root, operation.target, true);
      const current = await sourceArtifactTreeIfPresent(target, operation.kind);
      const backup = await sourceArtifactTreeIfPresent(path.join(this.lock, `old-${index}`), operation.kind);
      const stage = await sourceArtifactTreeIfPresent(path.join(this.lock, `next-${index}`), operation.kind);
      const displaced = await sourceArtifactTreeIfPresent(path.join(this.lock, `displaced-${index}`), operation.kind);
      if (current !== operation.oldTree && current !== operation.newTree && !(current === null && backup === operation.oldTree && (stage === operation.newTree || displaced === operation.newTree))) throw new Error("V2 registered sources bytes or inode changed externally; refusing recovery.");
      if (displaced !== null && displaced !== operation.newTree) throw new Error("V2 displaced sources inode was changed externally.");
      if (backup !== null && backup !== operation.oldTree) throw new Error("V2 original sources inode is missing or altered.");
      if (stage !== null && stage !== operation.newTree) throw new Error("V2 private stage is altered or unsafe.");
      if (Number(current === operation.oldTree) + Number(backup === operation.oldTree) !== 1) throw new Error("V2 recovery does not have exactly one checked original sources inode.");
      if (Number(current === operation.newTree) + Number(stage === operation.newTree) + Number(displaced === operation.newTree) !== 1) throw new Error("V2 recovery does not have exactly one checked replacement inode.");
      if (committed && !rollback && current !== operation.newTree) throw new Error(`Committed v2 sources ${operation.kind} is missing or altered.`);
      if ((!committed || rollback) && current !== operation.oldTree && backup !== operation.oldTree) throw new Error("V2 rollback bytes are missing.");
      const nextItem = nextStored.items.find((item) => item.id === operation.itemId)!;
      const newPath = current === operation.newTree ? target : stage === operation.newTree ? path.join(this.lock, `next-${index}`) : path.join(this.lock, `displaced-${index}`);
      if (operation.kind === "file") {
        const nextFile = nextItem.files[0];
        if (!nextFile || hash(await readFile(newPath)) !== nextFile.sha256) throw new Error("V2 replacement bytes do not match the new catalog descriptor.");
      } else await assertTreeMatchesDescriptors(newPath, nextItem.files);
      states.push({ operation, current, backup, stage, displaced, target });
    }

    if (await this.verifyFinalized()) {
      if (!committed || !stableMatches || states.some((state) => state.current !== state.operation.newTree)) throw new Error("Finalized v2 transaction no longer matches its checked source tree.");
      await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
      await rm(path.join(this.lock, "journal.json"));
      return;
    }
    if (committed && !rollback) {
      if (!stableMatches) throw new Error("Unregistered or adjacent sources changed; refusing to finalize v2 commit.");
      await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
      await rm(path.join(this.lock, "journal.json"));
      return;
    }

    if (journal.oldCatalog === null) throw new Error("V2 file replacement rollback requires its original catalog.");
    if (!rollbackMarker) { await writePrivate(path.join(this.lock, "rollback.json"), this.token); await syncDirectory(this.lock); }
    await this.checkpoint?.("rollback-started", this.root);
    for (const [index, state] of states.entries()) {
      const { operation, target } = state;
      await this.assertLease(false);
      const current = await sourceArtifactTreeIfPresent(target, operation.kind);
      if (current === operation.oldTree) continue;
      if (current !== null) {
        const displacedPath = path.join(this.lock, `displaced-${index}`);
        if (current !== operation.newTree || await statMaybe(displacedPath)) throw new Error("V2 live sources target changed during rollback; preserving the inode.");
        await rename(target, displacedPath);
        if (await sourceArtifactTreeIfPresent(displacedPath, operation.kind) !== operation.newTree) throw new Error("V2 replacement inode changed while being displaced; preserving it.");
        await this.checkpoint?.("rollback-displaced", this.root);
      }
      await this.assertLease(false);
      if (await statMaybe(target)) throw new Error(`An external ${operation.kind} appeared at the v2 sources target during rollback.`);
      const original = path.join(this.lock, `old-${index}`);
      if (await sourceArtifactTreeIfPresent(original, operation.kind) !== operation.oldTree) throw new Error("V2 original sources inode changed before restoration; preserving it.");
      await rename(original, target);
      await syncDirectory(path.dirname(target));
      await this.checkpoint?.("rollback-restored", this.root);
      await this.assertLease(false);
    }
    if (committed || catalogInTransit) {
      const catalogPath = path.join(this.root, "catalog.json");
      if (committed) {
        const displacedPath = path.join(this.lock, "displaced-catalog");
        if (await statMaybe(displacedPath)) throw new Error("Unexpected displaced catalog during v2 rollback.");
        await rename(catalogPath, displacedPath);
        if ((await checkedFile(displacedPath) && hash((await checkedFile(displacedPath))!)) !== journal.newCatalog) throw new Error("V2 displaced catalog changed during rollback; preserving it.");
        await this.checkpoint?.("rollback-catalog-held", this.root);
      }
      if (rawOld) {
        await this.assertLease(false);
        const checkedHeld = await checkedFile(heldPath);
        if (!checkedHeld || hash(checkedHeld) !== journal.oldCatalog) throw new Error("V2 original held catalog is missing or altered.");
        if (await statMaybe(catalogPath)) throw new Error("An external catalog appeared during v2 rollback.");
        await link(heldPath, catalogPath);
      }
    }
    for (const [index, operation] of journal.operations.entries()) {
      const current = operation.kind === "file"
        ? await checkedSourceFileTarget(this.root, operation.target)
        : await checkedSourceTreeTarget(this.root, operation.target);
      if (!current || await sourceArtifactTreeIfPresent(current, operation.kind) !== operation.oldTree) throw new Error("V2 rollback did not restore the checked original inode.");
      for (const [prefix, expectedTree] of [["next", operation.newTree], ["displaced", operation.newTree], ["old", operation.oldTree]] as const) {
        const leftover = await sourceArtifactTreeIfPresent(path.join(this.lock, `${prefix}-${index}`), operation.kind);
        if (leftover !== null && leftover !== expectedTree) throw new Error("V2 retained source stage or backup changed during recovery.");
      }
    }
    if (stableNow !== await tree(sourcesRoot, undefined, true, targets)) throw new Error("Adjacent or unregistered sources changed during v2 rollback; retaining the journal.");
    if (!stableMatches) throw new Error("Adjacent or unregistered sources changed during v2 transaction; checked targets rolled back, journal retained.");
    const restoredCatalog = await checkedFile(path.join(this.root, "catalog.json"));
    if (!restoredCatalog || hash(restoredCatalog) !== journal.oldCatalog) throw new Error("V2 rollback failed to restore the exact original catalog.");
    await syncDirectory(this.root);
    await this.markFinalized(await createFinalizedCleanup(this.lock, journal, rawJournal));
    await rm(path.join(this.lock, "journal.json"));
    await this.checkpoint?.("rollback-finalized", this.root);
  }
  async recover(rollback: boolean): Promise<void> {
    await this.assertLease(false);
    const raw = await checkedFile(path.join(this.lock, "journal.json"));
    if (!raw) {
      if (await this.verifyFinalized()) return;
      const entries = await readdir(this.lock);
      if (entries.some((entry) => entry !== "owner.json")) throw new Error("Unjournaled files in dead copi transaction lock; inspect before recovery.");
      return; // Without a journal or finalization custody record, retain every staged byte for inspection.
    }
    const digest = await checkedFile(path.join(this.lock, "journal.digest"));
    if (!digest || digest.toString("utf8") !== hash(raw)) throw new Error("Transaction journal is missing integrity information or was altered; refusing recovery.");
    const parsed = parseStorageJournal(JSON.parse(raw.toString("utf8")) as unknown, { root: this.root, token: this.token });
    if (parsed.version === 2) { await this.recoverSources(parsed, rollback, raw); return; }
    const journal = parsed;
    await this.assertLease(true);
    if (await this.verifyFinalized()) { await rm(path.join(this.lock, "journal.json")); return; }
    const rollbackMarker = await checkedFile(path.join(this.lock, "rollback.json"));
    if (rollbackMarker) {
      if (rollbackMarker.toString("utf8") !== this.token) throw new Error("Invalid rollback recovery marker; refusing recovery.");
      rollback = true;
    }
    const catalog = await checkedFile(path.join(this.root, "catalog.json"));
    const currentHash = catalog ? hash(catalog) : null;
    const heldPath = path.join(this.lock, "held-catalog");
    const held = await checkedFile(heldPath);
    const heldHash = held ? hash(held) : null;
    if (held && heldHash !== journal.oldCatalog) throw new Error("Original catalog was changed externally in its held inode; refusing rollback or deletion.");
    const catalogInTransit = currentHash === null && journal.oldCatalog !== null && heldHash === journal.oldCatalog;
    if (currentHash !== journal.oldCatalog && currentHash !== journal.newCatalog && !catalogInTransit) throw new Error("Catalog changed externally; refusing rollback.");
    const committed = currentHash === journal.newCatalog;
    if (committed && journal.oldCatalog !== null && heldHash !== journal.oldCatalog) throw new Error("Original held catalog is missing; refusing recovery.");
    const displacedCatalog = await checkedFile(path.join(this.lock, "displaced-catalog"));
    if (displacedCatalog && hash(displacedCatalog) !== journal.newCatalog) throw new Error("Displaced catalog was changed externally; refusing deletion.");
    // Validate *all* targets/backups first, before modifying anything during recovery.
    for (const [index, operation] of journal.operations.entries()) {
      const current = await tree(path.join(this.root, "items", operation.itemId));
      const backup = await tree(path.join(this.lock, `old-${index}`));
      const stage = await tree(path.join(this.lock, `next-${index}`));
      const displaced = await tree(path.join(this.lock, `displaced-${index}`));
      if (current !== operation.oldTree && current !== operation.newTree && !(current === null && backup === operation.oldTree && (stage === operation.newTree || displaced === operation.newTree))) throw new Error("Saved bytes changed externally; refusing rollback.");
      if (displaced !== null && displaced !== operation.newTree) throw new Error("Displaced snapshot bytes were changed externally.");
      if (backup !== null && backup !== operation.oldTree) throw new Error("Rollback bytes are missing or altered.");
      if (stage !== null && stage !== operation.newTree) throw new Error("Staged bytes are altered.");
      if (committed && !rollback && current !== operation.newTree) throw new Error("Committed snapshot bytes are missing or altered.");
      if ((!committed || rollback) && operation.oldTree !== null && current !== operation.oldTree && backup !== operation.oldTree) throw new Error("Rollback bytes are missing.");
    }
    if (committed && !rollback) { await this.markFinalized(); await rm(path.join(this.lock, "journal.json")); return; }
    const oldCatalog = await checkedFile(path.join(this.lock, "old-catalog"));
    if ((oldCatalog ? hash(oldCatalog) : null) !== journal.oldCatalog) throw new Error("Rollback catalog is missing or altered.");
    if (!rollbackMarker) { await writePrivate(path.join(this.lock, "rollback.json"), this.token); await syncDirectory(this.lock); }
    await this.checkpoint?.("rollback-started", this.root);
    for (const [index, operation] of journal.operations.entries()) {
      await this.assertLease();
      const target = path.join(this.root, "items", operation.itemId);
      const current = await tree(target);
      if (current === operation.oldTree) continue;
      if (current !== null) {
        // Keep recovery itself restartable; never recursively delete a live snapshot.
        await rename(target, path.join(this.lock, `displaced-${index}`));
        if (await tree(path.join(this.lock, `displaced-${index}`)) !== operation.newTree) throw new Error("Snapshot changed externally during rollback; retained bytes instead of deleting them.");
        await this.checkpoint?.("rollback-displaced", this.root);
      }
      await this.assertLease();
      if (await statMaybe(target)) throw new Error("An external snapshot appeared during rollback; refusing overwrite.");
      if (operation.oldTree !== null) {
        const original = path.join(this.lock, `old-${index}`);
        if (await tree(original) !== operation.oldTree) throw new Error("Original rollback bytes changed externally; retained them instead of restoring unchecked data.");
        await rename(original, target);
      }
      await this.checkpoint?.("rollback-restored", this.root);
      await this.assertLease();
    }
    await this.assertLease();
    if (committed) {
      const destination = path.join(this.root, "catalog.json");
      await rename(destination, path.join(this.lock, "displaced-catalog"));
      const displaced = await checkedFile(path.join(this.lock, "displaced-catalog"));
      if (!displaced || hash(displaced) !== journal.newCatalog) throw new Error("Catalog changed externally during rollback; retained bytes instead of deleting them.");
      await this.checkpoint?.("rollback-catalog-held", this.root);
    }
    if (committed || catalogInTransit) {
      if (oldCatalog) {
        await this.assertLease();
        const original = await checkedFile(heldPath);
        if (!original || hash(original) !== journal.oldCatalog) throw new Error("Original held catalog is missing or altered.");
        await link(heldPath, path.join(this.root, "catalog.json"));
      }
    }
    // Late writes to displaced/backup inodes must not be discarded by cleanup.
    for (const [index, operation] of journal.operations.entries()) {
      for (const [prefix, expectedTree] of [["old", operation.oldTree], ["next", operation.newTree], ["displaced", operation.newTree]] as const) {
        const retained = await tree(path.join(this.lock, `${prefix}-${index}`));
        if (retained !== null && retained !== expectedTree) throw new Error("Retained snapshot inode changed externally during recovery; refusing deletion.");
      }
    }
    const retainedCatalog = await checkedFile(path.join(this.lock, "displaced-catalog"));
    if (retainedCatalog && hash(retainedCatalog) !== journal.newCatalog) throw new Error("Retained catalog inode changed externally during recovery; refusing deletion.");
    await syncDirectory(this.root);
    await this.markFinalized();
    await rm(path.join(this.lock, "journal.json"));
    await this.checkpoint?.("rollback-finalized", this.root);
  }
}
export const storageTransactions = new StorageTransactions();
