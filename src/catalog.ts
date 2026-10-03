import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assertNameAvailable, assertNoNameConflicts, findNameConflicts, nameKey } from "./names.ts";
import type { Catalog, Group, InspectionResult, ResourceCandidate, ResourceDestination, ResourceKind, ResourceScope, SavedItem, SnapshotFile, SnapshotFileContents } from "./types.ts";

export interface ImportOptions {
  confirmed: boolean;
  groupIds: string[];
}

declare const preparedResourceBrand: unique symbol;

export interface PreparedResource {
  readonly [preparedResourceBrand]: true;
}

export interface PreparedFile {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

export interface PreparedResourceContents {
  readonly candidate: ResourceCandidate;
  readonly files: readonly PreparedFile[];
  readonly excludedPaths: readonly string[];
}

export interface PreparedInspection {
  readonly warnings: Readonly<InspectionResult["warnings"]>;
  readonly sensitivePaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly preparedResource: PreparedResource;
}

export interface PreparedImportOptions extends ImportOptions {
  inspection: PreparedInspection;
  approvedSensitivePaths: readonly string[];
}

interface SourceFile {
  path: string;
  mode: number;
  bytes: Buffer;
}

interface PreparedSnapshot {
  candidate: ResourceCandidate;
  files: SourceFile[];
  excludedPaths: string[];
}

const preparedSnapshots = new WeakMap<PreparedResource, PreparedSnapshot>();

const kinds = new Set<ResourceKind>(["instruction", "skill", "subagent", "pi-settings", "mcp-config", "model-config", "keybindings"]);
const scopes = new Set<ResourceScope>(["user", "project", "shared", "package"]);
const excludedNames = new Set([".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions"]);
const itemIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const groupIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function newCatalog(): Catalog {
  return { version: 1, items: [], groups: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..") && path.posix.normalize(value) === value;
}

function parseDestination(value: unknown): ResourceDestination | undefined {
  const destination = record(value);
  if (!destination) return undefined;
  if (destination.kind === "global-only") return { kind: "global-only" };
  if (destination.kind === "project" && safeRelativePath(destination.path)) return { kind: "project", path: destination.path };
  return undefined;
}

function parseSnapshotFile(value: unknown): SnapshotFile | undefined {
  const file = record(value);
  if (!file || !safeRelativePath(file.path) || !Number.isInteger(file.mode) || typeof file.mode !== "number" || file.mode < 0 || file.mode > 0o777 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return undefined;
  return { path: file.path, mode: file.mode, sha256: file.sha256 };
}

function parseSavedItem(value: unknown): SavedItem | undefined {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !itemIdPattern.test(item.id) || typeof item.kind !== "string" || !kinds.has(item.kind as ResourceKind) || typeof item.source !== "string" || typeof item.scope !== "string" || !scopes.has(item.scope as ResourceScope) || typeof item.sourcePath !== "string" || !path.isAbsolute(item.sourcePath) || typeof item.name !== "string" || item.name.length === 0 || typeof item.savedAt !== "string" || !Number.isFinite(Date.parse(item.savedAt)) || !Array.isArray(item.files)) return undefined;
  const destination = parseDestination(item.destination);
  const files = item.files.map(parseSnapshotFile);
  if (!destination || files.some((file) => file === undefined) || new Set(files.map((file) => file?.path)).size !== files.length) return undefined;
  return {
    id: item.id,
    kind: item.kind as ResourceKind,
    source: item.source,
    scope: item.scope as ResourceScope,
    sourcePath: item.sourcePath,
    destination,
    name: item.name,
    savedAt: item.savedAt,
    files: files as SnapshotFile[],
  };
}

function parseGroup(value: unknown): Group | undefined {
  const group = record(value);
  if (!group || typeof group.id !== "string" || !groupIdPattern.test(group.id) || typeof group.name !== "string" || group.name.trim().length === 0 || !Array.isArray(group.itemIds) || group.itemIds.some((id) => typeof id !== "string" || !itemIdPattern.test(id))) return undefined;
  if (new Set(group.itemIds).size !== group.itemIds.length) return undefined;
  return { id: group.id, name: group.name, itemIds: [...group.itemIds] as string[] };
}

function parseCatalog(value: unknown): Catalog {
  const catalog = record(value);
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.items) || !Array.isArray(catalog.groups)) throw new Error("Invalid copi catalog: expected version 1 with item and group arrays.");
  const items = catalog.items.map(parseSavedItem);
  const groups = catalog.groups.map(parseGroup);
  if (items.some((item) => item === undefined) || groups.some((group) => group === undefined)) throw new Error("Invalid copi catalog: an item or group has malformed fields.");
  const itemIds = items.map((item) => item?.id);
  const groupIds = groups.map((group) => group?.id);
  if (new Set(itemIds).size !== itemIds.length || new Set(groupIds).size !== groupIds.length) throw new Error("Invalid copi catalog: duplicate item or group identifiers.");
  const knownItems = new Set(itemIds);
  if (groups.some((group) => group?.itemIds.some((id) => !knownItems.has(id)))) throw new Error("Invalid copi catalog: a group references an unknown item.");
  return { version: 1, items: items as SavedItem[], groups: groups as Group[] };
}

