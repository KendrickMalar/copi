import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { createTwoFilesPatch } from "diff";
import { inspectFixedResource, maskSensitiveText } from "./inspect.ts";
import { parseStoredCatalog } from "./catalog.ts";
import { parseMigrationBackupManifest, verifyMigrationBackup } from "./migration-backup.ts";
import { projectMigrationInventory, scanMigrationInventory } from "./migration-inventory.ts";
import { acquireRootLease, type StorageRootLease } from "./storage-root-lease.ts";
import {
  canonicalStorageJournalJson,
  parseMigrationStartInventory,
  parseStorageJournal,
  validateLegacyMigrationJournalTargets,
  type LegacyMigrationStorageJournalV5,
  type MigrationInventoryNode,
  type MigrationStartInventory,
} from "./storage-journal.ts";
import type { ChangeApproval } from "./resource-mutations.ts";
import type { MigrationMaskedDiff, MigrationResult, MigrationViewItem, MigrationWarning } from "./migration.ts";
import type { Catalog, LegacyCatalog, LegacySavedItem, SavedItem } from "./types.ts";

const lockName = ".copi-transaction";
const claimName = ".copi-transaction-recovery";
const recordName = ".copi-migration-resolution.json";
const resolutionTempPrefix = ".copi-migration-resolution.";
const excludedNames = new Set([
  ".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions",
  "auth.json", "mcp-auth.json", "oauth.json",
]);
const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Pattern = /^(0|[1-9][0-9]*)$/;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

declare const preparedMigrationResolutionBrand: unique symbol;
export interface PreparedMigrationResolution {
  readonly [preparedMigrationResolutionBrand]: true;
  readonly reviewId: string;
}
export type MigrationResolutionStatus = "ready" | "blocked" | "not-needed";
export interface MigrationResolutionView {
  readonly reviewId: string;
  readonly status: MigrationResolutionStatus;
  readonly backupDir: string | null;
  readonly items: readonly MigrationViewItem[];
  readonly conflicts: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly maskedDiffs: readonly MigrationMaskedDiff[];
  readonly sensitivePaths: readonly string[];
  readonly warnings: readonly MigrationWarning[];
}

export type MigrationResolutionCheckpoint =
  | "lease-acquired" | "before-claim-mkdir" | "after-claim-mkdir" | "after-claim-owner-temp-write" | "after-claim-owner-temp-sync"
  | "after-claim-owner-install" | "after-claim-directory-sync" | "after-claim-temp-unlink" | "after-claim-root-sync"
  | "before-record-temp-write" | "after-record-temp-write" | "after-record-temp-sync" | "after-record-install"
  | "after-record-root-sync" | "after-record-temp-unlink" | "after-record-temp-root-sync"
  | "before-action-intent" | "after-action-intent-temp-write" | "after-action-intent-temp-sync" | "after-action-intent-install" | "after-action-intent-root-sync"
  | "after-action-progress-temp-write" | "after-action-progress-temp-sync" | "after-action-progress-install" | "after-action-progress-root-sync"
  | "after-generation-temp-write" | "after-generation-temp-sync" | "after-generation-replace" | "after-generation-root-sync"
  | "before-action-unlink" | "after-action-unlink" | "before-action-parent-sync" | "after-action-parent-sync" | "after-terminal-update" | "before-record-unlink" | "after-record-unlink" | "after-record-unlink-root-sync";
let resolutionCheckpoint: ((point: MigrationResolutionCheckpoint, root: string) => void | Promise<void>) | undefined;
/** @internal A deterministic crash seam for subprocess checkpoint tests. */
export function setMigrationResolutionCheckpointForTests(
  callback: ((point: MigrationResolutionCheckpoint, root: string) => void | Promise<void>) | undefined,
): void {
  resolutionCheckpoint = callback;
}

