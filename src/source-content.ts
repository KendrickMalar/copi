import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ContentLocation, SavedItem, SnapshotFileContents } from "./types.ts";

const excludedNames = new Set([
  ".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions",
  "auth.json", "mcp-auth.json", "oauth.json",
]);
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function safeRelativePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
    !path.posix.isAbsolute(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    path.posix.normalize(value) === value;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function excludedPath(value: string): boolean {
  return value.split("/").some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === ".env" || lower.startsWith(".env");
  });
}

function assertContentLocation(value: unknown): asserts value is ContentLocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid content location in copi catalog.");
  const content = value as Record<string, unknown>;
  if ((content.kind !== "file" && content.kind !== "tree") || typeof content.path !== "string" ||
      !safeRelativePath(content.path) || !content.path.startsWith("sources/") || excludedPath(content.path.slice("sources/".length))) {
    throw new Error("Invalid or unsafe content path in copi catalog; content must be a safe path below sources/.");
  }
}

export function validateContentLocations(items: readonly SavedItem[]): void {
  const locations: Array<{ id: string; location: ContentLocation }> = [];
  for (const item of items) {
    assertContentLocation(item.content);
    if (item.content.kind !== (item.kind === "skill" ? "tree" : "file")) {
      throw new Error(`Invalid content kind for ${item.kind} item ${item.id}.`);
    }
    if (item.files.length === 0) throw new Error(`Content item ${item.id} has no registered files.`);
    if (item.content.kind === "file") {
      const registered = item.files.length === 1 && item.files[0]?.path === path.posix.basename(item.content.path);
      if (!registered) throw new Error(`File content for ${item.id} must register exactly its content file.`);
    }
    locations.push({ id: item.id, location: item.content });
  }
  for (let index = 0; index < locations.length; index += 1) {
    const current = locations[index]!;
    for (const other of locations.slice(index + 1)) {
      const left = current.location.path;
      const right = other.location.path;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new Error(`Duplicate or overlapping content locations for items ${current.id} and ${other.id}.`);
      }
    }
  }
}

async function safeLibraryRoot(libraryDir: string): Promise<string> {
  const requested = path.resolve(libraryDir);
  const rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Copi content root is not a safe directory.");
  const root = await realpath(requested);
  if (root !== requested) throw new Error("Copi content root changed through a symbolic link.");
  return root;
}

async function checkedPath(root: string, relative: string, directory: boolean): Promise<string> {
  if (!safeRelativePath(relative)) throw new Error("Catalog contains an unsafe content path.");
  const target = path.resolve(root, ...relative.split("/"));
  if (!isWithin(root, target)) throw new Error("Content path escapes the copi library.");
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Content contains an unsafe symbolic link.");
  }
  const canonical = await realpath(target);
  if (!isWithin(root, canonical)) throw new Error("Content path resolves outside the copi library.");
  const stat = await lstat(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Content path is not a regular ${directory ? "directory" : "file"}.`);
  return target;
}

async function readRegularFile(libraryRoot: string, contentRoot: string, target: string): Promise<{ bytes: Buffer; mode: number }> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Source content is not a regular file or is a symbolic link.");
  const canonical = await realpath(target);
  if (!isWithin(libraryRoot, canonical) || !isWithin(contentRoot, canonical)) throw new Error("Source content resolves outside its registered content location.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Source content inode changed while it was being opened.");
    const bytes = await handle.readFile();
    const after = await lstat(target);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("Source content inode changed during reading.");
    return { bytes, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function readSourceContent(libraryDir: string, item: SavedItem): Promise<SnapshotFileContents[]> {
  validateContentLocations([item]);
  const libraryRoot = await safeLibraryRoot(libraryDir);
  const sourcesRoot = await checkedPath(libraryRoot, "sources", true);
  const contentRoot = await checkedPath(libraryRoot, item.content.path, item.content.kind === "tree");
  if (!isWithin(sourcesRoot, contentRoot)) throw new Error("Content path escapes the canonical sources root.");

  const descriptors = new Map(item.files.map((file) => [file.path, file]));
  const results: SnapshotFileContents[] = [];
  const readAt = async (absolutePath: string, relativePath: string): Promise<void> => {
    if (!safeRelativePath(relativePath)) throw new Error("Source content contains an unsafe relative file path.");
    if (excludedPath(relativePath)) return;
    const value = await readRegularFile(libraryRoot, contentRoot, absolutePath);
    const descriptor = descriptors.get(relativePath);
    results.push({
      path: relativePath,
      mode: descriptor?.mode ?? value.mode,
      sha256: digest(value.bytes),
      bytes: value.bytes,
    });
  };

  if (item.content.kind === "file") {
    const filePath = path.posix.basename(item.content.path);
    if (excludedPath(filePath)) throw new Error("Registered source content is in an excluded path.");
    await readAt(contentRoot, filePath);
  } else {
    const visit = async (directory: string, relative: string): Promise<void> => {
      const before = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (!before.isDirectory() || before.isSymbolicLink() || !isWithin(contentRoot, canonicalDirectory)) throw new Error("Source tree contains an unsafe non-directory or symbolic link.");
      const names = await readdir(directory);
      for (const name of names.sort((left, right) => left.localeCompare(right))) {
        const childRelative = relative ? `${relative}/${name}` : name;
        if (excludedPath(childRelative)) continue;
        const childPath = path.join(directory, name);
        const stat = await lstat(childPath);
        if (stat.isSymbolicLink()) throw new Error("Source tree contains an unsafe symbolic link.");
        if (stat.isDirectory()) await visit(childPath, childRelative);
        else if (stat.isFile()) await readAt(childPath, childRelative);
        else throw new Error("Source tree contains an unsupported special file.");
      }
      const after = await lstat(directory);
      const finalNames = await readdir(directory);
      if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || JSON.stringify(finalNames.sort((left, right) => left.localeCompare(right))) !== JSON.stringify(names.sort((left, right) => left.localeCompare(right)))) {
        throw new Error("Source tree directory changed while it was being read.");
      }
    };
    await visit(contentRoot, "");
    if (item.kind === "skill" && !results.some((file) => file.path === "SKILL.md")) {
      throw new Error("Skill content is missing required root SKILL.md.");
    }
  }
  if (results.length === 0) throw new Error("Source content contains no readable files.");
  results.sort((left, right) => left.path.localeCompare(right.path));
  return results;
}