async function ensurePrivateDirectory(requestedPath: string, mode: number): Promise<string> {
  const absolute = path.resolve(requestedPath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.length === 0) throw new Error("Refusing to use the filesystem root as a copi directory.");
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    let next = path.join(current, segment);
    let stat = await lstat(next).catch(() => undefined);
    if (!stat) {
      await mkdir(next, { mode: 0o700 });
      stat = await lstat(next);
    }
    if (stat.isSymbolicLink()) {
      if (index === segments.length - 1) throw new Error("Refusing to follow a symbolic link for a copi storage directory.");
      next = await realpath(next);
      stat = await lstat(next);
    }
    if (!stat.isDirectory()) throw new Error("A copi storage path component is not a directory.");
    current = next;
  }
  await chmod(current, mode);
  return await realpath(current);
}

async function ensurePrivateSubdirectory(root: string, relativePath: string, mode: number | undefined, create: boolean): Promise<string> {
  if (!safeRelativePath(relativePath)) throw new Error("Unsafe relative path inside copi storage.");
  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Copi storage root is not a safe directory.");
  let current = canonicalRoot;
  for (const segment of relativePath.split("/")) {
    const next = path.join(current, segment);
    let stat = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat && create) {
      await mkdir(next, { mode: 0o700 });
      stat = await lstat(next);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Copi storage contains a missing, non-directory, or symbolic-link path component.");
    if (mode !== undefined) await chmod(next, mode);
    current = next;
  }
  return current;
}

async function existingStoreRoot(libraryDir: string): Promise<string | undefined> {
  const requested = path.resolve(libraryDir);
  const stat = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing to read a copied catalog through a non-directory or symbolic link.");
  return await realpath(requested);
}

function excludedRelative(relative: string): boolean {
  return relative.split("/").some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === "auth.json" || lower === "mcp-auth.json" || lower === "oauth.json" || lower === ".env" || lower.startsWith(".env");
  });
}

async function checkedSourceRoot(candidate: ResourceCandidate): Promise<{ root: string; source: string }> {
  const rootInput = path.resolve(candidate.sourceRoot);
  const sourceInput = path.resolve(candidate.sourcePath);
  if (!path.isAbsolute(candidate.sourceRoot) || !path.isAbsolute(candidate.sourcePath) || !isWithin(rootInput, sourceInput)) throw new Error("Resource source path escapes its declared boundary.");
  const rootStat = await lstat(rootInput);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Resource search root is not a safe directory.");
  const root = await realpath(rootInput);
  const relative = path.relative(rootInput, sourceInput);
  let current = rootInput;
  const components = relative === "" ? [] : relative.split(path.sep);
  for (const component of components) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not copied as resource content.");
  }
  const source = await realpath(sourceInput);
  if (!isWithin(root, source)) throw new Error("Resource source path resolves outside its declared boundary.");
  const sourceStat = await lstat(sourceInput);
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) throw new Error("Resource source must be a regular file or directory.");
  return { root, source };
}

