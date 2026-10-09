import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { MigrationInventoryNode, MigrationStartInventory } from "./storage-journal.ts";

interface ScannedNode {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly dev: string;
  readonly ino: string;
  readonly bytesHash?: string;
  readonly children?: readonly { name: string; kind: "file" | "directory" }[];
}

interface ScanResult {
  readonly inventory: MigrationStartInventory;
  readonly transientState: string;
}

export interface MigrationInventoryScanOptions {
  readonly excludedPrefixes?: readonly string[];
  readonly rootScope?: "library" | "subtree";
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Migration inventory contains a non-JSON value.");
  return encoded;
}

function sameNodeState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileMode(stat: BigIntStats): number {
  return Number(stat.mode & 0o7777n);
}

function decodeName(name: Buffer): string {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(name); }
  catch { throw new Error("Migration inventory encountered a non-UTF-8 filesystem name; refusing to omit it."); }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") ||
      decoded.includes("\0") || !Buffer.from(decoded, "utf8").equals(name)) {
    throw new Error("Migration inventory encountered a noncanonical filesystem name.");
  }
  return decoded;
}

const managedRootNames = new Set([
  "catalog.json", "items", "sources", ".migration-backups", ".copi-transaction", ".copi-transaction-recovery",
]);
const resolutionPrefixBytes = Buffer.from(".copi-migration-resolution", "ascii");

function managedRootName(raw: Buffer): string | undefined {
  if (!raw.subarray(0, resolutionPrefixBytes.length).equals(resolutionPrefixBytes)) {
    const exact = [...managedRootNames].find((name) => raw.equals(Buffer.from(name, "ascii")));
    if (!exact) return undefined;
  }
  return decodeName(raw);
}

export function isManagedMigrationRootName(name: string): boolean {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (managedRootNames.has(name) || name.startsWith(".copi-migration-resolution")) return true;
  return false;
}

export async function listManagedMigrationRootEntries(root: string): Promise<string[]> {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || await realpath(root) !== root) {
    throw new Error("Managed migration root listing requires a canonical absolute library root.");
  }
  const names = await readdir(root, { encoding: "buffer" });
  return names.map(managedRootName).filter((name): name is string => name !== undefined).sort(compareUtf8);
}

function sameRootState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.isDirectory() && right.isDirectory() && !left.isSymbolicLink() && !right.isSymbolicLink();
}

function selectedNames(
  rawNames: readonly Buffer[],
  relative: string,
  rootScope: "library" | "subtree",
  excludedPrefixes: readonly string[],
): Array<{ raw: Buffer; name: string }> {
  const selected: Array<{ raw: Buffer; name: string }> = [];
  for (const raw of rawNames) {
    const name = relative === "." && rootScope === "library" ? managedRootName(raw) : decodeName(raw);
    if (name === undefined) continue;
    const childPath = relative === "." ? name : `${relative}/${name}`;
    if (excludedPrefixes.some((prefix) => childPath === prefix || childPath.startsWith(`${prefix}/`))) continue;
    selected.push({ raw, name });
  }
  selected.sort((left, right) => Buffer.compare(left.raw, right.raw));
  return selected;
}

