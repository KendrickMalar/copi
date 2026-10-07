import { createHash, randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { inspectFixedResource, maskSensitiveText } from "./inspect.ts";
import { buildMigrationBackupManifest, type MigrationBackupInputEntry } from "./migration-backup.ts";
import { parseStoredCatalog } from "./catalog.ts";
import type { Catalog, LegacyCatalog, LegacySavedItem, SavedItem } from "./types.ts";

export type MigrationStatus = "ready" | "blocked" | "already-v2";
export type MigrationSelection = "sources" | "items";

export interface MigrationViewItem {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly selection: MigrationSelection;
}

export interface MigrationMaskedDiff {
  readonly path: string;
  readonly summary: string;
}

export interface MigrationWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface MigrationView {
  readonly reviewId: string;
  readonly status: MigrationStatus;
  readonly items: readonly MigrationViewItem[];
  readonly conflicts: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly maskedDiffs: readonly MigrationMaskedDiff[];
  readonly sensitivePaths: readonly string[];
  readonly warnings: readonly MigrationWarning[];
}

declare const preparedMigrationBrand: unique symbol;
export interface PreparedMigration {
  readonly [preparedMigrationBrand]: true;
  readonly reviewId: string;
}

/** Result shape reserved for the later write-capable commitMigration implementation. */
export interface MigrationResult {
  readonly catalogVersion: 2;
  readonly backupDir: string | null;
  readonly preservedPaths: readonly string[];
}

interface FileState {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
  readonly dev: string;
  readonly ino: string;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}

interface DirectoryState extends DirectoryIdentity {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface ScannedTree {
  readonly present: boolean;
  readonly directories: Map<string, DirectoryState>;
  readonly entries: Map<string, readonly string[]>;
  readonly files: Map<string, FileState>;
}

interface PlannedPayloadFile {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly inputPath: string;
  readonly dev: string;
  readonly ino: string;
}

interface FixedSelection {
  readonly itemId: string;
  readonly target: string;
  readonly kind: "file" | "tree";
  readonly selection: MigrationSelection;
  readonly files: readonly PlannedPayloadFile[];
}

interface PlannedAddition {
  readonly itemId: string;
  readonly target: string;
  readonly kind: "file" | "tree";
  readonly files: readonly PlannedPayloadFile[];
}

interface PreparedMigrationState {
  readonly root: string;
  readonly revision: string;
  readonly rootPresent?: boolean;
  readonly rootIdentities?: readonly DirectoryIdentity[];
  readonly rootDirectoryState?: DirectoryState;
  readonly rootEntries?: readonly string[];
  readonly itemsTree?: ScannedTree;
  readonly sourcesTree?: ScannedTree;
  readonly view: MigrationView;
  readonly oldCatalogBytes?: Buffer;
  readonly oldCatalog?: LegacyCatalog;
  readonly nextCatalog?: Catalog;
  readonly inputs: readonly FileState[];
  readonly backupManifestBytes?: Buffer;
  readonly backupEntries: readonly MigrationBackupInputEntry[];
  readonly selections: readonly FixedSelection[];
  readonly additions: readonly PlannedAddition[];
}

const preparedStates = new WeakMap<PreparedMigration, PreparedMigrationState>();
const excludedNames = new Set([
  ".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions",
  "auth.json", "mcp-auth.json", "oauth.json",
]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const itemIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") && path.posix.normalize(value) === value;
}

function excluded(relative: string): boolean {
  return relative.split("/").some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === ".env" || lower.startsWith(".env");
  });
}

function identityOfDirectory(target: string, stat: BigIntStats): DirectoryIdentity {
  return { path: target, dev: stat.dev.toString(), ino: stat.ino.toString(), mode: stat.mode.toString() };
}