interface FileProof { kind: "file"; mode: number; dev: string; ino: string; bytesHash: string }
interface DirectoryProof { kind: "directory"; mode: number; dev: string; ino: string }
interface ArtifactProof { name: string; kind: "file" | "directory"; mode: number; dev: string; ino: string; hash: string }
type CleanupPhase = "artifacts" | "journal" | "owner" | "lock" | "claim-owner" | "claim" | "terminal";
interface Progress { phase: CleanupPhase; completed: number; pending: number | null }
interface EncodedFileProof { rawBase64: string; rawHash: string; file: FileProof }
interface ResolutionClaimOwnerV1 {
  version: 1; mode: "legacy-migration-resolution-claim"; root: string; token: string;
  resolutionId: string; nonce: string; host: string; pid: number; lock: DirectoryProof; journalRawHash: string;
}
interface ResolutionRecordV1 {
  version: 1;
  mode: "legacy-migration-resolution";
  root: string;
  token: string;
  resolutionId: string;
  generation: number;
  predecessorHash: string | null;
  originalJournal: EncodedFileProof;
  oldCatalog: string;
  newCatalog: string;
  currentCatalog: FileProof;
  backupDir: string;
  backupManifest: string;
  backupInventory: MigrationStartInventory;
  reviewId: string;
  privateRevisionHash: string;
  confirmed: true;
  sensitivePaths: string[];
  approvedInventory: MigrationStartInventory;
  originalOwner: EncodedFileProof;
  lock: DirectoryProof;
  claim: { directory: DirectoryProof; owner: FileProof; ownerRawBase64: string };
  cleanupArtifacts: ArtifactProof[];
  progress: Progress;
}
interface OwnerValue { version: 1; pid: number; host: string; token: string; blocked?: boolean; migrationRootEntries?: string[] }
interface RecordFileState { record: ResolutionRecordV1; raw: Buffer; proof: FileProof; tempPath?: string }
interface Analysis {
  root: string;
  status: MigrationResolutionStatus;
  reviewId: string;
  view: MigrationResolutionView;
  revision: string;
  journal?: LegacyMigrationStorageJournalV5;
  journalRaw?: Buffer;
  owner?: OwnerValue;
  ownerRaw?: Buffer;
  ownerProof?: FileProof;
  originalCatalog?: LegacyCatalog;
  nextCatalog?: Catalog;
  currentCatalogProof?: FileProof;
  lockProof?: DirectoryProof;
  claimOwner?: ResolutionClaimOwnerV1;
  claimOwnerRaw?: Buffer;
  claimDirectoryProof?: DirectoryProof;
  claimOwnerProof?: FileProof;
  backupInventory?: MigrationStartInventory;
  approvedInventory?: MigrationStartInventory;
  cleanupArtifacts?: ArtifactProof[];
  recordState?: RecordFileState;
  needsGeneration?: boolean;
  preservedPaths?: string[];
}
interface ResolutionState {
  root: string;
  view: MigrationResolutionView;
  revision: string;
  analysis: Analysis;
  used: boolean;
}
const preparedStates = new WeakMap<PreparedMigrationResolution, ResolutionState>();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Migration resolution record contains a non-JSON value.");
  return text;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key)) &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !!descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable === true;
      });
  } catch { return false; }
}
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !Object.hasOwn(length, "value") || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1) return false;
    return keys.every((key) => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length.value &&
      (() => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable; })());
  } catch { return false; }
}
function validU64(value: unknown): value is string {
  if (typeof value !== "string" || !uint64Pattern.test(value)) return false;
  try { return BigInt(value) <= 18_446_744_073_709_551_615n; } catch { return false; }
}
function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) ||
      Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  if (value === ".") return true;
  return value.length > 0 && path.posix.normalize(value) === value && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function parseFileProof(value: unknown): FileProof {
  if (!exactKeys(value, ["kind", "mode", "dev", "ino", "bytesHash"]) || value.kind !== "file" ||
      typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777 ||
      !validU64(value.dev) || !validU64(value.ino) || typeof value.bytesHash !== "string" || !sha256Pattern.test(value.bytesHash)) {
    throw new Error("Invalid migration resolution file proof.");
  }
  return { kind: "file", mode: value.mode, dev: value.dev, ino: value.ino, bytesHash: value.bytesHash };
}
function parseDirectoryProof(value: unknown): DirectoryProof {
  if (!exactKeys(value, ["kind", "mode", "dev", "ino"]) || value.kind !== "directory" ||
      typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777 ||
      !validU64(value.dev) || !validU64(value.ino)) throw new Error("Invalid migration resolution directory proof.");
  return { kind: "directory", mode: value.mode, dev: value.dev, ino: value.ino };
}
function parseArtifact(value: unknown, index: number): ArtifactProof {
  if (!exactKeys(value, ["name", "kind", "mode", "dev", "ino", "hash"]) || typeof value.name !== "string" ||
      typeof value.kind !== "string" || !["file", "directory"].includes(value.kind) ||
      typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o7777 ||
      !validU64(value.dev) || !validU64(value.ino) || typeof value.hash !== "string" || !sha256Pattern.test(value.hash)) {
    throw new Error("Invalid migration resolution cleanup artifact proof.");
  }
  const required = [
    [".copi-transaction/held-catalog", "file"], [".copi-transaction/old-catalog", "file"],
    [".copi-transaction/next-catalog", "file"], [".copi-transaction/journal.digest", "file"],
    [".copi-transaction/journal.json", "file"], [".copi-transaction/owner.json", "file"],
    [".copi-transaction", "directory"], [".copi-transaction-recovery/owner.json", "file"],
    [".copi-transaction-recovery", "directory"],
  ] as const;
  const item = required[index];
  if (!item || value.name !== item[0] || value.kind !== item[1]) throw new Error("Migration resolution cleanup artifacts are not the closed ordered allowlist.");
  return { name: value.name, kind: value.kind as "file" | "directory", mode: value.mode, dev: value.dev, ino: value.ino, hash: value.hash };
}
function progressPhase(completed: number, pending: number | null): CleanupPhase {
  if (completed === 9) return "terminal";
  const index = pending ?? completed;
  if (index <= 2) return "artifacts";
  if (index === 3 || index === 4) return "journal";
  if (index === 5) return "owner";
  if (index === 6) return "lock";
  if (index === 7) return "claim-owner";
  return "claim";
}
function parseProgress(value: unknown): Progress {
  if (!exactKeys(value, ["phase", "completed", "pending"]) || typeof value.completed !== "number" || !Number.isSafeInteger(value.completed) ||
      value.completed < 0 || value.completed > 9 || !(value.pending === null || value.pending === value.completed) ||
      (value.completed === 9 && value.pending !== null) ||
      !(value.phase === "artifacts" || value.phase === "journal" || value.phase === "owner" || value.phase === "lock" ||
        value.phase === "claim-owner" || value.phase === "claim" || value.phase === "terminal") || value.phase !== progressPhase(value.completed, value.pending)) {
    throw new Error("Invalid migration resolution write-ahead progress.");
  }
  return { phase: value.phase, completed: value.completed, pending: value.pending };
}
function parseEncodedFile(value: unknown): EncodedFileProof {
  if (!exactKeys(value, ["rawBase64", "rawHash", "file"]) || typeof value.rawBase64 !== "string" ||
      typeof value.rawHash !== "string" || !sha256Pattern.test(value.rawHash)) throw new Error("Invalid encoded migration resolution source proof.");
  const bytes = Buffer.from(value.rawBase64, "base64");
  if (bytes.toString("base64") !== value.rawBase64 || sha256(bytes) !== value.rawHash) throw new Error("Migration resolution source bytes do not match their canonical base64 hash.");
  const file = parseFileProof(value.file);
  if (file.bytesHash !== value.rawHash) throw new Error("Migration resolution source file proof does not match its raw bytes.");
  return { rawBase64: value.rawBase64, rawHash: value.rawHash, file };
}
function parseBackupInventory(value: unknown, backupDir: string): MigrationStartInventory {
  if (!exactKeys(value, ["version", "nodes", "hash"]) || value.version !== 1 || !denseArray(value.nodes) ||
      typeof value.hash !== "string" || !sha256Pattern.test(value.hash)) throw new Error("Invalid migration resolution backup inventory envelope.");
  const nodes: MigrationInventoryNode[] = [];
  const seenPaths = new Set<string>();
  const seenIdentities = new Set<string>();
  let previousPath: string | undefined;
  for (const entry of value.nodes) {
    if (!exactKeys(entry, ["path", "kind", "mode", "dev", "ino", "bytesHash"]) || !validPath(entry.path) ||
        (entry.kind !== "file" && entry.kind !== "directory") || typeof entry.mode !== "number" || !Number.isInteger(entry.mode) ||
        entry.mode < 0 || entry.mode > 0o7777 || !validU64(entry.dev) || !validU64(entry.ino) ||
        typeof entry.bytesHash !== "string" || !sha256Pattern.test(entry.bytesHash) ||
        (entry.path !== ".migration-backups" && entry.path !== backupDir && !entry.path.startsWith(`${backupDir}/`))) {
      throw new Error("Invalid or out-of-scope migration resolution backup inventory node.");
    }
    if (previousPath !== undefined && compareUtf8(previousPath, entry.path) >= 0) {
      throw new Error("Migration resolution backup inventory nodes are not in canonical path order.");
    }
    const identity = `${entry.dev}:${entry.ino}`;
    if (seenPaths.has(entry.path) || seenIdentities.has(identity)) throw new Error("Migration resolution backup inventory contains a duplicate path or hardlink identity.");
    seenPaths.add(entry.path);
    seenIdentities.add(identity);
    previousPath = entry.path;
    nodes.push({ path: entry.path, kind: entry.kind, mode: entry.mode, dev: entry.dev, ino: entry.ino, bytesHash: entry.bytesHash });
  }
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const parent = byPath.get(".migration-backups");
  const backupRoot = byPath.get(backupDir);
  if (!parent || parent.kind !== "directory" || !backupRoot || backupRoot.kind !== "directory") {
    throw new Error("Migration resolution backup inventory omits its rooted parent or owned UUID directory.");
  }
  const children = new Map<string, Array<[string, "file" | "directory"]>>();
  for (const node of nodes) {
    if (node.path === ".migration-backups") continue;
    const parentPath = path.posix.dirname(node.path);
    const parentNode = byPath.get(parentPath);
    if (!parentNode || parentNode.kind !== "directory") throw new Error("Migration resolution backup inventory node has no recorded directory parent.");
    const listing = children.get(parentPath) ?? [];
    listing.push([path.posix.basename(node.path), node.kind]);
    children.set(parentPath, listing);
  }
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    const listing = children.get(node.path) ?? [];
    listing.sort(([left], [right]) => compareUtf8(left, right));
    const expected = sha256(Buffer.concat([
      Buffer.from("copi-directory-v1\0", "utf8"),
      Buffer.from(canonicalJson(listing), "utf8"),
    ]));
    if (node.bytesHash !== expected) throw new Error(`Migration resolution backup directory listing commitment is invalid for ${node.path}.`);
  }
  const hash = sha256(Buffer.concat([
    Buffer.from("copi-inventory-v1\0", "utf8"),
    Buffer.from(canonicalJson(nodes), "utf8"),
  ]));
  if (value.hash !== hash) throw new Error("Migration resolution backup inventory hash does not match its canonical nodes.");
  return { version: 1, nodes, hash };
}
function parseClaimOwner(value: unknown, expected: { root: string; token: string; resolutionId: string; journalRawHash: string }): ResolutionClaimOwnerV1 {
  if (!exactKeys(value, ["version", "mode", "root", "token", "resolutionId", "nonce", "host", "pid", "lock", "journalRawHash"]) ||
      value.version !== 1 || value.mode !== "legacy-migration-resolution-claim" || value.root !== expected.root || value.token !== expected.token ||
      value.resolutionId !== expected.resolutionId || typeof value.nonce !== "string" || !uuidPattern.test(value.nonce) ||
      typeof value.host !== "string" || value.host.length === 0 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      value.journalRawHash !== expected.journalRawHash) throw new Error("Invalid typed migration resolution claim owner.");
  return { version: 1, mode: "legacy-migration-resolution-claim", root: value.root, token: value.token,
    resolutionId: value.resolutionId, nonce: value.nonce, host: value.host, pid: value.pid,
    lock: parseDirectoryProof(value.lock), journalRawHash: value.journalRawHash };
}
function parseRecord(value: unknown): ResolutionRecordV1 {
  const keys = ["version", "mode", "root", "token", "resolutionId", "generation", "predecessorHash", "originalJournal", "oldCatalog", "newCatalog",
    "currentCatalog", "backupDir", "backupManifest", "backupInventory", "reviewId", "privateRevisionHash", "confirmed", "sensitivePaths",
    "approvedInventory", "originalOwner", "lock", "claim", "cleanupArtifacts", "progress"];
  if (!exactKeys(value, keys) || value.version !== 1 || value.mode !== "legacy-migration-resolution" || typeof value.root !== "string" ||
      !path.isAbsolute(value.root) || path.resolve(value.root) !== value.root || typeof value.token !== "string" || !uuidPattern.test(value.token) ||
      typeof value.resolutionId !== "string" || !uuidPattern.test(value.resolutionId) || typeof value.generation !== "number" ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !(value.predecessorHash === null || typeof value.predecessorHash === "string" && sha256Pattern.test(value.predecessorHash)) ||
      (value.generation === 1 ? value.predecessorHash !== null : value.predecessorHash === null) ||
      typeof value.oldCatalog !== "string" || !sha256Pattern.test(value.oldCatalog) || typeof value.newCatalog !== "string" || !sha256Pattern.test(value.newCatalog) ||
      typeof value.backupDir !== "string" || !/^\.migration-backups\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.backupDir) ||
      typeof value.backupManifest !== "string" || !sha256Pattern.test(value.backupManifest) || typeof value.reviewId !== "string" || !uuidPattern.test(value.reviewId) ||
      typeof value.privateRevisionHash !== "string" || !sha256Pattern.test(value.privateRevisionHash) || value.confirmed !== true || !denseArray(value.sensitivePaths) ||
      value.sensitivePaths.some((entry) => typeof entry !== "string") || typeof value.cleanupArtifacts !== "object" || !denseArray(value.cleanupArtifacts) ||
      value.cleanupArtifacts.length !== 9 || !exactKeys(value.claim, ["directory", "owner", "ownerRawBase64"]) || typeof value.claim.ownerRawBase64 !== "string") {
    throw new Error("Invalid migration resolution record envelope or exact keys.");
  }
  const originalJournal = parseEncodedFile(value.originalJournal);
  const originalOwner = parseEncodedFile(value.originalOwner);
  const currentCatalog = parseFileProof(value.currentCatalog);
  const lock = parseDirectoryProof(value.lock);
  const claim = {
    directory: parseDirectoryProof(value.claim.directory),
    owner: parseFileProof(value.claim.owner),
    ownerRawBase64: value.claim.ownerRawBase64,
  };
  const claimBytes = Buffer.from(claim.ownerRawBase64, "base64");
  if (claimBytes.toString("base64") !== claim.ownerRawBase64 || sha256(claimBytes) !== claim.owner.bytesHash) throw new Error("Typed claim owner bytes do not match their fixed proof.");
  const backupInventory = parseBackupInventory(value.backupInventory, value.backupDir as string);
  const approvedInventory = parseMigrationStartInventory(value.approvedInventory);
  const sensitivePaths = value.sensitivePaths as string[];
  if (sensitivePaths.some((entry, index) => !entry || entry.includes("\\") || entry.includes("\0") ||
      (index > 0 && compareUtf8(sensitivePaths[index - 1]!, entry) >= 0))) throw new Error("Migration resolution sensitive paths are not a canonical unique set.");
  const cleanupArtifacts = value.cleanupArtifacts.map((artifact, index) => parseArtifact(artifact, index));
  const progress = parseProgress(value.progress);
  const raw = Buffer.from(originalJournal.rawBase64, "base64");
  const journalValue = JSON.parse(raw.toString("utf8")) as unknown;
  const journal = parseStorageJournal(journalValue, { root: value.root, token: value.token });
  if (journal.version !== 5 || raw.toString("utf8") !== canonicalStorageJournalJson(journal) || journal.oldCatalog !== value.oldCatalog ||
      journal.newCatalog !== value.newCatalog || journal.backupDir !== value.backupDir || journal.backupManifest !== value.backupManifest) {
    throw new Error("Resolution record does not retain its exact original canonical v5 journal authority.");
  }
  const backupDir = value.backupDir as string;
  const backupRootNode = inventoryNode(backupInventory, backupDir);
  const backupManifestNode = inventoryNode(backupInventory, `${backupDir}/manifest.json`);
  const backupParentNode = inventoryNode(backupInventory, ".migration-backups");
  const startBackupParent = inventoryNode(journal.startInventory, ".migration-backups");
  const approvedBackupParent = inventoryNode(approvedInventory, ".migration-backups");
  const expectedBackupParentHash = sha256(Buffer.concat([
    Buffer.from("copi-directory-v1\0", "utf8"),
    Buffer.from(canonicalJson([[path.posix.basename(backupDir), "directory"]]), "utf8"),
  ]));
  const backupInventoryIsScoped = backupInventory.nodes.every((node) => node.path === ".migration-backups" ||
    node.path === backupDir || node.path.startsWith(`${backupDir}/`));
  const approvedInventoryContainsBackup = approvedInventory.nodes.some((node) => node.path === backupDir || node.path.startsWith(`${backupDir}/`));
  const baselineParentIsPreserved = startBackupParent !== undefined && startBackupParent.kind === "directory" &&
    approvedBackupParent !== undefined && canonicalJson(approvedBackupParent) === canonicalJson(startBackupParent) &&
    backupParentNode !== undefined && backupParentNode.kind === "directory" &&
    approvedBackupParent.dev === backupParentNode.dev && approvedBackupParent.ino === backupParentNode.ino &&
    approvedBackupParent.mode === backupParentNode.mode;
  if (!backupInventoryIsScoped || approvedInventoryContainsBackup || !backupParentNode || backupParentNode.kind !== "directory" ||
      backupParentNode.bytesHash !== expectedBackupParentHash || !backupRootNode || backupRootNode.kind !== "directory" ||
      !backupManifestNode || backupManifestNode.kind !== "file" || backupManifestNode.bytesHash !== value.backupManifest ||
      (startBackupParent ? !baselineParentIsPreserved : approvedBackupParent !== undefined)) {
    throw new Error("Resolution record does not separate the root-relative owned backup inventory from the approved payload inventory.");
  }
  const ownerBytes = Buffer.from(originalOwner.rawBase64, "base64");
  const ownerValue = parseOwner(JSON.parse(ownerBytes.toString("utf8")) as unknown, value.token);
  if (!ownerValue.migrationRootEntries) throw new Error("Resolution record original owner lacks the v5 root-entry commitment.");
  const claimValueRaw = JSON.parse(claimBytes.toString("utf8")) as unknown;
  const claimValue = parseClaimOwner(claimValueRaw,
    { root: value.root, token: value.token, resolutionId: value.resolutionId, journalRawHash: originalJournal.rawHash });
  if (claimBytes.toString("utf8") !== canonicalJson(claimValue)) throw new Error("Typed resolution claim owner is not canonically encoded.");
  const requiredLockNames = ["held-catalog", "old-catalog", "next-catalog", "journal.digest", "journal.json", "owner.json"];
  const expectedLockHash = sha256(Buffer.from(canonicalJson(requiredLockNames.map((name) => [name, "file"]).sort(([a], [b]) => compareUtf8(String(a), String(b)))), "utf8"));
  const expectedClaimHash = sha256(Buffer.from(canonicalJson([["owner.json", "file"]]), "utf8"));
  const startCatalog = journal.startInventory.nodes.find((node) => node.path === "catalog.json");
  const heldArtifact = cleanupArtifacts[0]!;
  const oldArtifact = cleanupArtifacts[1]!;
  const nextArtifact = cleanupArtifacts[2]!;
  const digestArtifact = cleanupArtifacts[3]!;
  const journalArtifact = cleanupArtifacts[4]!;
  const ownerArtifact = cleanupArtifacts[5]!;
  const claimOwnerArtifact = cleanupArtifacts[7]!;
  if (!startCatalog || startCatalog.kind !== "file" || startCatalog.bytesHash !== value.oldCatalog ||
      heldArtifact.hash !== value.oldCatalog || oldArtifact.hash !== value.oldCatalog ||
      heldArtifact.dev !== startCatalog.dev || heldArtifact.ino !== startCatalog.ino || heldArtifact.mode !== startCatalog.mode ||
      oldArtifact.dev !== startCatalog.dev || oldArtifact.ino !== startCatalog.ino || oldArtifact.mode !== startCatalog.mode ||
      heldArtifact.dev !== oldArtifact.dev || heldArtifact.ino !== oldArtifact.ino ||
      nextArtifact.hash !== value.newCatalog || nextArtifact.dev !== currentCatalog.dev || nextArtifact.ino !== currentCatalog.ino ||
      nextArtifact.mode !== currentCatalog.mode ||
      digestArtifact.hash !== sha256(Buffer.from(originalJournal.rawHash, "utf8")) || digestArtifact.mode !== 0o600 ||
      journalArtifact.hash !== originalJournal.rawHash || journalArtifact.dev !== originalJournal.file.dev || journalArtifact.ino !== originalJournal.file.ino ||
      journalArtifact.mode !== originalJournal.file.mode ||
      ownerArtifact.hash !== originalOwner.rawHash || ownerArtifact.dev !== originalOwner.file.dev || ownerArtifact.ino !== originalOwner.file.ino ||
      ownerArtifact.mode !== originalOwner.file.mode ||
      claimOwnerArtifact.hash !== claim.owner.bytesHash || claimOwnerArtifact.dev !== claim.owner.dev || claimOwnerArtifact.ino !== claim.owner.ino ||
      claimOwnerArtifact.mode !== claim.owner.mode) throw new Error("Migration resolution artifact proofs are not bound to the v5 journal, catalog, owner, or claim.");
  if (claimValue.lock.dev !== lock.dev || claimValue.lock.ino !== lock.ino || claimValue.lock.mode !== lock.mode ||
      currentCatalog.kind !== "file" || currentCatalog.bytesHash !== value.newCatalog ||
      !sameProof(lock, { kind: "directory", mode: cleanupArtifacts[6]!.mode, dev: cleanupArtifacts[6]!.dev, ino: cleanupArtifacts[6]!.ino }) ||
      cleanupArtifacts[6]!.hash !== expectedLockHash || cleanupArtifacts[8]!.hash !== expectedClaimHash ||
      !sameProof(claim.directory, { kind: "directory", mode: cleanupArtifacts[8]!.mode, dev: cleanupArtifacts[8]!.dev, ino: cleanupArtifacts[8]!.ino }) ||
      !sameProof(originalJournal.file, { kind: "file", mode: cleanupArtifacts[4]!.mode, dev: cleanupArtifacts[4]!.dev, ino: cleanupArtifacts[4]!.ino, bytesHash: cleanupArtifacts[4]!.hash }) ||
      !sameProof(originalOwner.file, { kind: "file", mode: cleanupArtifacts[5]!.mode, dev: cleanupArtifacts[5]!.dev, ino: cleanupArtifacts[5]!.ino, bytesHash: cleanupArtifacts[5]!.hash }) ||
      !sameProof(claim.owner, { kind: "file", mode: cleanupArtifacts[7]!.mode, dev: cleanupArtifacts[7]!.dev, ino: cleanupArtifacts[7]!.ino, bytesHash: cleanupArtifacts[7]!.hash }) ||
      canonicalJson(cleanupArtifacts) !== canonicalJson(value.cleanupArtifacts)) throw new Error("Resolution record proofs disagree with their journal, catalog, claim, or cleanup custody.");
  return {
    version: 1, mode: "legacy-migration-resolution", root: value.root, token: value.token, resolutionId: value.resolutionId,
    generation: value.generation, predecessorHash: value.predecessorHash, originalJournal, oldCatalog: value.oldCatalog,
    newCatalog: value.newCatalog, currentCatalog, backupDir: value.backupDir, backupManifest: value.backupManifest,
    backupInventory, reviewId: value.reviewId, privateRevisionHash: value.privateRevisionHash, confirmed: true,
    sensitivePaths: [...sensitivePaths], approvedInventory, originalOwner, lock, claim, cleanupArtifacts, progress,
  };
}
function parseOwner(value: unknown, token: string): OwnerValue {
  if (!isRecord(value) || utilTypes.isProxy(value)) throw new Error("Malformed migration transaction owner.");
  const keys = Object.keys(value).sort(compareUtf8);
  const allowed = ["blocked", "host", "migrationRootEntries", "pid", "token", "version"];
  if (keys.some((key) => !allowed.includes(key)) || !["host", "pid", "token", "version"].every((key) => keys.includes(key)) ||
      value.version !== 1 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.host !== "string" ||
      typeof value.token !== "string" || value.token !== token || (value.blocked !== undefined && typeof value.blocked !== "boolean")) {
    throw new Error("Malformed migration transaction owner.");
  }
  if (value.migrationRootEntries !== undefined && (!Array.isArray(value.migrationRootEntries) || value.migrationRootEntries.some((entry) => typeof entry !== "string" ||
      !entry || entry.includes("/") || entry.includes("\\") || entry.includes("\0") || entry === "." || entry === "..") ||
      new Set(value.migrationRootEntries).size !== value.migrationRootEntries.length ||
      value.migrationRootEntries.some((entry) => [lockName, claimName, ".migration-backups"].includes(entry)) ||
      canonicalJson([...value.migrationRootEntries].sort()) !== canonicalJson(value.migrationRootEntries))) {
    throw new Error("Malformed migration root-entry commitment.");
  }
  return {
    version: 1, pid: value.pid, host: value.host, token: value.token,
    ...(value.blocked === undefined ? {} : { blocked: value.blocked }),
    ...(value.migrationRootEntries === undefined ? {} : { migrationRootEntries: [...value.migrationRootEntries] as string[] }),
  };
}
function alive(owner: OwnerValue): boolean {
  if (owner.host !== os.hostname()) throw new Error("Migration lock owner is on an unknown host; preserving it.");
  try { process.kill(owner.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("Migration lock owner liveness is unknown; preserving all migration artifacts.", { cause: error });
  }
}
function proofFromStat(stat: Awaited<ReturnType<typeof lstat>> & { dev: bigint; ino: bigint; mode: bigint }, kind: "file" | "directory", bytesHash?: string): FileProof | DirectoryProof {
  const mode = Number(stat.mode & 0o7777n);
  if (kind === "file") return { kind, mode, dev: stat.dev.toString(), ino: stat.ino.toString(), bytesHash: bytesHash! };
  return { kind, mode, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function sameProof(left: FileProof | DirectoryProof, right: FileProof | DirectoryProof): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.dev === right.dev && left.ino === right.ino &&
    (left.kind !== "file" || right.kind === "file" && left.bytesHash === right.bytesHash);
}
async function statMaybe(target: string) {
  return lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
}
async function checkedFile(target: string): Promise<{ bytes: Buffer; proof: FileProof }> {
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || await realpath(target) !== target) throw new Error(`Unsafe migration resolution file: ${target}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    const same = (left: typeof before, right: typeof before): boolean => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
      left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    if (!opened.isFile() || !same(before, opened)) throw new Error("Migration resolution file changed while opening.");
    const bytes = await handle.readFile();
    const [after, afterPath, canonical] = await Promise.all([handle.stat({ bigint: true }), lstat(target, { bigint: true }), realpath(target)]);
    if (!after.isFile() || !afterPath.isFile() || afterPath.isSymbolicLink() || canonical !== target || !same(opened, after) || !same(opened, afterPath)) {
      throw new Error("Migration resolution file changed while reading.");
    }
    return { bytes: Buffer.from(bytes), proof: proofFromStat(opened, "file", sha256(bytes)) as FileProof };
  } finally { await handle.close(); }
}
async function checkedDirectory(target: string, expectedMode?: number): Promise<DirectoryProof> {
  const before = await lstat(target, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(target) !== target ||
      (expectedMode !== undefined && Number(before.mode & 0o7777n) !== expectedMode)) throw new Error(`Unsafe migration resolution directory: ${target}`);
  const after = await lstat(target, { bigint: true });
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || await realpath(target) !== target) {
    throw new Error("Migration resolution directory changed while checking its identity.");
  }
  return proofFromStat(after, "directory") as DirectoryProof;
}
async function readCanonicalRoot(libraryDir: string): Promise<string | undefined> {
  if (typeof libraryDir !== "string" || libraryDir.length === 0) throw new Error("Library path must be a nonempty string.");
  const root = path.resolve(libraryDir);
  const stat = await statMaybe(root);
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error("Migration resolution requires a canonical real library directory.");
  return root;
}
async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
function inventoryHashEqual(left: MigrationStartInventory, right: MigrationStartInventory): boolean {
  return left.hash === right.hash && canonicalJson(left.nodes) === canonicalJson(right.nodes);
}
function inventoryNode(inventory: MigrationStartInventory, relative: string): MigrationInventoryNode | undefined {
  return inventory.nodes.find((node) => node.path === relative);
}
function isExcluded(relative: string): boolean {
  return relative.split("/").some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === ".env" || lower.startsWith(".env");
  });
}
function isUnder(target: string, root: string): boolean { return target === root || target.startsWith(`${root}/`); }
function stableTreeHash(inventory: MigrationStartInventory, target: "items" | "sources"): string {
  const rootNode = inventoryNode(inventory, target);
  if (!rootNode) return "absent";
  if (rootNode.kind !== "directory") throw new Error(`Migration ${target} root is not a directory.`);
  const byPath = new Map(inventory.nodes.map((node) => [node.path, node]));
  const rows: Array<{ path: string; kind: "directory" | "file"; value: string; mode: number; dev: number; ino: number }> = [];
  const visit = (absoluteRelative: string, relative: string): void => {
    const node = byPath.get(absoluteRelative);
    if (!node || node.kind !== "directory") throw new Error(`Migration ${target} inventory lacks a directory.`);
    rows.push({ path: relative, kind: "directory", value: "", mode: Number(BigInt(node.mode) & 0o777n), dev: Number(BigInt(node.dev)), ino: Number(BigInt(node.ino)) });
    for (const child of inventory.nodes.filter((entry) => entry.path !== absoluteRelative && path.posix.dirname(entry.path) === absoluteRelative)
      .sort((left, right) => path.posix.basename(left.path) < path.posix.basename(right.path) ? -1 : path.posix.basename(left.path) > path.posix.basename(right.path) ? 1 : 0)) {
      const childRelative = relative === "." ? path.posix.basename(child.path) : `${relative}/${path.posix.basename(child.path)}`;
      if (child.kind === "file") rows.push({ path: childRelative, kind: "file", value: child.bytesHash, mode: Number(BigInt(child.mode) & 0o777n),
        dev: Number(BigInt(child.dev)), ino: Number(BigInt(child.ino)) });
      else visit(child.path, childRelative);
    }
  };
  visit(target, ".");
  return sha256(Buffer.from(JSON.stringify(rows)));
}
async function sourceTreeFiles(root: string, item: SavedItem): Promise<Array<{ path: string; mode: number; bytes: Buffer }>> {
  const base = item.content.path;
  const collected: Array<{ path: string; mode: number; bytes: Buffer }> = [];
  if (item.content.kind === "file") {
    const file = await checkedFile(path.join(root, ...base.split("/")));
    collected.push({ path: item.files[0]?.path ?? path.posix.basename(base), mode: file.proof.mode, bytes: file.bytes });
    return collected;
  }
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stat = await lstat(absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("Adopted skill contains an unsafe directory.");
    for (const rawName of await readdir(absolute, { encoding: "buffer" })) {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      const childRelative = relative ? `${relative}/${name}` : name;
      if (isExcluded(childRelative)) continue;
      const child = path.join(absolute, name);
      const childStat = await lstat(child, { bigint: true });
      if (childStat.isSymbolicLink()) throw new Error("Adopted skill contains a symbolic link.");
      if (childStat.isDirectory()) await visit(child, childRelative);
      else if (childStat.isFile()) {
        const file = await checkedFile(child);
        collected.push({ path: childRelative, mode: file.proof.mode, bytes: file.bytes });
      } else throw new Error("Adopted skill contains an unsupported special file.");
    }
  };
  await visit(path.join(root, ...base.split("/")), "");
  return collected.sort((left, right) => compareUtf8(left.path, right.path));
}
function text(bytes: Buffer): string | undefined {
  if (bytes.length > 1_000_000 || bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}
function resolutionDiff(itemId: string, name: string, before: Buffer | undefined, after: Buffer | undefined, identityChanged: boolean): MigrationMaskedDiff {
  if (before && after && before.equals(after) && identityChanged) {
    return { path: `${itemId}/${name}`, summary: "Included file identity changed while its bytes remained identical; content is not displayed." };
  }
  const beforeText = before === undefined ? "" : text(before);
  const afterText = after === undefined ? "" : text(after);
  if (beforeText === undefined || afterText === undefined) {
    const change = before === undefined ? "new" : after === undefined ? "removed" : "changed binary or large";
    return { path: `${itemId}/${name}`, summary: `${change} included file; bytes are preserved and content is not displayed.` };
  }
  const prefix = before && after && !before.equals(after) ? "Included file bytes changed; masked diff follows:\n" : "";
  return {
    path: `${itemId}/${name}`,
    summary: `${prefix}${maskSensitiveText(createTwoFilesPatch(before === undefined ? "(new)" : "verified backup", after === undefined ? "(removed)" : "current source", beforeText, afterText))}`,
  };
}
function makeView(reviewId: string, status: MigrationResolutionStatus, values: Partial<MigrationResolutionView> = {}): MigrationResolutionView {
  return {
    reviewId, status, backupDir: values.backupDir ?? null, items: values.items ? values.items.map((item) => ({ ...item })) : [],
    conflicts: values.conflicts ? [...values.conflicts] : [], preservedPaths: values.preservedPaths ? [...values.preservedPaths] : [],
    maskedDiffs: values.maskedDiffs ? values.maskedDiffs.map((entry) => ({ ...entry })) : [],
    sensitivePaths: values.sensitivePaths ? [...values.sensitivePaths] : [], warnings: values.warnings ? values.warnings.map((entry) => ({ ...entry })) : [],
  };
}
function makePrepared(analysis: Analysis): PreparedMigrationResolution {
  const plan = Object.freeze({ reviewId: analysis.reviewId }) as PreparedMigrationResolution;
  preparedStates.set(plan, { root: analysis.root, view: analysis.view, revision: analysis.revision, analysis, used: false });
  return plan;
}
function blocked(root: string, reason: string, reviewId: string = randomUUID()): Analysis {
  return { root, status: "blocked", reviewId, view: makeView(reviewId, "blocked", { conflicts: [reason] }), revision: sha256(`${root}\0blocked\0${reason}`) };
}
function notNeeded(root: string, reviewId: string = randomUUID()): Analysis {
  return { root, status: "not-needed", reviewId, view: makeView(reviewId, "not-needed"), revision: sha256(`${root}\0not-needed`) };
}
function filteredInventory(inventory: MigrationStartInventory, excludedPrefixes: readonly string[], omitted: readonly string[] = []): MigrationStartInventory {
  return projectMigrationInventory(inventory, excludedPrefixes, omitted);
}
function backupPayloadExclusions(start: MigrationStartInventory, backupDir: string, extra: readonly string[] = []): string[] {
  return [lockName, claimName, recordName, backupDir,
    ...(!inventoryNode(start, ".migration-backups") ? [".migration-backups"] : []), ...extra];
}
function backupScopedInventory(inventory: MigrationStartInventory, backupDir: string): MigrationStartInventory {
  const backupName = path.posix.basename(backupDir);
  const keep = (nodePath: string): boolean => nodePath === "." || nodePath === backupName || nodePath.startsWith(`${backupName}/`);
  const omitted = inventory.nodes.filter((node) => !keep(node.path)).map((node) => node.path);
  const projected = filteredInventory(inventory, [], omitted);
  const nodes = projected.nodes.map((node) => ({
    ...node,
    path: node.path === "." ? ".migration-backups" : `.migration-backups/${node.path}`,
  }));
  return {
    version: 1,
    nodes,
    hash: sha256(Buffer.concat([
      Buffer.from("copi-inventory-v1\0", "utf8"),
      Buffer.from(canonicalJson(nodes), "utf8"),
    ])),
  };
}
function assertBackupParentListing(start: MigrationStartInventory, current: MigrationStartInventory, backupDir: string): void {
  const parentPath = ".migration-backups";
  const baselineParent = inventoryNode(start, parentPath);
  const currentParent = inventoryNode(current, parentPath);
  if (!currentParent || currentParent.kind !== "directory" ||
      baselineParent && (baselineParent.kind !== "directory" || baselineParent.dev !== currentParent.dev ||
        baselineParent.ino !== currentParent.ino || baselineParent.mode !== currentParent.mode)) {
    throw new Error("Migration backup parent identity or mode changed from the fixed start inventory.");
  }
  const children = (inventory: MigrationStartInventory): string[] => inventory.nodes
    .filter((node) => node.path !== parentPath && path.posix.dirname(node.path) === parentPath)
    .map((node) => path.posix.basename(node.path)).sort(compareUtf8);
  const baselineNames = children(start);
  const ownedName = path.posix.basename(backupDir);
  if (baselineNames.includes(ownedName)) throw new Error("Migration start inventory already contains the current backup UUID.");
  const expectedNames = [...baselineNames, ownedName].sort(compareUtf8);
  if (canonicalJson(children(current)) !== canonicalJson(expectedNames)) {
    throw new Error("Migration backup parent listing differs from its start inventory plus the owned UUID.");
  }
}
/**
 * LIMIT: privateRevisionHash is durable commitment metadata, not authentication for a record read in a later process.
 * The process-local prepared-plan revision is compared again during commit; manual edits to internal records remain outside this guarantee.
 */
function reviewCommitment(record: Omit<ResolutionRecordV1, "privateRevisionHash">, observedRecord: { rawHash: string; proof: FileProof } | null): string {
  const fixed = {
    root: record.root, token: record.token, journalRawHash: record.originalJournal.rawHash,
    oldCatalog: record.oldCatalog, newCatalog: record.newCatalog, currentCatalog: record.currentCatalog,
    backupInventoryHash: record.backupInventory.hash, originalOwner: record.originalOwner,
    lock: record.lock, payloadInventoryHash: record.approvedInventory.hash,
    observedRecord, observedClaim: record.claim, cleanupArtifacts: record.cleanupArtifacts,
    progress: record.progress, generation: record.generation, predecessorHash: record.predecessorHash,
    reviewId: record.reviewId, sensitivePaths: record.sensitivePaths,
  };
  return sha256(Buffer.concat([Buffer.from("copi-resolution-review-v1\0", "utf8"), Buffer.from(canonicalJson(fixed), "utf8")]));
}
async function ownerIsDead(owner: OwnerValue): Promise<void> {
  if (alive(owner)) throw new Error("The original migration owner is active; preserving its journal and backup.");
}
function currentRecordTemp(root: string, record: ResolutionRecordV1): string {
  return path.join(root, `${resolutionTempPrefix}${record.resolutionId}.${record.generation}.tmp`);
}
function isRecordTempName(name: string): boolean { return name !== recordName && name.startsWith(resolutionTempPrefix); }
async function readRecord(root: string): Promise<RecordFileState | undefined> {
  const target = path.join(root, recordName);
  const stat = await statMaybe(target);
  if (!stat) return undefined;
  const loaded = await checkedFile(target);
  if (loaded.proof.mode !== 0o600) throw new Error("Migration resolution record must be a regular mode-0600 file.");
  let value: unknown;
  try { value = JSON.parse(loaded.bytes.toString("utf8")) as unknown; } catch { throw new Error("Migration resolution record is malformed; preserving it."); }
  const record = parseRecord(value);
  if (record.root !== root || loaded.bytes.toString("utf8") !== canonicalJson(record)) throw new Error("Migration resolution record root or canonical bytes changed.");
  return { record, raw: loaded.bytes, proof: loaded.proof };
}
async function checkTemps(root: string, record?: RecordFileState): Promise<string | undefined> {
  const names = (await readdir(root, { encoding: "buffer" })).map((value) => new TextDecoder("utf-8", { fatal: true }).decode(value));
  const temps = names.filter(isRecordTempName);
  if (temps.length === 0) return undefined;
  if (!record || temps.length !== 1 || temps[0] !== path.basename(currentRecordTemp(root, record.record))) {
    throw new Error("Unknown or incomplete migration resolution temporary file; preserving it.");
  }
  const temp = path.join(root, temps[0]!);
  const loaded = await checkedFile(temp);
  if (!sameProof(loaded.proof, record.proof) || !loaded.bytes.equals(record.raw)) throw new Error("Migration resolution temporary is not an owned completed-record alias.");
  return temp;
}
function exactInventoryMap(inventory: MigrationStartInventory): Map<string, MigrationInventoryNode> {
  return new Map(inventory.nodes.map((node) => [node.path, node]));
}
function equalNodeWithoutContents(left: MigrationInventoryNode, right: MigrationInventoryNode): boolean {
  return left.path === right.path && left.kind === right.kind && left.mode === right.mode && left.dev === right.dev && left.ino === right.ino;
}
function verifyAllowedPayloadChanges(
  root: string,
  start: MigrationStartInventory,
  current: MigrationStartInventory,
  oldCatalog: LegacyCatalog,
  nextCatalog: Catalog,
  excludedPrefixes: readonly string[],
): { changedPaths: string[]; omitted: string[]; preserved: string[] } {
  const baseline = exactInventoryMap(start);
  const now = exactInventoryMap(current);
  const nextItems = new Map(nextCatalog.items.map((item) => [item.id, item]));
  const allowedRoot = new Map<string, { item: LegacySavedItem; kind: "file" | "skill" }>();
  for (const oldItem of oldCatalog.items) {
    const next = nextItems.get(oldItem.id);
    const expectedSource = path.relative(root, oldItem.sourcePath).split(path.sep).join("/");
    if (!next || !expectedSource.startsWith("sources/") || next.content.path !== expectedSource || isExcluded(expectedSource)) {
      throw new Error("Migration catalog does not retain the exact adopted sources path.");
    }
    if (oldItem.kind === "skill") {
      if (next.content.kind !== "tree") throw new Error("Adopted skill target changed kind.");
      allowedRoot.set(expectedSource, { item: oldItem, kind: "skill" });
    } else {
      if (next.content.kind !== "file") throw new Error("Adopted file target changed kind.");
      allowedRoot.set(expectedSource, { item: oldItem, kind: "file" });
    }
  }
  const authorized = new Set<string>(["catalog.json"]);
  const changedPaths: string[] = [];
  const preserved: string[] = [];
  for (const [sourcePath, rule] of allowedRoot) {
    const registered = new Set(rule.item.files.map((file) => rule.kind === "skill" ? `${sourcePath}/${file.path}` : sourcePath));
    const descendants = new Set<string>();
    for (const node of start.nodes) {
      if (node.kind === "file" && (rule.kind === "skill" ? isUnder(node.path, sourcePath) && node.path !== sourcePath : node.path === sourcePath)) descendants.add(node.path);
    }
    for (const node of current.nodes) {
      if (node.kind === "file" && (rule.kind === "skill" ? isUnder(node.path, sourcePath) && node.path !== sourcePath : node.path === sourcePath)) descendants.add(node.path);
    }
    for (const filePath of descendants) {
      const old = baseline.get(filePath);
      const actual = now.get(filePath);
      const relative = rule.kind === "skill" ? filePath.slice(`${sourcePath}/`.length) : path.posix.basename(sourcePath);
      if (isExcluded(relative)) continue;
      if (old && !registered.has(filePath)) continue; // Unregistered baseline nodes remain protected by the full inventory comparison.
      if (!old && actual) {
        if (rule.kind !== "skill" || actual.kind !== "file") throw new Error("Only regular files may be added inside an adopted skill.");
        const parent = path.posix.dirname(filePath);
        if (!baseline.has(parent) || baseline.get(parent)!.kind !== "directory") throw new Error("New skill files require an unchanged baseline parent directory.");
        authorized.add(filePath);
        changedPaths.push(filePath);
      } else if (old && !actual) {
        if (rule.kind !== "skill" || relative === "SKILL.md" || old.kind !== "file" || !registered.has(filePath)) {
          throw new Error("Only previously included non-SKILL.md skill files may be deleted.");
        }
        authorized.add(filePath);
        changedPaths.push(filePath);
      } else if (old && actual && registered.has(filePath)) {
        if (old.kind !== "file" || actual.kind !== "file" || old.mode !== actual.mode) throw new Error("An existing included source file changed kind or mode.");
        authorized.add(filePath);
        if (old.bytesHash !== actual.bytesHash || old.dev !== actual.dev || old.ino !== actual.ino) changedPaths.push(filePath);
      }
    }
  }
  const isOmitted = (nodePath: string): boolean => excludedPrefixes.some((prefix) => nodePath === prefix || nodePath.startsWith(`${prefix}/`));
  // Directories are immutable; only their child-list commitments may follow approved file additions/deletions.
  for (const node of start.nodes) {
    if (node.kind !== "directory" || node.path === "." || isOmitted(node.path)) continue;
    const actual = now.get(node.path);
    if (!actual || actual.kind !== "directory" || !equalNodeWithoutContents(node, actual)) throw new Error(`A protected library directory changed: ${node.path}`);
  }
  for (const node of current.nodes) {
    if (node.kind === "directory" && !baseline.has(node.path) && !isOmitted(node.path)) throw new Error(`A new library directory is outside the adopt-only allowlist: ${node.path}`);
  }
  const currentProjected = filteredInventory(current, excludedPrefixes, [...authorized]);
  const baselineProjected = filteredInventory(start, excludedPrefixes, [...authorized]);
  if (!inventoryHashEqual(currentProjected, baselineProjected)) {
    const names = new Set([...baseline.keys(), ...now.keys()]);
    for (const name of names) {
      if (authorized.has(name) || isOmitted(name)) continue;
      const old = baseline.get(name), actual = now.get(name);
      if (!old || !actual || canonicalJson(old) !== canonicalJson(actual)) preserved.push(name);
    }
    throw new Error(`A protected library node changed outside the adopt-only source allowlist${preserved.length ? `: ${preserved.sort(compareUtf8).join(", ")}` : ""}.`);
  }
  return { changedPaths: [...new Set(changedPaths)].sort(compareUtf8), omitted: [...authorized], preserved: preserved.sort(compareUtf8) };
}
function assertCatalogStructure(value: unknown, version: 1 | 2): void {
  if (!exactKeys(value, ["version", "items", "groups"]) || value.version !== version || !Array.isArray(value.items) || !Array.isArray(value.groups)) {
    throw new Error("Migration catalog contains unknown or malformed top-level fields.");
  }
  const itemKeys = version === 1
    ? ["id", "kind", "source", "scope", "sourcePath", "destination", "name", "savedAt", "files"]
    : ["id", "kind", "source", "scope", "sourcePath", "destination", "name", "savedAt", "files", "content"];
  for (const item of value.items) {
    if (!exactKeys(item, itemKeys)) throw new Error("Migration catalog item contains unknown or malformed fields.");
    const destination = item.destination;
    if (!exactKeys(destination, isRecord(destination) && destination.kind === "project" ? ["kind", "path"] : ["kind"])) {
      throw new Error("Migration catalog destination contains unknown or malformed fields.");
    }
    if (!Array.isArray(item.files)) throw new Error("Migration catalog file descriptors are malformed.");
    for (const file of item.files) if (!exactKeys(file, ["path", "mode", "sha256"])) throw new Error("Migration catalog file descriptor contains unknown fields.");
    if (version === 2 && !exactKeys(item.content, ["kind", "path"])) throw new Error("Migration catalog content location contains unknown fields.");
  }
  for (const group of value.groups) if (!exactKeys(group, ["id", "name", "itemIds"])) throw new Error("Migration catalog group contains unknown fields.");
}
function originalCatalogFromBackup(root: string, journal: LegacyMigrationStorageJournalV5): Promise<LegacyCatalog> {
  return (async () => {
    const target = path.join(root, ...journal.backupDir.split("/"), "files", "catalog.json");
    const { bytes } = await checkedFile(target);
    if (sha256(bytes) !== journal.oldCatalog) throw new Error("Verified migration backup lacks its original v1 catalog bytes.");
    const raw = JSON.parse(bytes.toString("utf8")) as unknown;
    assertCatalogStructure(raw, 1);
    const parsed = parseStoredCatalog(raw);
    if (parsed.version !== 1) throw new Error("Migration backup catalog is not v1.");
    return parsed;
  })();
}
async function validateBackup(root: string, journal: LegacyMigrationStorageJournalV5, start: MigrationStartInventory,
  currentInventory: MigrationStartInventory): Promise<MigrationStartInventory> {
  assertBackupParentListing(start, currentInventory, journal.backupDir);
  const manifestPath = path.join(root, ...journal.backupDir.split("/"), "manifest.json");
  const loaded = await checkedFile(manifestPath);
  if (sha256(loaded.bytes) !== journal.backupManifest) throw new Error("Verified migration backup manifest hash changed.");
  const manifest = parseMigrationBackupManifest(loaded.bytes);
  const expectedPaths = start.nodes.filter((node) => node.kind === "file" &&
    (node.path === "catalog.json" || node.path.startsWith("items/") || node.path.startsWith("sources/")))
    .map((node) => node.path).sort();
  const actualPaths = manifest.entries.map((entry) => entry.originalPath);
  if (canonicalJson(expectedPaths) !== canonicalJson(actualPaths)) throw new Error("Migration backup does not cover the exact migration-start catalog/items/sources files.");
  for (const entry of manifest.entries) {
    const node = inventoryNode(start, entry.originalPath);
    if (!node || node.kind !== "file" || node.bytesHash !== entry.sha256 || (node.mode & 0o777) !== entry.mode) {
      throw new Error("Migration backup manifest is not bound to the original start inventory.");
    }
  }
  await verifyMigrationBackup({ libraryRoot: root, backupDir: journal.backupDir, manifestBytes: loaded.bytes,
    manifestSha256: journal.backupManifest, entries: manifest.entries.map(({ originalPath, sha256: digest, mode }) => ({ originalPath, sha256: digest, mode })) });
  const namespace = await scanMigrationInventory(path.join(root, ".migration-backups"));
  const scannedParent = inventoryNode(namespace, ".");
  const currentParent = inventoryNode(currentInventory, ".migration-backups");
  if (!scannedParent || scannedParent.kind !== "directory" || !currentParent || currentParent.kind !== "directory" ||
      scannedParent.dev !== currentParent.dev || scannedParent.ino !== currentParent.ino || scannedParent.mode !== currentParent.mode) {
    throw new Error("Migration backup parent identity changed while custody was being checked.");
  }
  return backupScopedInventory(namespace, journal.backupDir);
}
async function verifyStableTrees(inventory: MigrationStartInventory, journal: LegacyMigrationStorageJournalV5): Promise<void> {
  if (stableTreeHash(inventory, "items") !== journal.stableItemsTree || stableTreeHash(inventory, "sources") !== journal.stableSourcesTree ||
      journal.stableSourcesTreeNext !== journal.stableSourcesTree) throw new Error("Migration-start items or sources tree commitment differs from the v5 journal.");
}
async function validateCatalogs(root: string, journal: LegacyMigrationStorageJournalV5, oldCatalog: LegacyCatalog): Promise<{ next: Catalog; proof: FileProof }> {
  const catalogPath = path.join(root, "catalog.json");
  const current = await checkedFile(catalogPath);
  if (current.proof.bytesHash !== journal.newCatalog) throw new Error("Resolution requires the catalog-switched v2 state.");
  const rawCurrent = JSON.parse(current.bytes.toString("utf8")) as unknown;
  assertCatalogStructure(rawCurrent, 2);
  const currentValue = parseStoredCatalog(rawCurrent);
  if (currentValue.version !== 2 || !current.bytes.equals(Buffer.from(`${JSON.stringify(currentValue, null, 2)}\n`, "utf8"))) {
    throw new Error("Resolution requires the exact committed canonical v2 catalog bytes.");
  }
  const nextPath = path.join(root, lockName, "next-catalog");
  const next = await checkedFile(nextPath);
  if (next.proof.bytesHash !== journal.newCatalog || !next.bytes.equals(current.bytes) || next.proof.dev !== current.proof.dev || next.proof.ino !== current.proof.ino) {
    throw new Error("Current v2 catalog is not the exact installed next-catalog inode.");
  }
  validateLegacyMigrationJournalTargets(journal, oldCatalog, currentValue);
  const oldNode = inventoryNode(journal.startInventory, "catalog.json");
  const oldStage = await checkedFile(path.join(root, lockName, "old-catalog"));
  const held = await checkedFile(path.join(root, lockName, "held-catalog"));
  if (!oldNode || oldNode.kind !== "file" || oldStage.proof.dev !== oldNode.dev || oldStage.proof.ino !== oldNode.ino ||
      held.proof.dev !== oldNode.dev || held.proof.ino !== oldNode.ino || oldStage.proof.bytesHash !== journal.oldCatalog ||
      held.proof.bytesHash !== journal.oldCatalog || oldStage.proof.mode !== oldNode.mode || held.proof.mode !== oldNode.mode) {
    throw new Error("Original catalog held/old inode does not match the migration-start inventory and backup.");
  }
  return { next: currentValue, proof: current.proof };
}
function initialArtifacts(lock: DirectoryProof, proofs: readonly FileProof[]): ArtifactProof[] {
  const fileNames = [
    ".copi-transaction/held-catalog", ".copi-transaction/old-catalog", ".copi-transaction/next-catalog",
    ".copi-transaction/journal.digest", ".copi-transaction/journal.json", ".copi-transaction/owner.json",
  ];
  if (proofs.length !== fileNames.length) throw new Error("Resolution cleanup requires the exact six original transaction files.");
  const artifacts: ArtifactProof[] = proofs.map((proof, index) => ({ name: fileNames[index]!, kind: "file", mode: proof.mode, dev: proof.dev, ino: proof.ino, hash: proof.bytesHash }));
  artifacts.push({ name: lockName, kind: "directory", mode: lock.mode, dev: lock.dev, ino: lock.ino,
    hash: sha256(Buffer.from(canonicalJson(fileNames.map((name) => [path.posix.basename(name), "file"]).sort(([a], [b]) => compareUtf8(String(a), String(b)))), "utf8")) });
  return artifacts;
}
function claimArtifacts(directory: DirectoryProof, owner: FileProof): ArtifactProof[] {
  return [
    { name: `${claimName}/owner.json`, kind: "file", mode: owner.mode, dev: owner.dev, ino: owner.ino, hash: owner.bytesHash },
    { name: claimName, kind: "directory", mode: directory.mode, dev: directory.dev, ino: directory.ino,
      hash: sha256(Buffer.from(canonicalJson([["owner.json", "file"]]), "utf8")) },
  ];
}
function compareCatalogIdentity(expected: FileProof, actual: FileProof): boolean {
  return expected.kind === "file" && actual.kind === "file" && expected.bytesHash === actual.bytesHash && expected.mode === actual.mode &&
    expected.dev === actual.dev && expected.ino === actual.ino;
}
function secretAndDiffView(root: string, oldCatalog: LegacyCatalog, nextCatalog: Catalog, journal: LegacyMigrationStorageJournalV5,
  identityChangedPaths: readonly string[]): Promise<{
  items: MigrationViewItem[]; maskedDiffs: MigrationMaskedDiff[]; sensitivePaths: string[]; warnings: MigrationWarning[];
}> {
  return (async () => {
    const items: MigrationViewItem[] = [];
    const maskedDiffs: MigrationMaskedDiff[] = [];
    const sensitive = new Set<string>();
    const warnings: MigrationWarning[] = [];
    const backupRoot = path.join(root, ...journal.backupDir.split("/"), "files");
    for (const oldItem of oldCatalog.items) {
      const next = nextCatalog.items.find((item) => item.id === oldItem.id);
      if (!next || !next.content.path.startsWith("sources/")) throw new Error("Resolution catalog item lost its adopted source target.");
      items.push({ id: next.id, name: next.name, target: next.content.path, selection: "sources" });
      const beforeFiles = await Promise.all(oldItem.files.map(async (file) => {
        const originalPath = oldItem.kind === "skill" ? `${next.content.path}/${file.path}` : next.content.path;
        const loaded = await checkedFile(path.join(backupRoot, ...originalPath.split("/")));
        return { path: file.path, mode: file.mode, bytes: loaded.bytes };
      }));
      const afterFiles = await sourceTreeFiles(root, next);
      const beforeInspect = inspectFixedResource({ candidate: { ...oldItem, sourceRoot: path.dirname(oldItem.sourcePath) }, files: beforeFiles, excludedPaths: [] });
      const afterInspect = inspectFixedResource({ candidate: { ...next, sourceRoot: path.dirname(next.sourcePath) }, files: afterFiles, excludedPaths: [] });
      for (const entry of beforeInspect.sensitivePaths) sensitive.add(`${oldItem.id}/${entry}`);
      for (const entry of afterInspect.sensitivePaths) sensitive.add(`${oldItem.id}/${entry}`);
      for (const warning of [...beforeInspect.warnings, ...afterInspect.warnings]) warnings.push({ code: warning.code, message: warning.message,
        ...(warning.path === undefined ? {} : { path: `${oldItem.id}/${warning.path}` }) });
      const before = new Map(beforeFiles.map((file) => [file.path, file.bytes]));
      const after = new Map(afterFiles.map((file) => [file.path, file.bytes]));
      for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8)) {
        const oldBytes = before.get(relative), newBytes = after.get(relative);
        const absolutePath = next.content.kind === "file" ? next.content.path : `${next.content.path}/${relative}`;
        const identityChanged = identityChangedPaths.includes(absolutePath);
        if (oldBytes && newBytes && oldBytes.equals(newBytes) && !identityChanged) continue;
        maskedDiffs.push(resolutionDiff(oldItem.id, relative, oldBytes, newBytes, identityChanged));
      }
    }
    const sensitivePaths = [...sensitive].sort(compareUtf8);
    return { items, maskedDiffs, sensitivePaths, warnings };
  })();
}
async function readInitialContext(root: string, reviewId: string): Promise<Analysis> {
  const recordState = await readRecord(root);
  const tempPath = await checkTemps(root, recordState);
  const lockPath = path.join(root, lockName);
  const lockStat = await statMaybe(lockPath);
  if (!lockStat) {
    if (recordState) return readRecordedContext(root, reviewId, recordState, tempPath);
    if (await statMaybe(path.join(root, claimName))) throw new Error("A recovery claim without its typed resolution record is preserved and blocked.");
    if (tempPath) throw new Error("A completed temporary resolution record has no authoritative root record.");
    return notNeeded(root, reviewId);
  }
  if (recordState) return readRecordedContext(root, reviewId, recordState, tempPath);
  if (await statMaybe(path.join(root, claimName))) throw new Error("An ownerless or unrecorded recovery claim is preserved and blocked.");
  const lock = await checkedDirectory(lockPath, 0o700);
  const names = (await readdir(lockPath)).sort(compareUtf8);
  const required = ["held-catalog", "journal.digest", "journal.json", "next-catalog", "old-catalog", "owner.json"];
  if (canonicalJson(names) !== canonicalJson(required)) throw new Error("Migration lock contains unknown, missing, or incomplete artifacts; preserving it.");
  const journalFile = await checkedFile(path.join(lockPath, "journal.json"));
  const digestFile = await checkedFile(path.join(lockPath, "journal.digest"));
  if (journalFile.proof.mode !== 0o600 || digestFile.proof.mode !== 0o600 || digestFile.bytes.toString("utf8") !== sha256(journalFile.bytes)) {
    throw new Error("Migration journal or digest is not the exact durable canonical record.");
  }
  const journalValue = JSON.parse(journalFile.bytes.toString("utf8")) as unknown;
  if (!isRecord(journalValue) || typeof journalValue.token !== "string") throw new Error("Migration journal has no exact token field.");
  const journal = parseStorageJournal(journalValue, { root, token: journalValue.token });
  if (journal.version !== 5) throw new Error("This resolution procedure requires a v5 start inventory; v4 remains in ordinary hold-stop.");
  if (journal.version !== 5 || journalFile.bytes.toString("utf8") !== canonicalStorageJournalJson(journal)) throw new Error("Migration v5 journal is not canonical or does not match its root/token.");
  const ownerFile = await checkedFile(path.join(lockPath, "owner.json"));
  if (ownerFile.proof.mode !== 0o600) throw new Error("Migration transaction owner must be mode 0600.");
  const owner = parseOwner(JSON.parse(ownerFile.bytes.toString("utf8")) as unknown, journal.token);
  if (!owner.migrationRootEntries) throw new Error("Migration transaction owner lacks its fixed root-entry commitment.");
  await ownerIsDead(owner);
  const start = parseMigrationStartInventory(journal.startInventory);
  await verifyStableTrees(start, journal);
  const currentInventory = await scanMigrationInventory(root, { excludedPrefixes: [lockName, claimName, recordName] });
  const backupInventory = await validateBackup(root, journal, start, currentInventory);
  const oldCatalog = await originalCatalogFromBackup(root, journal);
  const { next, proof: currentCatalogProof } = await validateCatalogs(root, journal, oldCatalog);
  const baselineLock = inventoryNode(start, lockName);
  const baselineClaim = inventoryNode(start, claimName);
  if (baselineLock || baselineClaim || inventoryNode(start, recordName)) throw new Error("Migration start inventory already contained a resolution or transaction control artifact.");
  const backupParent = inventoryNode(start, ".migration-backups");
  const hasBackupParent = !!backupParent;
  const excluded = backupPayloadExclusions(start, journal.backupDir);
  const classification = verifyAllowedPayloadChanges(root, start, currentInventory, oldCatalog, next, excluded);
  const projected = filteredInventory(currentInventory, excluded);
  const rootNames = (await readdir(root)).sort();
  const currentEntries = rootNames.filter((name) => name !== lockName && name !== claimName &&
    (hasBackupParent || name !== ".migration-backups"));
  const expectedEntries = [...owner.migrationRootEntries].sort();
  if (canonicalJson(currentEntries) !== canonicalJson(expectedEntries)) throw new Error("Root entries differ from the fixed v5 owner commitment outside the owned transaction.");
  const artifactsBeforeClaim = [
    (await checkedFile(path.join(lockPath, "held-catalog"))).proof,
    (await checkedFile(path.join(lockPath, "old-catalog"))).proof,
    (await checkedFile(path.join(lockPath, "next-catalog"))).proof,
    digestFile.proof, journalFile.proof, ownerFile.proof,
  ];
  const initial = initialArtifacts(lock, artifactsBeforeClaim);
  const changes = await secretAndDiffView(root, oldCatalog, next, journal, classification.changedPaths);
  const inventoryAfterView = await scanMigrationInventory(root, { excludedPrefixes: [lockName, claimName, recordName] });
  if (!inventoryHashEqual(currentInventory, inventoryAfterView)) throw new Error("Migration resolution inputs changed while masked review data was assembled.");
  const preservedPaths = classification.preserved;
  const view = makeView(reviewId, "ready", { backupDir: journal.backupDir, items: changes.items, maskedDiffs: changes.maskedDiffs,
    sensitivePaths: changes.sensitivePaths, warnings: changes.warnings, preservedPaths });
  const revision = sha256(canonicalJson({ journal: sha256(journalFile.bytes), owner: sha256(ownerFile.bytes), lock,
    currentCatalogProof, start: start.hash, current: projected.hash, backup: backupInventory.hash, changes: classification.changedPaths,
    secrets: changes.sensitivePaths, artifacts: initial.slice(0, 6), record: null, claim: null }));
  return { root, status: "ready", reviewId, view, revision, journal, journalRaw: journalFile.bytes, owner, ownerRaw: ownerFile.bytes,
    ownerProof: ownerFile.proof, originalCatalog: oldCatalog, nextCatalog: next, currentCatalogProof, lockProof: lock,
    backupInventory, approvedInventory: filteredInventory(currentInventory, excluded), cleanupArtifacts: initial.slice(0, 6), preservedPaths };
}
async function readRecordedContext(root: string, reviewId: string, recordState: RecordFileState, tempPath?: string): Promise<Analysis> {
  const record = recordState.record;
  if (record.root !== root) throw new Error("Resolution record is bound to another library root.");
  const journal = parseStorageJournal(JSON.parse(Buffer.from(record.originalJournal.rawBase64, "base64").toString("utf8")) as unknown, { root, token: record.token });
  if (journal.version !== 5 || journal.startInventory.hash !== (parseMigrationStartInventory(journal.startInventory)).hash) throw new Error("Resolution record has an invalid original v5 baseline.");
  const originalOwner = parseOwner(JSON.parse(Buffer.from(record.originalOwner.rawBase64, "base64").toString("utf8")) as unknown, record.token);
  if (alive(originalOwner)) throw new Error("Original migration owner is active; preserving the resolution record.");
  const claimDirPath = path.join(root, claimName);
  const claimStat = await statMaybe(claimDirPath);
  let claimOwner: ResolutionClaimOwnerV1 | undefined;
  let claimOwnerRaw: Buffer | undefined;
  let claimDirectoryProof: DirectoryProof | undefined;
  let claimOwnerProof: FileProof | undefined;
  if (claimStat) {
    claimDirectoryProof = await checkedDirectory(claimDirPath, 0o700);
    if (!sameProof(claimDirectoryProof, record.claim.directory)) throw new Error("Typed migration claim directory differs from the record proof.");
    const ownerPath = path.join(claimDirPath, "owner.json");
    if (await statMaybe(ownerPath)) {
      const ownerFile = await checkedFile(ownerPath);
      if (ownerFile.proof.mode !== 0o600) throw new Error("Typed resolution claim owner must be mode 0600.");
      claimOwnerRaw = ownerFile.bytes;
      claimOwnerProof = ownerFile.proof;
      claimOwner = parseClaimOwner(JSON.parse(ownerFile.bytes.toString("utf8")) as unknown,
        { root, token: record.token, resolutionId: record.resolutionId, journalRawHash: record.originalJournal.rawHash });
      if (!sameProof(claimOwnerProof, record.claim.owner) || ownerFile.bytes.toString("base64") !== record.claim.ownerRawBase64 ||
          ownerFile.bytes.toString("utf8") !== canonicalJson(claimOwner)) throw new Error("Typed migration claim differs from the record's creator proof.");
      if (claimOwner.host !== os.hostname() || isProcessAlive(claimOwner.pid)) throw new Error("Typed resolution claim creator is active or unknown; preserving the claim.");
    }
  } else if (record.progress.completed < 8 && !(record.progress.pending === 8)) {
    throw new Error("Typed resolution claim disappeared before its write-ahead cleanup prefix allowed it.");
  }
  const temp = await checkTemps(root, recordState);
  if (tempPath && temp !== tempPath) throw new Error("Resolution temp changed after review.");
  const start = parseMigrationStartInventory(journal.startInventory);
  const currentInventory = await scanMigrationInventory(root, { excludedPrefixes: [lockName, claimName, recordName, ...(temp ? [path.basename(temp)] : [])] });
  const exclusions = backupPayloadExclusions(start, record.backupDir, temp ? [path.basename(temp)] : []);
  const oldCatalog = await originalCatalogFromBackup(root, journal);
  const nextCatalogValue = await parseCurrentCatalog(root, record.currentCatalog);
  validateLegacyMigrationJournalTargets(journal, oldCatalog, nextCatalogValue);
  await verifyStableTreesFromBaseline(journal, start);
  const backupInventory = await validateBackup(root, journal, start, currentInventory);
  if (!inventoryHashEqual(backupInventory, record.backupInventory)) throw new Error("Verified migration backup inventory differs from the durable resolution record.");
  const currentCatalog = await checkedFile(path.join(root, "catalog.json"));
  if (!compareCatalogIdentity(record.currentCatalog, currentCatalog.proof)) throw new Error("Current catalog bytes, mode, or inode changed after resolution review.");
  const classification = verifyAllowedPayloadChanges(root, start, currentInventory, oldCatalog, nextCatalogValue, exclusions);
  const currentApproved = filteredInventory(currentInventory, exclusions);
  const needsGeneration = !inventoryHashEqual(currentApproved, record.approvedInventory);
  const progressIssue = await checkProgressArtifacts(root, record, recordState);
  if (progressIssue) throw new Error(progressIssue);
  const changes = await secretAndDiffView(root, oldCatalog, nextCatalogValue, journal, classification.changedPaths);
  const inventoryAfterView = await scanMigrationInventory(root, { excludedPrefixes: [lockName, claimName, recordName, ...(temp ? [path.basename(temp)] : [])] });
  if (!inventoryHashEqual(currentInventory, inventoryAfterView)) throw new Error("Migration resolution inputs changed while masked review data was assembled.");
  const recordAfterView = await readRecord(root);
  if (!recordAfterView || !recordAfterView.raw.equals(recordState.raw) || !sameProof(recordAfterView.proof, recordState.proof)) {
    throw new Error("Migration resolution record changed while masked review data was assembled.");
  }
  const progressAfterView = await checkProgressArtifacts(root, record, recordState);
  if (progressAfterView) throw new Error(progressAfterView);
  const view = makeView(reviewId, "ready", { backupDir: journal.backupDir, items: changes.items, maskedDiffs: changes.maskedDiffs,
    sensitivePaths: changes.sensitivePaths, warnings: changes.warnings, preservedPaths: classification.preserved });
  const revision = sha256(canonicalJson({ recordHash: sha256(recordState.raw), recordIdentity: recordState.proof,
    currentApproved: currentApproved.hash, backup: backupInventory.hash, catalog: currentCatalog.proof,
    claim: claimOwnerRaw ? sha256(claimOwnerRaw) : null, progress: record.progress, changed: classification.changedPaths,
    sensitivePaths: changes.sensitivePaths, generation: record.generation, predecessorHash: record.predecessorHash }));
  return { root, status: "ready", reviewId, view, revision, journal, journalRaw: Buffer.from(record.originalJournal.rawBase64, "base64"),
    owner: originalOwner, ownerRaw: Buffer.from(record.originalOwner.rawBase64, "base64"), ownerProof: record.originalOwner.file,
    originalCatalog: oldCatalog, nextCatalog: nextCatalogValue, currentCatalogProof: currentCatalog.proof,
    lockProof: record.lock, ...(claimOwner ? { claimOwner } : {}), ...(claimOwnerRaw ? { claimOwnerRaw } : {}),
    ...(claimDirectoryProof ? { claimDirectoryProof } : {}), ...(claimOwnerProof ? { claimOwnerProof } : {}),
    backupInventory, approvedInventory: currentApproved, cleanupArtifacts: record.cleanupArtifacts,
    recordState, needsGeneration, preservedPaths: classification.preserved };
}
async function parseCurrentCatalog(root: string, expected: FileProof): Promise<Catalog> {
  const current = await checkedFile(path.join(root, "catalog.json"));
  if (!compareCatalogIdentity(expected, current.proof)) throw new Error("Current catalog differs from its resolution record.");
  const raw = JSON.parse(current.bytes.toString("utf8")) as unknown;
  assertCatalogStructure(raw, 2);
  const parsed = parseStoredCatalog(raw);
  if (parsed.version !== 2 || !current.bytes.equals(Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"))) {
    throw new Error("Resolution record is no longer bound to the exact canonical v2 catalog bytes.");
  }
  return parsed;
}
async function verifyStableTreesFromBaseline(journal: LegacyMigrationStorageJournalV5, start: MigrationStartInventory): Promise<void> {
  if (stableTreeHash(start, "items") !== journal.stableItemsTree || stableTreeHash(start, "sources") !== journal.stableSourcesTree ||
      journal.stableSourcesTreeNext !== journal.stableSourcesTree) {
    throw new Error("Original inventory tree commitments differ from the v5 journal.");
  }
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}
async function checkProgressArtifacts(root: string, record: ResolutionRecordV1, recordState: RecordFileState): Promise<string | undefined> {
  const completed = record.progress.completed;
  const pending = record.progress.pending;
  for (let index = 0; index < record.cleanupArtifacts.length; index += 1) {
    const artifact = record.cleanupArtifacts[index]!;
    const target = path.join(root, ...artifact.name.split("/"));
    const exists = !!await statMaybe(target);
    const shouldBeAbsent = index < completed || index === pending && !exists;
    if (shouldBeAbsent && exists) return `Completed cleanup artifact reappeared: ${artifact.name}`;
    if (!shouldBeAbsent && !exists && index !== pending) return `Cleanup artifact disappeared outside the recorded write-ahead prefix: ${artifact.name}`;
    if (!exists) continue;
    if (artifact.kind === "file") {
      const actual = await checkedFile(target);
      if (actual.proof.mode !== artifact.mode || actual.proof.dev !== artifact.dev || actual.proof.ino !== artifact.ino || actual.proof.bytesHash !== artifact.hash) {
        return `Cleanup artifact changed from its fixed identity or bytes: ${artifact.name}`;
      }
    } else {
      const actual = await checkedDirectory(target, artifact.mode);
      if (actual.dev !== artifact.dev || actual.ino !== artifact.ino) return `Cleanup directory identity changed: ${artifact.name}`;
      const names = (await readdir(target)).sort(compareUtf8);
      const expected = index === 6
        ? (await Promise.all(record.cleanupArtifacts.slice(0, 6).map(async (entry) =>
            await statMaybe(path.join(root, ...entry.name.split("/"))) ? path.posix.basename(entry.name) : undefined)))
            .filter((name): name is string => name !== undefined).sort(compareUtf8)
        : index === 8 && await statMaybe(path.join(root, ...record.cleanupArtifacts[7]!.name.split("/"))) ? ["owner.json"] : [];
      if (canonicalJson(names) !== canonicalJson(expected)) return `Cleanup directory has unknown or missing children: ${artifact.name}`;
    }
  }
  const recordNow = await checkedFile(path.join(root, recordName));
  if (!recordNow.bytes.equals(recordState.raw) || !sameProof(recordNow.proof, recordState.proof)) return "Resolution record changed during cleanup verification.";
  return undefined;
}
async function readInitialAnalysis(root: string, reviewId: string): Promise<Analysis> {
  try { return await readInitialContext(root, reviewId); }
  catch (error) { return blocked(root, error instanceof Error ? error.message : "Migration resolution was blocked.", reviewId); }
}
export async function prepareMigrationResolution(libraryDir: string): Promise<PreparedMigrationResolution> {
  if (typeof libraryDir !== "string" || libraryDir.length === 0) throw new Error("Migration resolution libraryDir must be a nonempty path string.");
  const root = path.resolve(libraryDir);
  const reviewId = randomUUID();
  const existing = await statMaybe(root);
  if (!existing) return makePrepared(notNeeded(root, reviewId));
  let canonical: string | undefined;
  try { canonical = await readCanonicalRoot(libraryDir); }
  catch (error) { return makePrepared(blocked(root, error instanceof Error ? error.message : "Migration resolution root is unsafe.", reviewId)); }
  if (!canonical) return makePrepared(notNeeded(root, reviewId));
  return makePrepared(await readInitialAnalysis(canonical, reviewId));
}
export function readMigrationResolution(plan: PreparedMigrationResolution): MigrationResolutionView {
  const state = typeof plan === "object" && plan !== null ? preparedStates.get(plan) : undefined;
  if (!state || plan.reviewId !== state.view.reviewId) throw new Error("Invalid prepared migration resolution token.");
  return makeView(state.view.reviewId, state.view.status, state.view);
}
function snapshotApproval(value: unknown, expectedReviewId: string, sensitivePaths: readonly string[]): void {
  const keys = ["reviewId", "confirmed", "approvedSensitivePaths"];
  if (!exactKeys(value, keys)) throw new Error("Migration resolution approval must be a fixed own-data snapshot.");
  const approval = value as Record<string, unknown>;
  if (approval.reviewId !== expectedReviewId || approval.confirmed !== true || !denseArray(approval.approvedSensitivePaths) ||
      approval.approvedSensitivePaths.some((entry) => typeof entry !== "string")) throw new Error("Migration resolution approval does not match the reviewed confirmation.");
  const paths = approval.approvedSensitivePaths as string[];
  if (new Set(paths).size !== paths.length || canonicalJson([...paths].sort(compareUtf8)) !== canonicalJson([...sensitivePaths].sort(compareUtf8))) {
    throw new Error("Migration resolution requires individual approval for the exact sensitive path set.");
  }
}
function encodeProof(file: { bytes: Buffer; proof: FileProof }): EncodedFileProof {
  return { rawBase64: file.bytes.toString("base64"), rawHash: sha256(file.bytes), file: file.proof };
}
async function createTypedClaim(root: string, journal: LegacyMigrationStorageJournalV5, lock: DirectoryProof, resolutionId: string, journalRawHash: string,
  assertRootCurrent: () => Promise<void>): Promise<{
  directory: DirectoryProof; owner: FileProof; ownerRawBase64: string;
}> {
  const claimPath = path.join(root, claimName);
  await assertRootCurrent();
  await resolutionCheckpoint?.("before-claim-mkdir", root);
  await mkdir(claimPath, { mode: 0o700 });
  await chmod(claimPath, 0o700);
  await resolutionCheckpoint?.("after-claim-mkdir", root);
  const owner: ResolutionClaimOwnerV1 = { version: 1, mode: "legacy-migration-resolution-claim", root, token: journal.token,
    resolutionId, nonce: randomUUID(), host: os.hostname(), pid: process.pid, lock, journalRawHash };
  const bytes = Buffer.from(canonicalJson(owner), "utf8");
  const temp = path.join(claimPath, "owner.tmp");
  await assertRootCurrent();
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await resolutionCheckpoint?.("after-claim-owner-temp-write", root);
    await handle.sync();
    await resolutionCheckpoint?.("after-claim-owner-temp-sync", root);
  } finally { await handle.close(); }
  const ownerPath = path.join(claimPath, "owner.json");
  await assertRootCurrent();
  await link(temp, ownerPath);
  await resolutionCheckpoint?.("after-claim-owner-install", root);
  await syncDirectory(claimPath);
  await resolutionCheckpoint?.("after-claim-directory-sync", root);
  const ownerFile = await checkedFile(ownerPath);
  const directory = await checkedDirectory(claimPath, 0o700);
  if (!ownerFile.bytes.equals(bytes) || ownerFile.proof.mode !== 0o600 || (await readdir(claimPath)).sort(compareUtf8).join("|") !== "owner.json|owner.tmp") {
    throw new Error("Typed claim installation did not produce its exact durable owner proof.");
  }
  await assertRootCurrent();
  await unlink(temp);
  await resolutionCheckpoint?.("after-claim-temp-unlink", root);
  await syncDirectory(claimPath);
  await syncDirectory(root);
  await resolutionCheckpoint?.("after-claim-root-sync", root);
  const finalOwner = await checkedFile(ownerPath);
  const finalDirectory = await checkedDirectory(claimPath, 0o700);
  if (!finalOwner.bytes.equals(bytes) || (await readdir(claimPath)).sort(compareUtf8).join("|") !== "owner.json") throw new Error("Typed claim changed after durable installation.");
  return { directory: finalDirectory, owner: finalOwner.proof, ownerRawBase64: bytes.toString("base64") };
}
function recordBytes(record: ResolutionRecordV1): Buffer { return Buffer.from(canonicalJson(record), "utf8"); }
async function installInitialRecord(root: string, record: ResolutionRecordV1, assertRootCurrent: () => Promise<void>): Promise<RecordFileState> {
  const bytes = recordBytes(record);
  const temp = currentRecordTemp(root, record);
  await assertRootCurrent();
  const handle = await open(temp, "wx", 0o600);
  await resolutionCheckpoint?.("before-record-temp-write", root);
  try { await handle.writeFile(bytes); await resolutionCheckpoint?.("after-record-temp-write", root); await handle.sync(); await resolutionCheckpoint?.("after-record-temp-sync", root); }
  finally { await handle.close(); }
  await assertRootCurrent();
  await link(temp, path.join(root, recordName));
  await resolutionCheckpoint?.("after-record-install", root);
  await syncDirectory(root);
  await resolutionCheckpoint?.("after-record-root-sync", root);
  const installed = await checkedFile(path.join(root, recordName));
  if (!installed.bytes.equals(bytes) || installed.proof.mode !== 0o600) throw new Error("Durable resolution record differs from its approved fixed bytes.");
  await unlink(temp);
  await resolutionCheckpoint?.("after-record-temp-unlink", root);
  await syncDirectory(root);
  await resolutionCheckpoint?.("after-record-temp-root-sync", root);
  return { record, raw: bytes, proof: installed.proof };
}
type RecordUpdateKind = "action-intent" | "action-progress" | "generation";
async function replaceRecord(root: string, previous: RecordFileState, record: ResolutionRecordV1, assertRootCurrent: () => Promise<void>,
  updateKind: RecordUpdateKind): Promise<RecordFileState> {
  const current = await checkedFile(path.join(root, recordName));
  if (!current.bytes.equals(previous.raw) || !sameProof(current.proof, previous.proof)) throw new Error("Resolution record compare-and-swap failed.");
  const updatedRecord = { ...record, privateRevisionHash: reviewCommitment(record, { rawHash: sha256(previous.raw), proof: previous.proof }) };
  const bytes = recordBytes(updatedRecord);
  const temp = currentRecordTemp(root, record);
  const updatePoints = updateKind === "action-intent"
    ? { write: "after-action-intent-temp-write", sync: "after-action-intent-temp-sync", install: "after-action-intent-install", rootSync: "after-action-intent-root-sync" } as const
    : updateKind === "action-progress"
      ? { write: "after-action-progress-temp-write", sync: "after-action-progress-temp-sync", install: "after-action-progress-install", rootSync: "after-action-progress-root-sync" } as const
      : { write: "after-generation-temp-write", sync: "after-generation-temp-sync", install: "after-generation-replace", rootSync: "after-generation-root-sync" } as const;
  await assertRootCurrent();
  const handle = await open(temp, "wx", 0o600);
  if (updateKind === "action-intent") await resolutionCheckpoint?.("before-action-intent", root);
  try {
    await handle.writeFile(bytes);
    await resolutionCheckpoint?.(updatePoints.write, root);
    await handle.sync();
    await resolutionCheckpoint?.(updatePoints.sync, root);
  } finally { await handle.close(); }
  const second = await checkedFile(path.join(root, recordName));
  if (!second.bytes.equals(previous.raw) || !sameProof(second.proof, previous.proof)) throw new Error("Resolution record changed before atomic progress update.");
  await assertRootCurrent();
  await rename(temp, path.join(root, recordName));
  await resolutionCheckpoint?.(updatePoints.install, root);
  await syncDirectory(root);
  await resolutionCheckpoint?.(updatePoints.rootSync, root);
  const installed = await checkedFile(path.join(root, recordName));
  if (!installed.bytes.equals(bytes)) throw new Error("Atomic resolution record update installed unexpected bytes.");
  return { record: updatedRecord, raw: bytes, proof: installed.proof };
}
function withProgress(record: ResolutionRecordV1, completed: number, pending: number | null): ResolutionRecordV1 {
  return { ...record, progress: { phase: progressPhase(completed, pending), completed, pending } };
}
async function checkLiveRecord(root: string, recordState: RecordFileState): Promise<void> {
  const live = await readRecord(root);
  if (!live || !live.raw.equals(recordState.raw) || !sameProof(live.proof, recordState.proof)) throw new Error("Migration resolution record changed during cleanup.");
}
async function verifyApprovedInventory(root: string, record: ResolutionRecordV1): Promise<void> {
  const temp = await checkTemps(root, { record, raw: recordBytes(record), proof: (await checkedFile(path.join(root, recordName))).proof });
  const current = await scanMigrationInventory(root, { excludedPrefixes: [lockName, claimName, recordName, ...(temp ? [path.basename(temp)] : [])] });
  const journal = parseStorageJournal(JSON.parse(Buffer.from(record.originalJournal.rawBase64, "base64").toString("utf8")) as unknown, { root, token: record.token });
  if (journal.version !== 5) throw new Error("Resolution record no longer has an original v5 journal.");
  const start = parseMigrationStartInventory(journal.startInventory);
  const exclusions = backupPayloadExclusions(start, record.backupDir, temp ? [path.basename(temp)] : []);
  const actual = filteredInventory(current, exclusions);
  if (!inventoryHashEqual(actual, record.approvedInventory)) throw new Error("The approved payload, catalog, or outside inventory changed after resolution record installation.");
  const catalog = await checkedFile(path.join(root, "catalog.json"));
  if (!compareCatalogIdentity(record.currentCatalog, catalog.proof)) throw new Error("Current v2 catalog differs from its durable resolution record.");
  const oldCatalog = await originalCatalogFromBackup(root, journal);
  const nextCatalog = parseStoredCatalog(JSON.parse(catalog.bytes.toString("utf8")) as unknown);
  if (nextCatalog.version !== 2) throw new Error("Resolution current catalog is no longer v2.");
  verifyAllowedPayloadChanges(root, start, current, oldCatalog, nextCatalog, exclusions);
  const backupInventory = await validateBackup(root, journal, start, current);
  if (!inventoryHashEqual(backupInventory, record.backupInventory)) throw new Error("Permanent verified backup inventory changed during cleanup.");
}
async function removeAction(root: string, record: ResolutionRecordV1, index: number, allowMissing: boolean,
  assertRootCurrent: () => Promise<void>): Promise<void> {
  const artifact = record.cleanupArtifacts[index]!;
  const target = path.join(root, ...artifact.name.split("/"));
  const stat = await statMaybe(target);
  if (!stat) {
    if (allowMissing) return;
    throw new Error(`Write-ahead cleanup target is missing before its pending intent: ${artifact.name}`);
  }
  if (artifact.kind === "file") {
    const loaded = await checkedFile(target);
    if (loaded.proof.mode !== artifact.mode || loaded.proof.dev !== artifact.dev || loaded.proof.ino !== artifact.ino || loaded.proof.bytesHash !== artifact.hash) {
      throw new Error(`Write-ahead cleanup file differs from its fixed proof: ${artifact.name}`);
    }
    await assertRootCurrent();
    await resolutionCheckpoint?.("before-action-unlink", root);
    await unlink(target);
    await resolutionCheckpoint?.("after-action-unlink", root);
  } else {
    const directory = await checkedDirectory(target, artifact.mode);
    if (directory.dev !== artifact.dev || directory.ino !== artifact.ino || (await readdir(target)).length !== 0) {
      throw new Error(`Write-ahead cleanup directory is not the recorded empty directory: ${artifact.name}`);
    }
    await assertRootCurrent();
    await resolutionCheckpoint?.("before-action-unlink", root);
    await rmdir(target);
    await resolutionCheckpoint?.("after-action-unlink", root);
  }
  await resolutionCheckpoint?.("before-action-parent-sync", root);
  await syncDirectory(path.dirname(target));
  await resolutionCheckpoint?.("after-action-parent-sync", root);
}
async function updateProgress(root: string, state: RecordFileState, completed: number, pending: number | null,
  assertRootCurrent: () => Promise<void>, updateKind: "action-intent" | "action-progress"): Promise<RecordFileState> {
  const updated = withProgress(state.record, completed, pending);
  return replaceRecord(root, state, updated, assertRootCurrent, updateKind);
}
function directoryActionIndex(index: number): boolean { return index === 6 || index === 8; }
async function continueCleanup(root: string, initial: RecordFileState, assertRootCurrent: () => Promise<void>): Promise<void> {
  let state = initial;
  const initialAlias = await checkTemps(root, state);
  if (initialAlias) {
    const aliasFile = await checkedFile(initialAlias);
    if (!sameProof(aliasFile.proof, state.proof) || !aliasFile.bytes.equals(state.raw)) throw new Error("Resolution temporary is not an owned completed-record alias.");
    await assertRootCurrent();
    await unlink(initialAlias);
    await syncDirectory(root);
  }
  for (;;) {
    await assertRootCurrent();
    await checkLiveRecord(root, state);
    await verifyApprovedInventory(root, state.record);
    const mismatch = await checkProgressArtifacts(root, state.record, state);
    if (mismatch) throw new Error(mismatch);
    const { completed, pending } = state.record.progress;
    if (completed === 9) break;
    const index = pending ?? completed;
    if (index !== completed) throw new Error("Resolution write-ahead progress is not a completed prefix.");
    if (pending === null) state = await updateProgress(root, state, completed, index, assertRootCurrent, "action-intent");
    await verifyApprovedInventory(root, state.record);
    const progressIssue = await checkProgressArtifacts(root, state.record, state);
    if (progressIssue) throw new Error(progressIssue);
    await removeAction(root, state.record, index, true, assertRootCurrent);
    const after = await statMaybe(path.join(root, ...state.record.cleanupArtifacts[index]!.name.split("/")));
    if (after) throw new Error("Pending cleanup target reappeared after unlink.");
    state = await updateProgress(root, state, index + 1, null, assertRootCurrent, "action-progress");
    if (directoryActionIndex(index)) await syncDirectory(root);
  }
  await resolutionCheckpoint?.("after-terminal-update", root);
  await verifyApprovedInventory(root, state.record);
  const mismatch = await checkProgressArtifacts(root, state.record, state);
  if (mismatch) throw new Error(mismatch);
  await checkLiveRecord(root, state);
  const alias = await checkTemps(root, state);
  if (alias) {
    const aliasFile = await checkedFile(alias);
    if (!sameProof(aliasFile.proof, state.proof) || !aliasFile.bytes.equals(state.raw)) throw new Error("Resolution temp alias changed before terminal cleanup.");
    await assertRootCurrent();
    await unlink(alias);
    await syncDirectory(root);
  }
  const recordFile = await checkedFile(path.join(root, recordName));
  if (!recordFile.bytes.equals(state.raw) || !sameProof(recordFile.proof, state.proof)) throw new Error("Terminal resolution record changed before final removal.");
  await assertRootCurrent();
  await resolutionCheckpoint?.("before-record-unlink", root);
  await unlink(path.join(root, recordName));
  await resolutionCheckpoint?.("after-record-unlink", root);
  await syncDirectory(root);
  await resolutionCheckpoint?.("after-record-unlink-root-sync", root);
}

/** @internal Cooperating ordinary storage readers/writers call this while holding the O_EXLOCK root lease. */
export async function resumeCompletedMigrationResolution(root: string, assertRootCurrent: () => Promise<void> = async () => undefined): Promise<void> {
  await assertRootCurrent();
  const record = await readRecord(root);
  const names = await readdir(root, { encoding: "buffer" });
  const decodedNames = names.map((name) => new TextDecoder("utf-8", { fatal: true }).decode(name));
  const unknownTemps = decodedNames.filter(isRecordTempName);
  if (!record) {
    if (await statMaybe(path.join(root, claimName)) || unknownTemps.length > 0) throw new Error("Unowned migration resolution claim or temporary record exists; preserving it.");
    return;
  }
  const temp = await checkTemps(root, record);
  const analysis = await readRecordedContext(root, randomUUID(), record, temp);
  if (analysis.status !== "ready" || analysis.needsGeneration) throw new Error("A recorded migration resolution differs from its approved fixed state; explicit fresh review and approval are required.");
  if (temp) {
    const alias = await checkedFile(temp);
    if (!sameProof(alias.proof, record.proof) || !alias.bytes.equals(record.raw)) throw new Error("Resolution temporary is not an owned completed-record alias.");
    await unlink(temp);
    await syncDirectory(root);
  }
  await continueCleanup(root, record, assertRootCurrent);
}

export async function commitMigrationResolution(plan: PreparedMigrationResolution, approval: ChangeApproval): Promise<MigrationResult> {
  const state = typeof plan === "object" && plan !== null ? preparedStates.get(plan) : undefined;
  if (!state || plan.reviewId !== state.view.reviewId) throw new Error("Invalid prepared migration resolution token.");
  if (state.used) throw new Error("Prepared migration resolution was already consumed; prepare a new review.");
  state.used = true;
  if (state.view.status !== "ready") throw new Error(`Migration resolution is ${state.view.status}; it cannot be committed.`);
  snapshotApproval(approval, state.view.reviewId, state.view.sensitivePaths);
  const lease: StorageRootLease = await acquireRootLease(state.root, 5_000);
  try {
    await lease.assertCurrent();
    await resolutionCheckpoint?.("lease-acquired", state.root);
    const current = await readInitialAnalysis(state.root, state.view.reviewId);
    if (current.status !== "ready" || current.revision !== state.revision) throw new Error("Migration resolution state changed after review; prepare a fresh review before approval.");
    if (state.analysis.recordState) {
      const previous = current.recordState;
      if (!previous) throw new Error("Reviewed resolution record disappeared before commit.");
      if (current.needsGeneration) {
        const generation = previous.record.generation + 1;
        if (!Number.isSafeInteger(generation)) throw new Error("Migration resolution generation is exhausted.");
        const currentRecord = previous.record;
        const base = {
          ...currentRecord,
          generation,
          predecessorHash: sha256(previous.raw),
          reviewId: state.view.reviewId,
          currentCatalog: current.currentCatalogProof!,
          sensitivePaths: [...state.view.sensitivePaths],
          approvedInventory: current.approvedInventory!,
          progress: currentRecord.progress,
        };
        const record = { ...base, privateRevisionHash: "" } as ResolutionRecordV1;
        record.privateRevisionHash = reviewCommitment(base as Omit<ResolutionRecordV1, "privateRevisionHash">,
          { rawHash: sha256(previous.raw), proof: previous.proof });
        const replaced = await replaceRecord(state.root, previous, record, () => lease.assertCurrent(), "generation");
        await continueCleanup(state.root, replaced, () => lease.assertCurrent());
      } else {
        await continueCleanup(state.root, previous, () => lease.assertCurrent());
      }
      return { catalogVersion: 2, backupDir: current.journal!.backupDir, preservedPaths: [...current.view.preservedPaths] };
    }
    const journal = current.journal!;
    const lockProof = current.lockProof!;
    const resolutionId = randomUUID();
    const claim = await createTypedClaim(state.root, journal, lockProof, resolutionId, sha256(current.journalRaw!), () => lease.assertCurrent());
    const liveLock = await checkedDirectory(path.join(state.root, lockName), 0o700);
    if (!sameProof(liveLock, lockProof)) throw new Error("Migration lock directory identity changed after the readonly resolution review.");
    const lockNames = (await readdir(path.join(state.root, lockName))).sort(compareUtf8);
    if (canonicalJson(lockNames) !== canonicalJson(["held-catalog", "journal.digest", "journal.json", "next-catalog", "old-catalog", "owner.json"])) {
      throw new Error("Migration lock changed its exact artifact membership after the readonly resolution review.");
    }
    const lockFiles = await Promise.all([
      checkedFile(path.join(state.root, lockName, "held-catalog")),
      checkedFile(path.join(state.root, lockName, "old-catalog")),
      checkedFile(path.join(state.root, lockName, "next-catalog")),
      checkedFile(path.join(state.root, lockName, "journal.digest")),
      checkedFile(path.join(state.root, lockName, "journal.json")),
      checkedFile(path.join(state.root, lockName, "owner.json")),
    ]);
    const lockArtifacts = initialArtifacts(liveLock, lockFiles.map((file) => file.proof));
    if (canonicalJson(lockArtifacts.slice(0, 6)) !== canonicalJson(current.cleanupArtifacts) ||
        !lockFiles[4]!.bytes.equals(current.journalRaw!) || !lockFiles[5]!.bytes.equals(current.ownerRaw!)) {
      throw new Error("Migration journal, owner, stages, or lock files changed under the resolution review.");
    }
    const artifacts = [...lockArtifacts, ...claimArtifacts(claim.directory, claim.owner)];
    const previousInventory = current.approvedInventory!;
    const currentAll = await scanMigrationInventory(state.root, { excludedPrefixes: [lockName, claimName, recordName] });
    const startInventory = parseMigrationStartInventory(journal.startInventory);
    const approvedInventory = filteredInventory(currentAll, backupPayloadExclusions(startInventory, journal.backupDir));
    if (!inventoryHashEqual(approvedInventory, previousInventory)) throw new Error("Migration payload changed while the typed claim was installed.");
    const verifiedBackup = await validateBackup(state.root, journal, startInventory, currentAll);
    if (!inventoryHashEqual(verifiedBackup, current.backupInventory!)) throw new Error("Migration backup custody changed while the typed claim was installed.");
    const recordDraft: Omit<ResolutionRecordV1, "privateRevisionHash"> = {
      version: 1, mode: "legacy-migration-resolution", root: state.root, token: journal.token, resolutionId,
      generation: 1, predecessorHash: null,
      originalJournal: encodeProof({ bytes: current.journalRaw!, proof: (await checkedFile(path.join(state.root, lockName, "journal.json"))).proof }),
      oldCatalog: journal.oldCatalog, newCatalog: journal.newCatalog, currentCatalog: current.currentCatalogProof!,
      backupDir: journal.backupDir, backupManifest: journal.backupManifest, backupInventory: current.backupInventory!,
      reviewId: state.view.reviewId, confirmed: true, sensitivePaths: [...state.view.sensitivePaths], approvedInventory,
      originalOwner: encodeProof({ bytes: current.ownerRaw!, proof: current.ownerProof! }), lock: lockProof,
      claim, cleanupArtifacts: artifacts, progress: { phase: "artifacts", completed: 0, pending: null },
    };
    const record: ResolutionRecordV1 = { ...recordDraft, privateRevisionHash: reviewCommitment(recordDraft, null) };
    const installed = await installInitialRecord(state.root, record, () => lease.assertCurrent());
    await continueCleanup(state.root, installed, () => lease.assertCurrent());
    return { catalogVersion: 2, backupDir: journal.backupDir, preservedPaths: [...state.view.preservedPaths] };
  } finally {
    await lease.close();
  }
}
