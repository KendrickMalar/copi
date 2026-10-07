import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface MigrationBackupInputEntry {
  readonly originalPath: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface MigrationBackupManifestEntry extends MigrationBackupInputEntry {
  readonly backupPath: string;
}

export interface MigrationBackupManifest {
  readonly version: 1;
  readonly entries: readonly MigrationBackupManifestEntry[];
}

export interface MigrationBackupExpected {
  readonly libraryRoot: string;
  readonly backupDir: string;
  readonly manifestBytes: Buffer;
  readonly manifestSha256: string;
  readonly entries: readonly MigrationBackupInputEntry[];
}

interface DirectoryState {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
}

interface ExpectedChildren {
  readonly directories: Set<string>;
  readonly files: Set<string>;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const backupUuidPattern = /^\.migration-backups\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const manifestName = "manifest.json";
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeOriginalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
      path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  return value === "catalog.json" || (parts.length > 1 && (parts[0] === "items" || parts[0] === "sources"));
}

function normalizeInputEntries(value: unknown): MigrationBackupInputEntry[] {
  if (!Array.isArray(value)) throw new Error("Migration backup entries must be an array.");
  const entries: MigrationBackupInputEntry[] = value.map((entry: unknown) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["originalPath", "sha256", "mode"]) ||
        !safeOriginalPath(entry.originalPath) || typeof entry.sha256 !== "string" || !sha256Pattern.test(entry.sha256) ||
        typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("Invalid path, SHA-256 digest, mode, or fields in migration backup entry.");
    }
    return { originalPath: entry.originalPath, sha256: entry.sha256, mode: entry.mode };
  });
  entries.sort((left, right) => compareStrings(left.originalPath, right.originalPath));
  if (!entries.some((entry) => entry.originalPath === "catalog.json")) {
    throw new Error("Migration backup manifest must cover catalog.json.");
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!.originalPath;
    const current = entries[index]!.originalPath;
    if (previous === current || current.startsWith(`${previous}/`)) {
      throw new Error("Duplicate or overlapping paths in migration backup manifest.");
    }
  }
  return entries;
}

function serializeManifest(entries: readonly MigrationBackupInputEntry[]): Buffer {
  const manifest: MigrationBackupManifest = {
    version: 1,
    entries: entries.map((entry) => ({
      originalPath: entry.originalPath,
      backupPath: `files/${entry.originalPath}`,
      sha256: entry.sha256,
      mode: entry.mode,
    })),
  };
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

export function buildMigrationBackupManifest(entries: readonly MigrationBackupInputEntry[]): Buffer {
  return serializeManifest(normalizeInputEntries(entries));
}

function parseManifestObject(value: unknown): MigrationBackupManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "entries"]) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Invalid migration backup manifest envelope.");
  }
  const entries: MigrationBackupManifestEntry[] = [];
  let previousPath: string | undefined;
  for (const valueEntry of value.entries as unknown[]) {
    if (!isRecord(valueEntry) || !hasExactKeys(valueEntry, ["originalPath", "backupPath", "sha256", "mode"]) ||
        !safeOriginalPath(valueEntry.originalPath) || valueEntry.backupPath !== `files/${valueEntry.originalPath}` ||
        typeof valueEntry.sha256 !== "string" || !sha256Pattern.test(valueEntry.sha256) ||
        typeof valueEntry.mode !== "number" || !Number.isInteger(valueEntry.mode) || valueEntry.mode < 0 || valueEntry.mode > 0o777) {
      throw new Error("Invalid path, backup mapping, SHA-256 digest, mode, or fields in migration backup manifest entry.");
    }
    if (previousPath !== undefined && compareStrings(previousPath, valueEntry.originalPath) >= 0) {
      throw new Error("Migration backup manifest entries are not in strict canonical order.");
    }
    previousPath = valueEntry.originalPath;
    entries.push({
      originalPath: valueEntry.originalPath,
      backupPath: valueEntry.backupPath,
      sha256: valueEntry.sha256,
      mode: valueEntry.mode,
    });
  }
  const normalized = normalizeInputEntries(entries.map(({ originalPath, sha256, mode }) => ({ originalPath, sha256, mode })));
  if (normalized.length !== entries.length) throw new Error("Invalid migration backup manifest coverage.");
  return { version: 1, entries };
}

export function parseMigrationBackupManifest(bytes: Buffer): MigrationBackupManifest {
  if (!Buffer.isBuffer(bytes)) throw new Error("Migration backup manifest must be supplied as fixed bytes.");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid JSON in migration backup manifest.");
  }
  const manifest = parseManifestObject(value);
  const expectedBytes = serializeManifest(manifest.entries.map(({ originalPath, sha256, mode }) => ({ originalPath, sha256, mode })));
  if (!bytes.equals(expectedBytes)) throw new Error("Migration backup manifest bytes are not in the fixed canonical encoding.");
  return manifest;
}