function stateOfDirectory(target: string, stat: BigIntStats): DirectoryState {
  return {
    ...identityOfDirectory(target, stat),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameDirectory(left: DirectoryState, right: DirectoryState): boolean {
  return sameDirectoryIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function checkCanonicalAncestors(target: string): Promise<{
  exists: boolean;
  identities: DirectoryIdentity[];
  rootDirectoryState?: DirectoryState;
}> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target) throw new Error("Library path must resolve to a canonical absolute path.");
  const identities: DirectoryIdentity[] = [];
  const volume = path.parse(target).root;
  let current = volume;
  const segments = target.slice(volume.length).split(path.sep).filter(Boolean);
  const rootStat = await lstat(current, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(current) !== current) {
    throw new Error("Library path has an unsafe filesystem root.");
  }
  identities.push(identityOfDirectory(current, rootStat));
  if (segments.length === 0) return { exists: true, identities, rootDirectoryState: stateOfDirectory(current, rootStat) };
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return { exists: false, identities };
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error("Library root or an ancestor is not a canonical real directory.");
    }
    identities.push(identityOfDirectory(current, stat));
    if (current === target) return { exists: true, identities, rootDirectoryState: stateOfDirectory(current, stat) };
  }
  throw new Error("Library root could not be identified as a canonical directory.");
}

async function assertDirectoryChain(identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const expected of identities) {
    const stat = await lstat(expected.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(expected.path) !== expected.path ||
        !sameDirectoryIdentity(expected, identityOfDirectory(expected.path, stat))) {
      throw new Error("Library root or an ancestor changed during the read-only preview.");
    }
  }
}

async function assertDirectoryState(expected: DirectoryState | undefined): Promise<void> {
  if (!expected) return;
  const stat = await lstat(expected.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(expected.path) !== expected.path ||
      !sameDirectory(expected, stateOfDirectory(expected.path, stat))) {
    throw new Error("Library root directory changed during the read-only preview.");
  }
}

async function safeReadFile(root: string, relative: string): Promise<FileState> {
  if (!safeRelative(relative)) throw new Error(`Unsafe library input path: ${relative}`);
  const target = path.join(root, ...relative.split("/"));
  let parent = root;
  const parentStates: DirectoryState[] = [];
  for (const segment of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    const parentStat = await lstat(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error(`Unsafe directory in library input: ${relative}`);
    }
    parentStates.push(stateOfDirectory(parent, parentStat));
  }
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || await realpath(target) !== target || !isWithin(root, target)) {
    throw new Error(`Library input is not a canonical regular file: ${relative}`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`Library input changed while opening: ${relative}`);
    const bytes = await handle.readFile();
    const [afterHandle, afterPath, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }), lstat(target, { bigint: true }), realpath(target),
    ]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || canonicalAfter !== target ||
        !sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) {
      throw new Error(`Library input changed while reading: ${relative}`);
    }
    for (const expected of parentStates) {
      const current = await lstat(expected.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectory(expected, stateOfDirectory(expected.path, current))) {
        throw new Error(`Library input parent changed while reading: ${relative}`);
      }
    }
    return {
      path: relative,
      bytes: Buffer.from(bytes),
      sha256: digest(bytes),
      mode: Number(opened.mode & 0o777n),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    };
  } finally {
    await handle.close();
  }
}