async function scanOnce(root: string, excludedPrefixes: readonly string[], rootScope: "library" | "subtree"): Promise<ScanResult> {
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Migration inventory root must be a canonical real directory.");
  }
  const nodes = new Map<string, ScannedNode>();
  const transient: string[] = [];
  const visit = async (absolute: string, relative: string, expected?: BigIntStats): Promise<void> => {
    const before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink()) throw new Error(`Migration inventory encountered a symbolic link: ${relative}`);
    if (expected && !(relative === "." ? sameRootState(expected, before) : sameNodeState(expected, before))) {
      throw new Error(`Migration inventory directory changed while scanning: ${relative}`);
    }
    const kind: ScannedNode["kind"] | undefined = before.isDirectory() ? "directory" : before.isFile() ? "file" : undefined;
    if (!kind) throw new Error(`Migration inventory encountered a special filesystem node: ${relative}`);
    if (await realpath(absolute) !== absolute) throw new Error(`Migration inventory path is not canonical: ${relative}`);
    const base = { path: relative, kind, mode: fileMode(before), dev: before.dev.toString(), ino: before.ino.toString() };
    transient.push(relative === "."
      ? `${relative}:${before.dev}:${before.ino}:${before.mode}`
      : `${relative}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`);
    if (kind === "file") {
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !sameNodeState(before, opened)) throw new Error(`Migration inventory file changed while opening: ${relative}`);
        const bytes = await handle.readFile();
        const [afterHandle, afterPath, canonical] = await Promise.all([
          handle.stat({ bigint: true }), lstat(absolute, { bigint: true }), realpath(absolute),
        ]);
        if (!afterPath.isFile() || afterPath.isSymbolicLink() || canonical !== absolute ||
            !sameNodeState(opened, afterHandle) || !sameNodeState(opened, afterPath)) {
          throw new Error(`Migration inventory file changed while reading: ${relative}`);
        }
        nodes.set(relative, { ...base, bytesHash: sha256(bytes) });
      } finally { await handle.close(); }
      return;
    }

    const beforeNames = selectedNames(await readdir(absolute, { encoding: "buffer" }), relative, rootScope, excludedPrefixes);
    if (beforeNames.some((entry, index) => index > 0 && Buffer.compare(beforeNames[index - 1]!.raw, entry.raw) === 0)) {
      throw new Error(`Migration inventory encountered duplicate directory names: ${relative}`);
    }
    const children: Array<{ name: string; kind: "file" | "directory" }> = [];
    for (const entry of beforeNames) {
      const childPath = relative === "." ? entry.name : `${relative}/${entry.name}`;
      const childAbsolute = path.join(absolute, entry.name);
      const childStat = await lstat(childAbsolute, { bigint: true });
      if (childStat.isSymbolicLink()) throw new Error(`Migration inventory encountered a symbolic link: ${childPath}`);
      const childKind: ScannedNode["kind"] | undefined = childStat.isDirectory() ? "directory" : childStat.isFile() ? "file" : undefined;
      if (!childKind) throw new Error(`Migration inventory encountered a special filesystem node: ${childPath}`);
      children.push({ name: entry.name, kind: childKind });
      await visit(childAbsolute, childPath, childStat);
    }
    const [after, rawAfterNames, canonical] = await Promise.all([
      lstat(absolute, { bigint: true }), readdir(absolute, { encoding: "buffer" }), realpath(absolute),
    ]);
    const afterNames = selectedNames(rawAfterNames, relative, rootScope, excludedPrefixes);
    const directoryStateMatches = relative === "." ? sameRootState(before, after) : sameNodeState(before, after);
    if (!directoryStateMatches || canonical !== absolute || afterNames.length !== beforeNames.length ||
        beforeNames.some((entry, index) => !entry.raw.equals(afterNames[index]!.raw))) {
      throw new Error(`Migration inventory directory changed while scanning: ${relative}`);
    }
    nodes.set(relative, { ...base, children });
  };

  await visit(root, ".", rootBefore);
  const rootAfter = await lstat(root, { bigint: true });
  if (!sameRootState(rootBefore, rootAfter) || await realpath(root) !== root) {
    throw new Error("Migration library root changed while capturing its inventory.");
  }
  const identities = new Set<string>();
  const inventoryNodes: MigrationInventoryNode[] = [];
  for (const node of [...nodes.values()].sort((left, right) => compareUtf8(left.path, right.path))) {
    const identity = `${node.dev}:${node.ino}`;
    if (identities.has(identity)) throw new Error(`Migration inventory contains an unsafe hardlink alias: ${node.path}`);
    identities.add(identity);
    const bytesHash = node.kind === "file"
      ? node.bytesHash!
      : sha256(Buffer.concat([
        Buffer.from("copi-directory-v1\0", "utf8"),
        Buffer.from(canonicalJson((node.children ?? []).map(({ name, kind }) => [name, kind])), "utf8"),
      ]));
    inventoryNodes.push({ path: node.path, kind: node.kind, mode: node.mode, dev: node.dev, ino: node.ino, bytesHash });
  }
  const inventory: MigrationStartInventory = {
    version: 1,
    nodes: inventoryNodes,
    hash: sha256(Buffer.concat([
      Buffer.from("copi-inventory-v1\0", "utf8"),
      Buffer.from(canonicalJson(inventoryNodes), "utf8"),
    ])),
  };
  return { inventory, transientState: transient.sort(compareUtf8).join("\n") };
}

export function projectMigrationInventory(
  inventory: MigrationStartInventory,
  excludedPrefixes: readonly string[],
  omittedProofPaths: readonly string[] = [],
): MigrationStartInventory {
  const excluded = (nodePath: string): boolean => excludedPrefixes.some((prefix) =>
    nodePath === prefix || nodePath.startsWith(`${prefix}/`));
  const proofOmissions = new Set(omittedProofPaths);
  const allNodes = inventory.nodes.filter((node) => !excluded(node.path));
  const nodes = allNodes.filter((node) => !proofOmissions.has(node.path)).map((node) => {
    if (node.kind !== "directory") return { ...node };
    // Omitted proofs are absent from the projected namespace, including the directory child-list commitment.
    const children = allNodes.filter((candidate) => candidate.path !== node.path && !proofOmissions.has(candidate.path) &&
      path.posix.dirname(candidate.path) === node.path)
      .map((candidate) => [path.posix.basename(candidate.path), candidate.kind] as const)
      .sort(([left], [right]) => compareUtf8(left, right));
    return {
      ...node,
      bytesHash: sha256(Buffer.concat([
        Buffer.from("copi-directory-v1\0", "utf8"),
        Buffer.from(canonicalJson(children), "utf8"),
      ])),
    };
  });
  return {
    version: 1,
    nodes,
    hash: sha256(Buffer.concat([
      Buffer.from("copi-inventory-v1\0", "utf8"),
      Buffer.from(canonicalJson(nodes), "utf8"),
    ])),
  };
}

export async function scanMigrationInventory(libraryDir: string, options: MigrationInventoryScanOptions = {}): Promise<MigrationStartInventory> {
  if (typeof libraryDir !== "string" || !path.isAbsolute(libraryDir) || path.resolve(libraryDir) !== libraryDir ||
      await realpath(libraryDir) !== libraryDir) {
    throw new Error("Migration inventory requires a canonical absolute library root.");
  }
  const excludedPrefixes = options.excludedPrefixes ?? [];
  const rootScope = options.rootScope ?? "library";
  if (rootScope !== "library" && rootScope !== "subtree") throw new Error("Migration inventory root scope must be library or subtree.");
  if (!Array.isArray(excludedPrefixes) || excludedPrefixes.some((prefix) => typeof prefix !== "string" ||
      !prefix || prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0") ||
      prefix.split("/").some((part) => part === "" || part === "." || part === ".."))) {
    throw new Error("Migration inventory exclusion prefixes must be canonical library-relative paths.");
  }
  const first = await scanOnce(libraryDir, excludedPrefixes, rootScope);
  const second = await scanOnce(libraryDir, excludedPrefixes, rootScope);
  if (first.inventory.hash !== second.inventory.hash || first.transientState !== second.transientState ||
      canonicalJson(first.inventory.nodes) !== canonicalJson(second.inventory.nodes)) {
    throw new Error("Migration inventory changed between the required complete scans.");
  }
  return structuredClone(first.inventory);
}