function isDirectoryPath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function stableDirectoryState(target: string, stat: BigIntStats): DirectoryState {
  return {
    path: target,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameDirectoryState(left: DirectoryState, right: DirectoryState): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function directoryIdentity(state: DirectoryState): DirectoryIdentity {
  return { path: state.path, dev: state.dev, ino: state.ino, mode: state.mode };
}

async function canonicalDirectoryChain(root: string): Promise<DirectoryIdentity[]> {
  if (!isDirectoryPath(root)) throw new Error("Migration backup library root must be an absolute canonical path.");
  const identities: DirectoryIdentity[] = [];
  const rootName = path.parse(root).root;
  let current = rootName;
  const rootStat = await lstat(current, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(current) !== current) {
    throw new Error("Migration backup library root has an unsafe filesystem root.");
  }
  identities.push({ path: current, dev: rootStat.dev, ino: rootStat.ino, mode: rootStat.mode });
  const segments = root.slice(rootName.length).split(path.sep).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error("Migration backup library root or an ancestor is not a canonical real directory.");
    }
    identities.push({ path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode });
  }
  return identities;
}

async function assertDirectoryIdentities(states: readonly DirectoryIdentity[]): Promise<void> {
  for (const expected of states) {
    const current = await lstat(expected.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
        current.mode !== expected.mode || await realpath(expected.path) !== expected.path) {
      throw new Error("Migration backup directory identity or canonical path changed during verification.");
    }
  }
}

async function checkedPrivateDirectory(target: string, libraryRoot: string, expectedMode: number): Promise<DirectoryState> {
  if (!isWithin(libraryRoot, target)) throw new Error("Migration backup directory escapes its canonical library root.");
  const before = await lstat(target, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o7777n) !== BigInt(expectedMode) || await realpath(target) !== target) {
    throw new Error("Migration backup contains a noncanonical directory or one with the wrong private mode.");
  }
  return stableDirectoryState(target, before);
}

async function assertDirectoryUnchanged(expected: DirectoryState): Promise<void> {
  const [after, canonical] = await Promise.all([lstat(expected.path, { bigint: true }), realpath(expected.path)]);
  if (!after.isDirectory() || after.isSymbolicLink() || canonical !== expected.path ||
      !sameDirectoryState(expected, stableDirectoryState(expected.path, after))) {
    throw new Error("Migration backup directory changed while it was being enumerated.");
  }
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

async function readPrivateFile(
  target: string,
  libraryRoot: string,
  expectedAncestors: readonly DirectoryIdentity[],
): Promise<Buffer> {
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777n) !== BigInt(privateFileMode) || await realpath(target) !== target ||
      !isWithin(libraryRoot, target)) {
    throw new Error("Migration backup contains a noncanonical, nonregular, or nonprivate file.");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileState(before, opened)) throw new Error("Migration backup file changed while it was opened.");
    const bytes = await handle.readFile();
    const [afterHandle, afterPath, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(target, { bigint: true }),
      realpath(target),
    ]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || canonicalAfter !== target ||
        !sameFileState(opened, afterHandle) || !sameFileState(opened, afterPath)) {
      throw new Error("Migration backup file identity, mode, or bytes changed while being read.");
    }
    await assertDirectoryIdentities(expectedAncestors);
    return bytes;
  } finally {
    await handle.close();
  }
}

function expectedTree(manifest: MigrationBackupManifest): Map<string, ExpectedChildren> {
  const children = new Map<string, ExpectedChildren>();
  const ensure = (directory: string): ExpectedChildren => {
    let value = children.get(directory);
    if (!value) {
      value = { directories: new Set<string>(), files: new Set<string>() };
      children.set(directory, value);
    }
    return value;
  };
  ensure(".");
  ensure("files");
  ensure(".").files.add(manifestName);
  ensure(".").directories.add("files");
  for (const entry of manifest.entries) {
    const relative = entry.backupPath;
    const parts = relative.split("/");
    let current = "";
    for (const part of parts.slice(0, -1)) {
      const parent = current || ".";
      current = current ? `${current}/${part}` : part;
      ensure(parent).directories.add(part);
      ensure(current);
    }
    ensure(current || ".").files.add(parts.at(-1)!);
  }
  return children;
}