async function scanTree(root: string, relativeRoot: "items" | "sources"): Promise<ScannedTree> {
  const treePath = path.join(root, relativeRoot);
  const rootStat = await lstat(treePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootStat) return { present: false, directories: new Map(), entries: new Map(), files: new Map() };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(treePath) !== treePath) {
    throw new Error(`${relativeRoot}/ is not a canonical real directory.`);
  }
  const directories = new Map<string, DirectoryState>();
  const entries = new Map<string, readonly string[]>();
  const files = new Map<string, FileState>();
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const before = await lstat(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(absolute) !== absolute) {
      throw new Error(`Unsafe directory in ${relativeRoot}/ input: ${relative}`);
    }
    const beforeState = stateOfDirectory(absolute, before);
    directories.set(relative, beforeState);
    const names = (await readdir(absolute)).sort(compare);
    entries.set(relative, [...names]);
    for (const name of names) {
      const childRelative = `${relative}/${name}`;
      const childAbsolute = path.join(absolute, name);
      const stat = await lstat(childAbsolute, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link in ${relativeRoot}/ input: ${childRelative}`);
      if (stat.isDirectory()) await visit(childAbsolute, childRelative);
      else if (stat.isFile()) {
        const file = await safeReadFile(root, childRelative);
        files.set(childRelative, file);
      } else throw new Error(`Unsupported special file in ${relativeRoot}/ input: ${childRelative}`);
    }
    const [after, finalNames, canonical] = await Promise.all([
      lstat(absolute, { bigint: true }), readdir(absolute), realpath(absolute),
    ]);
    if (!after.isDirectory() || after.isSymbolicLink() || canonical !== absolute ||
        !sameDirectory(beforeState, stateOfDirectory(absolute, after)) ||
        JSON.stringify(finalNames.sort(compare)) !== JSON.stringify(names)) {
      throw new Error(`Directory changed while reading ${relativeRoot}/ input: ${relative}`);
    }
  };
  await visit(treePath, relativeRoot);
  return { present: true, directories, entries, files };
}

function parseCatalogBytes(bytes: Buffer): LegacyCatalog | Catalog {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("catalog.json is not valid JSON."); }
  const parsed = parseStoredCatalog(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog.json has an invalid top-level value.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort(compare).join("|") !== "groups|items|version") throw new Error("catalog.json contains unsupported fields.");
  if (parsed.version === 1) {
    const rawItems = record.items as unknown[];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) throw new Error("Legacy catalog contains an invalid item.");
      const item = rawItem as Record<string, unknown>;
      if (Object.keys(item).sort(compare).join("|") !== "destination|files|id|kind|name|savedAt|scope|source|sourcePath") {
        throw new Error("Legacy catalog item contains unsupported fields.");
      }
      const destination = item.destination as Record<string, unknown>;
      const expectedDestinationKeys = destination.kind === "project" ? "kind|path" : "kind";
      if (!destination || Object.keys(destination).sort(compare).join("|") !== expectedDestinationKeys) throw new Error("Legacy catalog destination contains unsupported fields.");
      for (const rawFile of item.files as unknown[]) {
        if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile) ||
            Object.keys(rawFile).sort(compare).join("|") !== "mode|path|sha256") {
          throw new Error("Legacy catalog file descriptor contains unsupported fields.");
        }
      }
    }
    for (const group of record.groups as unknown[]) {
      if (!group || typeof group !== "object" || Array.isArray(group) ||
          Object.keys(group).sort(compare).join("|") !== "id|itemIds|name") throw new Error("Legacy catalog group contains unsupported fields.");
    }
  }
  return parsed;
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

function blockedView(reviewId: string, conflict: string, preservedPaths: readonly string[] = []): MigrationView {
  return {
    reviewId,
    status: "blocked",
    items: [],
    conflicts: [conflict],
    preservedPaths: [...new Set(preservedPaths)].sort(compare),
    maskedDiffs: [],
    sensitivePaths: [],
    warnings: [],
  };
}

function cloneView(view: MigrationView): MigrationView {
  return {
    reviewId: view.reviewId,
    status: view.status,
    items: view.items.map((item) => ({ ...item })),
    conflicts: [...view.conflicts],
    preservedPaths: [...view.preservedPaths],
    maskedDiffs: view.maskedDiffs.map((entry) => ({ ...entry })),
    sensitivePaths: [...view.sensitivePaths],
    warnings: view.warnings.map((warning) => ({ ...warning })),
  };
}

function makePrepared(state: PreparedMigrationState): PreparedMigration {
  const plan = Object.freeze({ reviewId: state.view.reviewId }) as PreparedMigration;
  preparedStates.set(plan, state);
  return plan;
}

function inventoryDigest(
  rootIdentities: readonly DirectoryIdentity[],
  rootDirectoryState: DirectoryState,
  catalog: FileState,
  trees: readonly ScannedTree[],
): string {
  const rows = [
    ...rootIdentities.map((identity) => `R:${JSON.stringify(identity)}`),
    `L:${JSON.stringify(rootDirectoryState)}`,
    `C:${catalog.path}:${catalog.sha256}:${catalog.mode}:${catalog.dev}:${catalog.ino}`,
  ];
  for (const tree of trees) {
    rows.push(`T:${tree.present ? "present" : "absent"}`);
    for (const state of tree.directories.values()) rows.push(`D:${JSON.stringify(state)}`);
    for (const [directory, names] of tree.entries) rows.push(`E:${directory}:${JSON.stringify(names)}`);
    for (const file of tree.files.values()) rows.push(`F:${file.path}:${file.sha256}:${file.mode}:${file.dev}:${file.ino}`);
  }
  return digest(Buffer.from(rows.sort(compare).join("\n")));
}

function treeRelativeEntries(tree: ScannedTree, base: string): Array<{ path: string; file: FileState }> {
  return [...tree.files.entries()]
    .filter(([relative]) => relative.startsWith(`${base}/`))
    .map(([relative, file]) => ({ path: relative.slice(base.length + 1), file }))
    .sort((left, right) => compare(left.path, right.path));
}

function currentSourcePayload(
  root: string,
  item: LegacySavedItem,
  sourceTree: ScannedTree,
): { target: string; files: PlannedPayloadFile[] } | undefined {
  if (!path.isAbsolute(item.sourcePath) || path.resolve(item.sourcePath) !== item.sourcePath) return undefined;
  const sourcesRoot = path.join(root, "sources");
  if (!isWithin(sourcesRoot, item.sourcePath) || item.sourcePath === sourcesRoot) return undefined;
  const relativeRoot = path.relative(root, item.sourcePath).split(path.sep).join("/");
  const rootEntry = sourceTree.directories.get(relativeRoot);
  const rootFile = sourceTree.files.get(relativeRoot);
  if (!rootEntry && !rootFile) return undefined;
  const target = relativeRoot;
  if (item.kind === "skill") {
    if (!rootEntry) throw new Error(`Registered source path type conflicts with skill item ${item.id}.`);
    const actual = treeRelativeEntries(sourceTree, relativeRoot);
    const registered = new Set(item.files.map((file) => file.path));
    const exposed = actual.filter(({ path: relative }) => !excluded(relative));
    if (exposed.some(({ path: relative }) => !registered.has(relative)) || item.files.some((file) => !exposed.some(({ path: relative }) => relative === file.path))) {
      throw new Error(`Registered source tree has missing or unregistered files for item ${item.id}.`);
    }
    if (!item.files.some((file) => file.path === "SKILL.md")) throw new Error(`Skill item ${item.id} has no registered root SKILL.md.`);
    return {
      target,
      files: item.files.map((descriptor) => {
        const found = sourceTree.files.get(`${relativeRoot}/${descriptor.path}`);
        if (!found) throw new Error(`Registered source file is missing for item ${item.id}.`);
        return { path: descriptor.path, mode: descriptor.mode, bytes: Buffer.from(found.bytes), sha256: found.sha256,
          inputPath: found.path, dev: found.dev, ino: found.ino };
      }),
    };
  }
  if (!rootFile || item.files.length !== 1 || item.files[0]?.path !== path.posix.basename(target)) {
    throw new Error(`Registered source path does not match the legacy file descriptor for item ${item.id}.`);
  }
  return {
    target,
    files: [{ path: item.files[0]!.path, mode: item.files[0]!.mode, bytes: Buffer.from(rootFile.bytes), sha256: rootFile.sha256,
      inputPath: rootFile.path, dev: rootFile.dev, ino: rootFile.ino }],
  };
}

function itemsPayload(item: LegacySavedItem, itemsTree: ScannedTree): PlannedPayloadFile[] {
  if (!itemIdPattern.test(item.id) || item.files.length === 0) throw new Error(`Legacy item ${item.id} has no valid registered snapshot files.`);
  const paths = new Set<string>();
  const files: PlannedPayloadFile[] = [];
  for (const descriptor of item.files) {
    if (!safeRelative(descriptor.path) || excluded(descriptor.path) || paths.has(descriptor.path) || !sha256Pattern.test(descriptor.sha256)) {
      throw new Error(`Legacy item ${item.id} has an unsafe or duplicate snapshot path.`);
    }
    paths.add(descriptor.path);
    const target = `items/${item.id}/files/${descriptor.path}`;
    const stored = itemsTree.files.get(target);
    if (!stored || stored.sha256 !== descriptor.sha256) throw new Error(`Legacy snapshot payload is missing or its declared checksum does not match for item ${item.id}.`);
    files.push({ path: descriptor.path, mode: descriptor.mode, bytes: Buffer.from(stored.bytes), sha256: stored.sha256,
      inputPath: stored.path, dev: stored.dev, ino: stored.ino });
  }
  if (item.kind === "skill" && !paths.has("SKILL.md")) throw new Error(`Legacy skill item ${item.id} has no root SKILL.md snapshot.`);
  if (item.kind !== "skill" && (files.length !== 1 || files[0]?.path !== path.posix.basename(files[0]?.path ?? ""))) {
    throw new Error(`Legacy file item ${item.id} must register exactly one flat file.`);
  }
  return files;
}

function existingTargetPayload(
  target: string,
  kind: "file" | "tree",
  expected: readonly PlannedPayloadFile[],
  sourceTree: ScannedTree,
): PlannedPayloadFile[] | undefined {
  const existingFile = sourceTree.files.get(target);
  const existingDirectory = sourceTree.directories.has(target);
  if (kind === "file") {
    if (existingFile) {
      if (expected.length !== 1 || existingFile.sha256 !== expected[0]?.sha256) {
        throw new Error(`Existing sources target differs from the verified item payload: ${target}`);
      }
      return [{ ...expected[0]!, bytes: Buffer.from(existingFile.bytes), sha256: existingFile.sha256,
        inputPath: existingFile.path, dev: existingFile.dev, ino: existingFile.ino }];
    }
    if (existingDirectory) throw new Error(`Existing directory conflicts with the planned file target: ${target}`);
    const parent = path.posix.dirname(target);
    if (parent !== "sources" && sourceTree.directories.has(parent)) {
      throw new Error(`Existing source parent conflicts with the new file target: ${parent}`);
    }
    return undefined;
  }
  if (existingFile) throw new Error(`Existing file conflicts with the planned tree target: ${target}`);
  if (!existingDirectory) return undefined;
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const actual = treeRelativeEntries(sourceTree, target).filter(({ path: relative }) => !excluded(relative));
  if (actual.length !== expectedByPath.size || actual.some(({ path: relative, file }) => {
    const wanted = expectedByPath.get(relative);
    return !wanted || wanted.sha256 !== file.sha256;
  })) {
    throw new Error(`Existing sources tree differs from the verified item payload: ${target}`);
  }
  return expected.map((wanted) => {
    const actualFile = sourceTree.files.get(`${target}/${wanted.path}`)!;
    return { ...wanted, bytes: Buffer.from(actualFile.bytes), sha256: actualFile.sha256,
      inputPath: actualFile.path, dev: actualFile.dev, ino: actualFile.ino };
  });
}

function fileMaskedSummary(
  itemId: string,
  file: PlannedPayloadFile,
  descriptor: LegacySavedItem["files"][number],
  registeredSnapshot?: FileState,
): MigrationMaskedDiff {
  const currentText = isText(file.bytes) ? new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) : undefined;
  if (currentText === undefined) {
    const matches = file.sha256 === descriptor.sha256;
    return {
      path: `${itemId}/${file.path}`,
      summary: matches
        ? "binary payload matches the declared legacy snapshot; content is not displayed."
        : "binary payload differs from the declared legacy snapshot; content is not displayed.",
    };
  }

  if (!registeredSnapshot || registeredSnapshot.sha256 !== descriptor.sha256) {
    return {
      path: `${itemId}/${file.path}`,
      summary: file.sha256 === descriptor.sha256
        ? "text payload matches the declared legacy snapshot; content is not displayed."
        : "text payload differs from the declared legacy snapshot, but the registered snapshot is unavailable or unverified; comparison is not displayed.",
    };
  }
  if (!isText(registeredSnapshot.bytes)) {
    return {
      path: `${itemId}/${file.path}`,
      summary: "selected text payload differs from a binary registered snapshot; content is not displayed.",
    };
  }
  if (registeredSnapshot.sha256 === file.sha256) {
    return { path: `${itemId}/${file.path}`, summary: "text payload matches the registered legacy snapshot; no content changes." };
  }

  const beforeText = new TextDecoder("utf-8", { fatal: true }).decode(registeredSnapshot.bytes);
  const patch = maskSensitiveText(createTwoFilesPatch(
    "registered legacy snapshot",
    "selected current source",
    beforeText,
    currentText,
  ));
  return {
    path: `${itemId}/${file.path}`,
    summary: `text payload differs from the registered legacy snapshot; masked diff follows:\n${patch}`,
  };
}

function buildNextCatalog(legacy: LegacyCatalog, selections: readonly { item: LegacySavedItem; target: string; kind: "file" | "tree" }[]): Catalog {
  const byId = new Map(selections.map((selection) => [selection.item.id, selection]));
  const items: SavedItem[] = legacy.items.map((item) => {
    const selection = byId.get(item.id);
    if (!selection) throw new Error(`Legacy item ${item.id} has no safe migration target.`);
    return { ...item, files: item.files.map((file) => ({ ...file })), destination: { ...item.destination }, content: { kind: selection.kind, path: selection.target } } as SavedItem;
  });
  const next: Catalog = { version: 2, items, groups: legacy.groups.map((group) => ({ ...group, itemIds: [...group.itemIds] })) };
  const validated = parseStoredCatalog(next);
  if (validated.version !== 2) throw new Error("Migration target catalog did not validate as v2.");
  return validated;
}

function makeAlreadyV2(
  reviewId: string,
  root: string,
  revision: string,
  rootPresent: boolean,
  rootIdentities: readonly DirectoryIdentity[],
  rootEntries: readonly string[],
  rootDirectoryState?: DirectoryState,
  catalogFile?: FileState,
): PreparedMigration {
  const state: PreparedMigrationState = {
    root, revision, rootPresent,
    rootIdentities: rootIdentities.map((identity) => ({ ...identity })),
    ...(rootDirectoryState ? { rootDirectoryState: { ...rootDirectoryState } } : {}),
    rootEntries: [...rootEntries],
    view: { reviewId, status: "already-v2", items: [], conflicts: [], preservedPaths: [], maskedDiffs: [], sensitivePaths: [], warnings: [] },
    ...(catalogFile ? { inputs: [{ ...catalogFile, bytes: Buffer.from(catalogFile.bytes) }] } : { inputs: [] }),
    backupEntries: [], selections: [], additions: [],
  };
  return makePrepared(state);
}

export async function prepareMigration(libraryDir: string): Promise<PreparedMigration> {
  if (typeof libraryDir !== "string" || libraryDir.length === 0) throw new Error("Migration libraryDir must be a nonempty path string.");
  const root = path.resolve(libraryDir);
  const reviewId = randomUUID();
  try {
    const rootCheck = await checkCanonicalAncestors(root);
    if (!rootCheck.exists) return makeAlreadyV2(reviewId, root, digest(Buffer.from(`absent:${root}`)), false, rootCheck.identities, []);
    const rootNamesBefore = (await readdir(root)).sort(compare);
    const blockers: string[] = [];
    for (const name of [".copi-transaction", ".copi-transaction-recovery", ".migration-backups"]) {
      const stat = await lstat(path.join(root, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat) blockers.push(`${name} exists; preview will not recover, delete, or inspect it.`);
    }
    if (blockers.length > 0) {
      return makePrepared({
        root, revision: digest(Buffer.from(`blocked-locks:${root}:${rootNamesBefore.join("\n")}`)),
        rootPresent: true, rootIdentities: rootCheck.identities,
        ...(rootCheck.rootDirectoryState ? { rootDirectoryState: rootCheck.rootDirectoryState } : {}),
        rootEntries: rootNamesBefore,
        view: { reviewId, status: "blocked", items: [], conflicts: blockers,
          preservedPaths: blockers.map((entry) => entry.split(" ")[0]!), maskedDiffs: [], sensitivePaths: [], warnings: [] },
        inputs: [], backupEntries: [], selections: [], additions: [],
      });
    }

    const catalogStat = await lstat(path.join(root, "catalog.json"), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!catalogStat) throw new Error("catalog.json is missing; no recognized legacy library can be previewed.");
    const catalogFile = await safeReadFile(root, "catalog.json");
    const stored = parseCatalogBytes(catalogFile.bytes);
    if (stored.version === 2) {
      await assertDirectoryChain(rootCheck.identities);
      await assertDirectoryState(rootCheck.rootDirectoryState);
      const rootNamesAfter = (await readdir(root)).sort(compare);
      if (JSON.stringify(rootNamesBefore) !== JSON.stringify(rootNamesAfter)) throw new Error("Library root entries changed during the read-only preview.");
      return makeAlreadyV2(reviewId, root, digest(Buffer.from(`${catalogFile.sha256}:${catalogFile.dev}:${catalogFile.ino}`)), true, rootCheck.identities, rootNamesBefore, rootCheck.rootDirectoryState, catalogFile);
    }
    const legacy = stored;
    const itemsTree = await scanTree(root, "items");
    const sourcesTree = await scanTree(root, "sources");
    const rootNamesAfter = (await readdir(root)).sort(compare);
    if (JSON.stringify(rootNamesBefore) !== JSON.stringify(rootNamesAfter)) throw new Error("Library root entries changed during the read-only preview.");
    await assertDirectoryChain(rootCheck.identities);
    await assertDirectoryState(rootCheck.rootDirectoryState);

    const preservedPaths = new Set<string>();
    const knownRootEntries = new Set(["catalog.json", "items", "sources"]);
    for (const name of rootNamesBefore) if (!knownRootEntries.has(name)) preservedPaths.add(name);
    const expectedItemPaths = new Set<string>();
    for (const item of legacy.items) {
      for (const file of item.files) expectedItemPaths.add(`items/${item.id}/files/${file.path}`);
    }
    const expectedItemDirectories = new Set<string>(["items"]);
    for (const filePath of expectedItemPaths) {
      let parent = path.posix.dirname(filePath);
      while (parent !== ".") {
        expectedItemDirectories.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    for (const filePath of itemsTree.files.keys()) if (!expectedItemPaths.has(filePath)) preservedPaths.add(filePath);
    for (const directory of itemsTree.directories.keys()) if (!expectedItemDirectories.has(directory)) preservedPaths.add(directory);
    const selected = [] as Array<{ item: LegacySavedItem; target: string; kind: "file" | "tree" }>;
    const selectedView: MigrationViewItem[] = [];
    const maskedDiffs: MigrationMaskedDiff[] = [];
    const sensitivePaths = new Set<string>();
    const warnings: MigrationWarning[] = [{ code: "external-origins-not-read", message: "External origin paths are never fetched; only catalog, items, and library sources are read." }];
    const additions: PlannedAddition[] = [];
    const selections: FixedSelection[] = [];

    for (const item of legacy.items) {
      if (!itemIdPattern.test(item.id)) throw new Error("Legacy catalog contains an invalid item UUID.");
      let adoptedSource: ReturnType<typeof currentSourcePayload>;
      try { adoptedSource = currentSourcePayload(root, item, sourcesTree); }
      catch (error) { throw error; }
      let payload: PlannedPayloadFile[];
      let target: string;
      let kind: "file" | "tree";
      let selection: MigrationSelection;
      if (adoptedSource) {
        payload = adoptedSource.files;
        target = adoptedSource.target;
        kind = item.kind === "skill" ? "tree" : "file";
        selection = "sources";
        for (const file of payload) {
          const descriptor = item.files.find((entry) => entry.path === file.path)!;
          maskedDiffs.push(fileMaskedSummary(item.id, file, descriptor, itemsTree.files.get(`items/${item.id}/files/${file.path}`)));
        }
      } else {
        payload = itemsPayload(item, itemsTree);
        if (item.sourcePath.startsWith(path.join(root, "sources") + path.sep)) {
          warnings.push({ code: "origin-missing", message: "The recorded in-library source path is absent; the verified legacy item snapshot is selected.", path: `items/${item.id}` });
        } else {
          warnings.push({ code: "origin-not-read", message: "The recorded external origin was not read; the verified legacy item snapshot is selected.", path: `items/${item.id}` });
        }
        kind = item.kind === "skill" ? "tree" : "file";
        target = kind === "tree" ? `sources/${item.id}` : `sources/${item.id}/${payload[0]!.path}`;
        const existing = existingTargetPayload(target, kind, payload, sourcesTree);
        if (existing) {
          payload = existing;
          selection = "sources";
        } else {
          selection = "items";
          additions.push({ itemId: item.id, target, kind, files: payload.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })) });
        }
        for (const file of payload) {
          const descriptor = item.files.find((entry) => entry.path === file.path)!;
          maskedDiffs.push(fileMaskedSummary(item.id, file, descriptor, itemsTree.files.get(`items/${item.id}/files/${file.path}`)));
        }
      }
      selected.push({ item, target, kind });
      selections.push({ itemId: item.id, target, kind, selection, files: payload.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })) });
      selectedView.push({ id: item.id, name: item.name, target, selection });
      const inspection = inspectFixedResource({
        candidate: { ...item, sourceRoot: path.dirname(item.sourcePath) },
        files: payload.map((file) => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.bytes) })),
        excludedPaths: [],
      });
      for (const filePath of inspection.sensitivePaths) sensitivePaths.add(`${item.id}/${filePath}`);
      for (const warning of inspection.warnings) warnings.push({
        code: warning.code,
        message: warning.message,
        ...(warning.path === undefined ? {} : { path: `${item.id}/${warning.path}` }),
      });
    }

    const expectedSourceDirectories = new Set<string>(["sources"]);
    for (const entry of selected) {
      const targetDirectory = entry.kind === "tree" ? entry.target : path.posix.dirname(entry.target);
      let parent = targetDirectory;
      while (parent !== ".") {
        expectedSourceDirectories.add(parent);
        parent = path.posix.dirname(parent);
      }
      if (entry.kind === "tree") {
        for (const directory of sourcesTree.directories.keys()) {
          if (isWithin(path.join(root, entry.target), path.join(root, directory))) expectedSourceDirectories.add(directory);
        }
      }
    }
    for (const directory of sourcesTree.directories.keys()) {
      if (!expectedSourceDirectories.has(directory)) preservedPaths.add(directory);
      if (excluded(directory.slice("sources/".length))) preservedPaths.add(directory);
    }
    for (const relative of sourcesTree.files.keys()) {
      if (!selected.some((entry) => isWithin(path.join(root, entry.target), path.join(root, relative))) &&
          !selected.some((entry) => isWithin(path.join(root, relative), path.join(root, entry.target)))) preservedPaths.add(relative);
      if (excluded(relative.slice("sources/".length))) preservedPaths.add(relative);
    }
    const nextCatalog = buildNextCatalog(legacy, selected);
    const catalogPaths = new Set<string>();
    for (const item of nextCatalog.items) {
      if (catalogPaths.has(item.content.path)) throw new Error("Two legacy items resolve to the same sources target.");
      catalogPaths.add(item.content.path);
    }
    const inputs = [catalogFile, ...itemsTree.files.values(), ...sourcesTree.files.values()].sort((left, right) => compare(left.path, right.path));
    const backupEntries = inputs.map(({ path: originalPath, sha256, mode }) => ({ originalPath, sha256, mode }));
    const backupManifestBytes = buildMigrationBackupManifest(backupEntries);
    const rootDirectoryState = rootCheck.rootDirectoryState;
    if (!rootDirectoryState) throw new Error("Library root directory state is unavailable.");
    const revision = inventoryDigest(rootCheck.identities, rootDirectoryState, catalogFile, [itemsTree, sourcesTree]);
    const conflicts: string[] = [];
    const view: MigrationView = {
      reviewId,
      status: conflicts.length === 0 ? "ready" : "blocked",
      items: selectedView,
      conflicts,
      preservedPaths: [...preservedPaths].sort(compare),
      maskedDiffs,
      sensitivePaths: [...sensitivePaths].sort(compare),
      warnings,
    };
    return makePrepared({
      root,
      revision,
      rootPresent: true,
      rootIdentities: rootCheck.identities.map((identity) => ({ ...identity })),
      rootDirectoryState: { ...rootDirectoryState },
      rootEntries: [...rootNamesBefore],
      itemsTree,
      sourcesTree,
      view,
      oldCatalogBytes: Buffer.from(catalogFile.bytes),
      oldCatalog: legacy,
      nextCatalog,
      inputs: inputs.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
      backupManifestBytes: Buffer.from(backupManifestBytes),
      backupEntries: backupEntries.map((entry) => ({ ...entry })),
      selections: selections.map((selection) => ({ ...selection, files: selection.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })) })),
      additions: additions.map((addition) => ({ ...addition, files: addition.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })) })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The legacy library could not be safely previewed.";
    return makePrepared({
      root,
      revision: digest(Buffer.from(`blocked:${root}:${message}`)),
      view: blockedView(reviewId, message),
      inputs: [], backupEntries: [], selections: [], additions: [],
    });
  }
}

export function readMigration(plan: PreparedMigration): MigrationView {
  if (typeof plan !== "object" || plan === null || !preparedStates.has(plan)) {
    throw new Error("Invalid prepared migration token.");
  }
  const state = preparedStates.get(plan);
  if (!state) throw new Error("Prepared migration is unavailable.");
  return cloneView(state.view);
}