async function readSourceFiles(candidate: ResourceCandidate, excludedPaths: string[]): Promise<SourceFile[]> {
  const { root, source } = await checkedSourceRoot(candidate);
  const sourceStat = await lstat(source);
  const directory = sourceStat.isDirectory();
  const files: SourceFile[] = [];
  const visit = async (target: string): Promise<void> => {
    const relative = directory ? path.relative(source, target).split(path.sep).join("/") : path.basename(target);
    if (relative && excludedRelative(relative)) {
      excludedPaths.push(relative);
      return;
    }
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not copied as resource content.");
    if (stat.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) await visit(path.join(target, entry.name));
      return;
    }
    if (!stat.isFile()) return;
    const storedPath = directory ? relative : path.basename(target);
    if (!safeRelativePath(storedPath)) throw new Error("Resource contains an unsafe relative file path.");
    files.push({ path: storedPath, mode: stat.mode & 0o777, bytes: await readFile(target) });
  };
  await visit(source);
  if (files.length === 0) throw new Error("Resource contains no copyable files.");
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!isWithin(root, source)) throw new Error("Resource source path escapes its declared boundary.");
  return files;
}

function copyCandidate(candidate: ResourceCandidate): ResourceCandidate {
  return { ...candidate, destination: { ...candidate.destination } };
}

function getPreparedSnapshot(prepared: PreparedResource): PreparedSnapshot {
  if (typeof prepared !== "object" || prepared === null) throw new Error("Invalid prepared resource.");
  const snapshot = preparedSnapshots.get(prepared);
  if (!snapshot) throw new Error("Prepared resource is unavailable.");
  return snapshot;
}

export async function prepareResource(candidate: ResourceCandidate): Promise<PreparedResource> {
  validateCandidate(candidate);
  const capturedCandidate = copyCandidate(candidate);
  const excludedPaths: string[] = [];
  const files = await readSourceFiles(capturedCandidate, excludedPaths);
  const prepared = Object.freeze({}) as PreparedResource;
  preparedSnapshots.set(prepared, {
    candidate: capturedCandidate,
    files,
    excludedPaths: [...new Set(excludedPaths)].sort((left, right) => left.localeCompare(right)),
  });
  return prepared;
}

export function readPreparedResource(prepared: PreparedResource): PreparedResourceContents {
  const snapshot = getPreparedSnapshot(prepared);
  const files = snapshot.files.map((file) => Object.freeze({
    path: file.path,
    mode: file.mode,
    bytes: Buffer.from(file.bytes),
  }));
  return Object.freeze({
    candidate: copyCandidate(snapshot.candidate),
    files: Object.freeze(files),
    excludedPaths: Object.freeze([...snapshot.excludedPaths]),
  });
}

function validateCandidate(candidate: ResourceCandidate): void {
  if (!candidate || typeof candidate !== "object" || !kinds.has(candidate.kind) || !scopes.has(candidate.scope) || typeof candidate.source !== "string" || !candidate.source || typeof candidate.name !== "string" || !candidate.name || !path.isAbsolute(candidate.sourceRoot) || !path.isAbsolute(candidate.sourcePath)) throw new Error("Invalid resource candidate.");
  const destination = candidate.destination;
  if (!destination || (destination.kind !== "global-only" && !(destination.kind === "project" && safeRelativePath(destination.path)))) throw new Error("Invalid resource destination.");
}

async function writeSnapshotFiles(root: string, itemId: string, files: SourceFile[]): Promise<SnapshotFile[]> {
  const itemRoot = await ensurePrivateSubdirectory(root, path.posix.join("items", itemId, "files"), 0o700, true);
  const snapshots: SnapshotFile[] = [];
  for (const file of files) {
    const outputPath = path.resolve(itemRoot, ...file.path.split("/"));
    if (!isWithin(itemRoot, outputPath)) throw new Error("Snapshot file path escapes the item directory.");
    const parentRelative = path.posix.dirname(file.path);
    const parent = parentRelative === "." ? itemRoot : await ensurePrivateSubdirectory(itemRoot, parentRelative, 0o700, true);
    const target = path.join(parent, path.basename(outputPath));
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    snapshots.push({ path: file.path, mode: file.mode, sha256: createHash("sha256").update(file.bytes).digest("hex") });
  }
  return snapshots;
}