export async function verifyMigrationBackup(expectedValue: MigrationBackupExpected): Promise<void> {
  if (!isRecord(expectedValue) || !hasExactKeys(expectedValue, ["libraryRoot", "backupDir", "manifestBytes", "manifestSha256", "entries"]) ||
      typeof expectedValue.libraryRoot !== "string" || typeof expectedValue.backupDir !== "string" ||
      !Buffer.isBuffer(expectedValue.manifestBytes) || typeof expectedValue.manifestSha256 !== "string" ||
      !sha256Pattern.test(expectedValue.manifestSha256)) {
    throw new Error("Invalid fixed migration backup verification expectation.");
  }
  const libraryRoot = expectedValue.libraryRoot;
  const backupDir = expectedValue.backupDir;
  if (!backupUuidPattern.test(backupDir) || path.posix.normalize(backupDir) !== backupDir) {
    throw new Error("Migration backup directory must be the canonical relative .migration-backups UUID path.");
  }
  const manifestBytes = Buffer.from(expectedValue.manifestBytes);
  const manifestSha256 = expectedValue.manifestSha256;
  const inputEntries = normalizeInputEntries(expectedValue.entries);
  if (digest(manifestBytes) !== manifestSha256) throw new Error("Fixed migration backup manifest bytes do not match their expected SHA-256.");
  const expectedManifest = parseMigrationBackupManifest(manifestBytes);
  if (!buildMigrationBackupManifest(inputEntries).equals(manifestBytes) ||
      expectedManifest.entries.length !== inputEntries.length) {
    throw new Error("Fixed migration backup manifest does not exactly cover the expected input entries.");
  }
  for (let index = 0; index < inputEntries.length; index += 1) {
    const input = inputEntries[index]!;
    const manifestEntry = expectedManifest.entries[index]!;
    if (input.originalPath !== manifestEntry.originalPath || input.sha256 !== manifestEntry.sha256 || input.mode !== manifestEntry.mode) {
      throw new Error("Fixed migration backup manifest entry differs from the expected input coverage.");
    }
  }

  const rootIdentities = await canonicalDirectoryChain(libraryRoot);
  const backupParent = path.join(libraryRoot, ".migration-backups");
  const backupParentState = await checkedPrivateDirectory(backupParent, libraryRoot, privateDirectoryMode);
  const backupRoot = path.join(libraryRoot, ...backupDir.split("/"));
  const children = expectedTree(expectedManifest);
  const expectedFileEntries = new Map<string, MigrationBackupManifestEntry>();
  for (const entry of expectedManifest.entries) expectedFileEntries.set(entry.backupPath, entry);

  const visit = async (relative: string, ancestors: readonly DirectoryIdentity[]): Promise<void> => {
    const target = relative === "." ? backupRoot : path.join(backupRoot, ...relative.split("/"));
    const state = await checkedPrivateDirectory(target, libraryRoot, privateDirectoryMode);
    const expectedChildren = children.get(relative);
    if (!expectedChildren) throw new Error("Unexpected directory in migration backup.");
    const names = (await readdir(target)).sort(compareStrings);
    const expectedNames = [...expectedChildren.directories, ...expectedChildren.files].sort(compareStrings);
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
      throw new Error("Migration backup has missing or unknown extra filesystem entries.");
    }
    const currentAncestors = [...ancestors, directoryIdentity(state)];
    for (const name of names) {
      const childRelative = relative === "." ? name : `${relative}/${name}`;
      if (expectedChildren.directories.has(name)) {
        await visit(childRelative, currentAncestors);
        continue;
      }
      const bytes = await readPrivateFile(path.join(target, name), libraryRoot, [...rootIdentities, ...currentAncestors]);
      if (childRelative === manifestName) {
        if (!bytes.equals(manifestBytes) || digest(bytes) !== manifestSha256) {
          throw new Error("Stored migration backup manifest differs from the fixed manifest bytes or hash.");
        }
        const parsed = parseMigrationBackupManifest(bytes);
        if (parsed.entries.length !== expectedManifest.entries.length) throw new Error("Stored migration backup manifest coverage changed.");
        continue;
      }
      const manifestEntry = expectedFileEntries.get(childRelative);
      if (!manifestEntry || digest(bytes) !== manifestEntry.sha256) {
        throw new Error("Migration backup data is missing its fixed entry or does not match the expected SHA-256.");
      }
    }
    const finalNames = (await readdir(target)).sort(compareStrings);
    await assertDirectoryUnchanged(state);
    if (names.length !== finalNames.length || names.some((name, index) => name !== finalNames[index])) {
      throw new Error("Migration backup directory entries changed during verification.");
    }
  };

  await visit(".", [
    ...rootIdentities,
    directoryIdentity(backupParentState),
  ]);
  await assertDirectoryIdentities(rootIdentities);
  await assertDirectoryUnchanged(backupParentState);
}