export async function loadCatalog(libraryDir: string): Promise<Catalog> {
  const root = await existingStoreRoot(libraryDir);
  if (!root) return newCatalog();
  const filePath = path.join(root, "catalog.json");
  const stat = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return newCatalog();
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid copi catalog: catalog.json is not a regular file.");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Invalid copi catalog JSON.", { cause: error });
  }
  return parseCatalog(value);
}

export async function saveCatalog(libraryDir: string, catalog: Catalog): Promise<void> {
  assertNoNameConflicts(await loadCatalog(libraryDir));
  assertNoNameConflicts(catalog);
  await writeCatalog(libraryDir, catalog);
}

// Only the checked name-only path below can persist conflict resolution.
async function writeCatalog(libraryDir: string, catalog: Catalog): Promise<void> {
  const validated = parseCatalog(catalog);
  const root = await ensurePrivateDirectory(libraryDir, 0o700);
  const destination = path.join(root, "catalog.json");
  const temporary = path.join(root, `catalog.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function storePreparedResource(libraryDir: string, candidate: ResourceCandidate, sourceFiles: SourceFile[], requestedGroupIds: string[]): Promise<SavedItem> {
  const groupIds = [...new Set(requestedGroupIds)];
  const catalog = await loadCatalog(libraryDir);
  assertNoNameConflicts(catalog);
  assertNameAvailable(catalog, "item", candidate.name);
  const groups = new Map(catalog.groups.map((group) => [group.id, group]));
  if (groupIds.some((id) => !groups.has(id))) throw new Error("Cannot import a resource into an unknown group.");
  const root = await ensurePrivateDirectory(libraryDir, 0o700);
  const id = randomUUID();
  const item: SavedItem = {
    id,
    kind: candidate.kind,
    source: candidate.source,
    scope: candidate.scope,
    sourcePath: candidate.sourcePath,
    destination: candidate.destination,
    name: candidate.name.trim(),
    savedAt: new Date().toISOString(),
    files: [],
  };
  const itemDirectory = path.join(root, "items", id);
  try {
    item.files = await writeSnapshotFiles(root, id, sourceFiles);
    catalog.items.push(item);
    for (const groupId of groupIds) groups.get(groupId)?.itemIds.push(id);
    await saveCatalog(root, catalog);
  } catch (error) {
    await rm(itemDirectory, { recursive: true, force: true });
    throw error;
  }
  return item;
}

export async function importPreparedResource(libraryDir: string, prepared: PreparedResource, options: PreparedImportOptions): Promise<SavedItem | null> {
  if (!options.confirmed) return null;
  const snapshot = getPreparedSnapshot(prepared);
  if (options.inspection.preparedResource !== prepared) throw new Error("Inspection does not match the prepared resource.");
  const inspectedPaths = new Set(options.inspection.sensitivePaths);
  const approvedPaths = new Set(options.approvedSensitivePaths);
  const availablePaths = new Set(snapshot.files.map((file) => file.path));
  if (inspectedPaths.size !== options.inspection.sensitivePaths.length || approvedPaths.size !== options.approvedSensitivePaths.length ||
      [...inspectedPaths].some((filePath) => !availablePaths.has(filePath)) || inspectedPaths.size !== approvedPaths.size ||
      [...inspectedPaths].some((filePath) => !approvedPaths.has(filePath))) {
    throw new Error("Prepared import requires approval for every suspected sensitive file in its inspection.");
  }
  return storePreparedResource(libraryDir, snapshot.candidate, snapshot.files, options.groupIds);
}

export async function importResource(libraryDir: string, candidate: ResourceCandidate, options: ImportOptions): Promise<SavedItem | null> {
  if (!options.confirmed) return null;
  const prepared = await prepareResource(candidate);
  const snapshot = getPreparedSnapshot(prepared);
  return storePreparedResource(libraryDir, snapshot.candidate, snapshot.files, options.groupIds);
}

export async function readSnapshotFiles(libraryDir: string, item: SavedItem): Promise<SnapshotFileContents[]> {
  if (!itemIdPattern.test(item.id)) throw new Error("Invalid snapshot identifier.");
  const root = await existingStoreRoot(libraryDir);
  if (!root) throw new Error("Snapshot catalog does not exist.");
  const catalog = await loadCatalog(root);
  const storedItem = catalog.items.find((entry) => entry.id === item.id);
  if (!storedItem) throw new Error("Snapshot is not present in the catalog.");
  const canonicalFilesRoot = await ensurePrivateSubdirectory(root, path.posix.join("items", storedItem.id, "files"), undefined, false);
  const results: SnapshotFileContents[] = [];
  for (const file of storedItem.files) {
    if (!safeRelativePath(file.path)) throw new Error("Catalog contains an unsafe snapshot path.");
    const filePath = path.resolve(canonicalFilesRoot, ...file.path.split("/"));
    if (!isWithin(canonicalFilesRoot, filePath)) throw new Error("Snapshot path escapes the item directory.");
    let current = canonicalFilesRoot;
    for (const segment of file.path.split("/")) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Snapshot contains an unsafe symbolic link.");
    }
    const canonicalFile = await realpath(filePath);
    if (!isWithin(canonicalFilesRoot, canonicalFile)) throw new Error("Snapshot path resolves outside the item directory.");
    const bytes = await readFile(canonicalFile);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`Snapshot checksum mismatch for ${file.path}.`);
    results.push({ ...file, bytes });
  }
  return results;
}

/** Persist staged, explicit name-only changes together, so cancellation never partially resolves names. */
export async function saveNameChanges(libraryDir: string, before: Catalog, after: Catalog): Promise<void> {
  const validated = parseCatalog(after);
  const current = await loadCatalog(libraryDir);
  if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error("Catalog changed while renaming; reload before trying again.");
  const restored = structuredClone(validated);
  const conflicts = findNameConflicts(before);
  for (const namespace of ["item", "group"] as const) {
    const previousEntries = namespace === "item" ? before.items : before.groups;
    const nextEntries = namespace === "item" ? restored.items : restored.groups;
    if (previousEntries.length !== nextEntries.length) throw new Error("Renaming must preserve catalog entries.");
    for (const [index, entry] of nextEntries.entries()) {
      const previous = previousEntries[index];
      if (!previous || previous.id !== entry.id) throw new Error("Renaming must preserve catalog identifiers and order.");
      if (entry.name !== previous.name) {
        if (conflicts.length > 0 && !conflicts.some((conflict) => conflict.namespace === namespace && conflict.ids.includes(entry.id))) {
          throw new Error("Only conflicting names may change until duplicate names are resolved.");
        }
        nameKey(entry.name);
        const finalEntries = namespace === "item" ? validated.items : validated.groups;
        if (finalEntries.some((other) => other.id !== entry.id && nameKey(other.name) === nameKey(entry.name))) {
          throw new Error("Duplicate name; choose a unique display name.");
        }
      }
      entry.name = previous.name;
    }
  }
  if (JSON.stringify(restored) !== JSON.stringify(before)) throw new Error("Renaming must preserve metadata, files, destinations, and group references.");
  for (const item of before.items) await readSnapshotFiles(libraryDir, item);
  if (JSON.stringify(await loadCatalog(libraryDir)) !== JSON.stringify(before)) throw new Error("Catalog changed while renaming; reload before trying again.");
  await writeCatalog(libraryDir, validated);
}

export async function renameSavedItem(libraryDir: string, itemId: string, name: string): Promise<SavedItem> {
  const before = await loadCatalog(libraryDir);
  const after = structuredClone(before);
  const item = after.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error("Unknown saved item.");
  assertNameAvailable(before, "item", name, itemId);
  item.name = name.trim();
  await saveNameChanges(libraryDir, before, after);
  return item;
}

export async function listSnapshots(libraryDir: string): Promise<SavedItem[]> {
  const catalog = await loadCatalog(libraryDir);
  return [...catalog.items].sort((left, right) => right.savedAt.localeCompare(left.savedAt) || left.id.localeCompare(right.id));
}
