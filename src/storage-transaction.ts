import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertModernCatalog, parseStoredCatalog } from "./catalog.ts";
import { readSourceContent } from "./source-content.ts";
import { parseStorageJournal, validateSourcesJournalTargets, type SourcesStorageJournal } from "./storage-journal.ts";
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
  rootIdentity: DirectoryIdentity; lockIdentity: DirectoryIdentity;
  recoveryClaim?: { path: string; identity: DirectoryIdentity };
}
// Only run/recoverDead issue leases. Public constructor calls cannot register themselves.
const sessionLeases = new WeakMap<StorageSession, SessionLease>();
type SourcesOperation = SourcesStorageJournal["operations"][number];

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
      const mappedChildren = [...(replacements?.keys() ?? [])]
        .filter((mapped) => path.posix.dirname(mapped) === (relative === "." ? "." : relative))
        .map((mapped) => path.posix.basename(mapped));
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

async function validateSourcesTransition(root: string, previous: Catalog, next: Catalog, replacements: readonly StorageReplacement[]): Promise<SourcesOperation[]> {
  validateMutationNames(previous, next, replacements);
  if (previous.items.length !== next.items.length || JSON.stringify(previous.groups) !== JSON.stringify(next.groups)) {
    throw new Error("This sources transaction only replaces registered file content; catalog membership and groups must remain unchanged.");
  }
  const replacementById = new Map<string, StorageReplacement>();
  for (const replacement of replacements) {
    if (!itemPattern.test(replacement.itemId) || replacementById.has(replacement.itemId)) throw new Error("Duplicate or invalid sources replacement item.");
    replacementById.set(replacement.itemId, replacement);
  }
  const operations: SourcesOperation[] = [];
  for (const [index, oldItem] of previous.items.entries()) {
    const nextItem = next.items[index];
    if (!nextItem || nextItem.id !== oldItem.id) throw new Error("Sources replacement must preserve catalog item order and identity.");
    const replacement = replacementById.get(oldItem.id);
    if (!replacement) {
      if (JSON.stringify(nextItem) !== JSON.stringify(oldItem)) throw new Error("Unreplaced catalog items must remain byte-for-byte unchanged.");
      continue;
    }
    if (oldItem.content.kind !== "file" || nextItem.content.kind !== "file" || oldItem.content.path !== nextItem.content.path) {
      throw new Error("Only an existing registered content.kind=file at its original target may be replaced.");
    }
    const target = nextItem.content.path;
    const basename = path.posix.basename(target);
    const oldFile = oldItem.files[0];
    const nextFile = nextItem.files[0];
    const file = replacement.files[0];
    if (replacement.files.length !== 1 || oldItem.files.length !== 1 || nextItem.files.length !== 1 || !oldFile || !nextFile || !file ||
        file.path !== basename || nextFile.path !== basename || oldFile.path !== basename ||
        file.mode !== oldFile.mode || nextFile.mode !== oldFile.mode || nextFile.sha256 !== hash(file.bytes) ||
        !safeStoragePath(target) || !target.startsWith("sources/") || privateStoragePath(target) || privateStoragePath(file.path)) {
      throw new Error("A sources file replacement must contain exactly the registered basename and preserve its approved mode and catalog checksum.");
    }
    const expectedItem = { ...oldItem, files: nextItem.files };
    if (JSON.stringify(expectedItem) !== JSON.stringify(nextItem)) throw new Error("A file replacement may update only its registered file checksum.");
    const currentFiles = await readSourceContent(root, oldItem);
    if (currentFiles.length !== 1 || currentFiles[0]!.path !== basename) throw new Error("Registered sources file did not resolve to exactly its catalog basename.");
    await checkedSourceFileTarget(root, target);
    operations.push({ itemId: oldItem.id, target, kind: "file", oldTree: null, newTree: "0".repeat(64) });
  }
  if (replacementById.size !== operations.length) throw new Error("A sources replacement refers to an unknown catalog item.");
  return operations;
}

function validateSourcesCatalogTransition(previous: Catalog | null, next: Catalog, operations: readonly SourcesOperation[]): void {
  if (previous === null) {
    if (operations.length > 0 || next.items.length > 0 || next.groups.length > 0) throw new Error("A v2 file replacement requires an existing catalog item and registered sources file.");
    return;
  }
  if (previous.items.length !== next.items.length || JSON.stringify(previous.groups) !== JSON.stringify(next.groups)) throw new Error("Sources journal catalogs changed membership or groups outside a registered file replacement.");
  const byId = new Map(operations.map((operation) => [operation.itemId, operation]));
  for (const [index, oldItem] of previous.items.entries()) {
    const nextItem = next.items[index];
    if (!nextItem || nextItem.id !== oldItem.id) throw new Error("Sources journal catalogs changed item order or identity.");
    const operation = byId.get(oldItem.id);
    if (!operation) {
      if (JSON.stringify(nextItem) !== JSON.stringify(oldItem)) throw new Error("Sources journal contains an unrecorded catalog item change.");
      continue;
    }
    const oldFile = oldItem.files[0];
    const nextFile = nextItem.files[0];
    if (oldItem.content.kind !== "file" || nextItem.content.kind !== "file" || oldItem.content.path !== operation.target || nextItem.content.path !== operation.target ||
        !oldFile || !nextFile || oldItem.files.length !== 1 || nextItem.files.length !== 1 || oldFile.path !== path.posix.basename(operation.target) ||
        nextFile.path !== oldFile.path || nextFile.mode !== oldFile.mode || JSON.stringify({ ...oldItem, files: nextItem.files }) !== JSON.stringify(nextItem)) {
      throw new Error("Sources journal operation does not represent a checksum-only update to its registered file.");
    }
  }
  if (byId.size !== operations.length) throw new Error("Sources journal refers to an unknown catalog item.");
}

async function sourceFileTreeIfPresent(target: string): Promise<string | null> {
  const stat = await statMaybe(target);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Sources transaction target, stage, or backup is not a regular file.");
  return tree(target, undefined, true);
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writePrivate(target: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
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
    root, lock, owner: { ...owner }, stop: new AbortController(), pending: new Set(),
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
      } else { await rm(lock, { recursive: true }); await syncDirectory(root); }
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
        await rm(lock, { recursive: true });
        await syncDirectory(root);
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
  async #commitSources(expected: StorageRevision, previous: Catalog, next: Catalog, catalog: Buffer, replacements: readonly StorageReplacement[]): Promise<void> {
    const operations = await validateSourcesTransition(this.root, previous, next, replacements);
    const sourcesRoot = path.join(this.root, "sources");
    const targets = new Set(operations.map((operation) => operation.target.slice("sources/".length)));
    const stableSourcesTree = operations.length > 0
      ? await tree(sourcesRoot, undefined, true, targets)
      : await tree(sourcesRoot, undefined, true);
    if (stableSourcesTree === null) throw new Error("Registered sources root is missing.");
    await this.assertRevision(expected);

    for (const [index, operation] of operations.entries()) {
      const target = await checkedSourceFileTarget(this.root, operation.target);
      if (!target) throw new Error("Registered sources file disappeared before staging.");
      const stage = path.join(this.lock, `next-${index}`);
      await this.assertLease(false);
      const handle = await open(stage, "wx", 0o600);
      try {
        await handle.writeFile(replacements.find((replacement) => replacement.itemId === operation.itemId)!.files[0]!.bytes);
        await this.checkpoint?.("stage-write", this.root);
        await this.assertLease(false);
        await this.checkpoint?.("stage-sync", this.root);
        await this.assertLease(false);
        await handle.sync();
      } finally { await handle.close(); }
      const staged = await checkedFile(stage);
      const replacement = replacements.find((entry) => entry.itemId === operation.itemId)!;
      if (!staged || !staged.equals(replacement.files[0]!.bytes)) throw new Error("Staged sources bytes changed from the fixed inspected bytes; refusing save.");
      const oldTree = await tree(target, undefined, true);
      const newTree = await tree(stage, undefined, true);
      if (oldTree === null || newTree === null) throw new Error("Registered sources file or its private stage disappeared.");
      operations[index] = { ...operation, oldTree, newTree };
    }

    const catalogStage = path.join(this.lock, "next-catalog");
    await this.assertLease(false);
    const catalogHandle = await open(catalogStage, "wx", 0o600);
    try {
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
    if (expected.catalog !== null) await writePrivate(path.join(this.lock, "old-catalog"), Buffer.from(expected.catalog, "base64"));
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
    await writePrivate(path.join(this.lock, "journal.tmp"), journalBytes);
    await rename(path.join(this.lock, "journal.tmp"), path.join(this.lock, "journal.json"));
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
        const target = await checkedSourceFileTarget(this.root, operation.target);
        if (!target) throw new Error("Registered sources file disappeared during commit.");
        const oldPath = path.join(this.lock, `old-${index}`);
        await this.checkpoint?.("before-swap", this.root);
        await this.assertLease(false);
        if (await tree(target, undefined, true) !== operation.oldTree) throw new Error("Registered sources file changed during commit; refusing overwrite.");
        await rename(target, oldPath);
        await this.checkpoint?.("old-renamed", this.root);
        await this.assertLease(false);
        if (await tree(oldPath, undefined, true) !== operation.oldTree) throw new Error("Original sources inode changed after rename; retained external bytes instead of deleting them.");
        if (await statMaybe(target)) throw new Error("A file appeared at the registered sources target during commit.");
        const stage = path.join(this.lock, `next-${index}`);
        if (await checkedFile(stage) === undefined || await tree(stage, undefined, true) !== operation.newTree) throw new Error("Private sources stage changed during commit.");
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
        const target = await checkedSourceFileTarget(this.root, operation.target);
        if (!target || await tree(target, undefined, true) !== operation.newTree) throw new Error("Registered sources file changed before catalog update.");
        if (await tree(path.join(this.lock, `old-${index}`), undefined, true) !== operation.oldTree) throw new Error("Original sources inode changed; retaining the external bytes.");
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
        const target = await checkedSourceFileTarget(this.root, operation.target);
        if (target) await syncDirectory(path.dirname(target));
      }
      await syncDirectory(this.root);
      await this.checkpoint?.("committed", this.root);
      await this.assertLease(false);
      if (await tree(sourcesRoot, undefined, true) !== expectedNextTree || await tree(sourcesRoot, undefined, true, targets) !== stableSourcesTree || hash((await checkedFile(catalogPath))!) !== journal.newCatalog) throw new Error("Sources library changed during commit finalization.");
      for (const [index, operation] of operations.entries()) if (await tree(path.join(this.lock, `old-${index}`), undefined, true) !== operation.oldTree) throw new Error("Original sources inode changed during finalization; retaining external bytes.");
      const heldAtFinish = await checkedFile(heldPath);
      const heldAtFinishStat = await statMaybe(heldPath);
      if ((heldAtFinish ? hash(heldAtFinish) : null) !== journal.oldCatalog || (heldAtFinishStat && expected.catalogIdentity !== `${heldAtFinishStat.dev}:${heldAtFinishStat.ino}`)) throw new Error("Original held catalog changed during finalization; retaining external bytes.");
      await this.markFinalized();
      await rm(path.join(this.lock, "journal.json"));
      await this.checkpoint?.("finalized", this.root);
    } catch (error) {
      const operation = sessionLeases.get(this)?.operation;
      if (operation) operation.recovering = true;
      try { await this.recover(true); } catch (recoveryError) { throw new Error("Copi sources transaction could not safely recover an external change; retained private journal and source bytes.", { cause: new AggregateError([error, recoveryError]) }); }
      throw error;
    }
  }
  private async markFinalized(): Promise<void> {
    const revision = await this.capture();
    const record = JSON.stringify({ version: 1, root: this.root, token: this.token, catalog: revision.catalog === null ? null : hash(Buffer.from(revision.catalog, "base64")), tree: revision.tree });
    await writePrivate(path.join(this.lock, "finalized.json"), record);
    await writePrivate(path.join(this.lock, "finalized.digest"), hash(record));
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
  private async recoverSources(journal: SourcesStorageJournal, rollback: boolean): Promise<void> {
    const allowedEntries = new Set(["owner.json", "journal.json", "journal.digest", "next-catalog", "old-catalog", "held-catalog", "displaced-catalog", "rollback.json", "finalized.json", "finalized.digest"]);
    for (const index of journal.operations.keys()) {
      allowedEntries.add(`next-${index}`);
      allowedEntries.add(`old-${index}`);
      allowedEntries.add(`displaced-${index}`);
    }
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
    if (journal.operations.some((operation) => operation.kind !== "file" || operation.oldTree === null)) throw new Error("This v2 recovery slice only accepts existing registered file replacements.");

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
      await checkedSourceFileTarget(this.root, operation.target, true);
      const current = await sourceFileTreeIfPresent(target);
      const backup = await sourceFileTreeIfPresent(path.join(this.lock, `old-${index}`));
      const stage = await sourceFileTreeIfPresent(path.join(this.lock, `next-${index}`));
      const displaced = await sourceFileTreeIfPresent(path.join(this.lock, `displaced-${index}`));
      if (current !== operation.oldTree && current !== operation.newTree && !(current === null && backup === operation.oldTree && (stage === operation.newTree || displaced === operation.newTree))) throw new Error("V2 registered sources bytes or inode changed externally; refusing recovery.");
      if (displaced !== null && displaced !== operation.newTree) throw new Error("V2 displaced sources inode was changed externally.");
      if (backup !== null && backup !== operation.oldTree) throw new Error("V2 original sources inode is missing or altered.");
      if (stage !== null && stage !== operation.newTree) throw new Error("V2 private stage is altered or unsafe.");
      if (Number(current === operation.oldTree) + Number(backup === operation.oldTree) !== 1) throw new Error("V2 recovery does not have exactly one checked original sources inode.");
      if (Number(current === operation.newTree) + Number(stage === operation.newTree) + Number(displaced === operation.newTree) !== 1) throw new Error("V2 recovery does not have exactly one checked replacement inode.");
      if (committed && !rollback && current !== operation.newTree) throw new Error("Committed v2 sources file is missing or altered.");
      if ((!committed || rollback) && current !== operation.oldTree && backup !== operation.oldTree) throw new Error("V2 rollback bytes are missing.");
      const nextItem = nextStored.items.find((item) => item.id === operation.itemId)!;
      const nextFile = nextItem.files[0]!;
      const newPath = current === operation.newTree ? target : stage === operation.newTree ? path.join(this.lock, `next-${index}`) : path.join(this.lock, `displaced-${index}`);
      if (hash(await readFile(newPath)) !== nextFile.sha256) throw new Error("V2 replacement bytes do not match the new catalog descriptor.");
      states.push({ operation, current, backup, stage, displaced, target });
    }

    if (await this.verifyFinalized()) {
      if (!committed || !stableMatches || states.some((state) => state.current !== state.operation.newTree)) throw new Error("Finalized v2 transaction no longer matches its checked source tree.");
      await rm(path.join(this.lock, "journal.json"));
      return;
    }
    if (committed && !rollback) {
      if (!stableMatches) throw new Error("Unregistered or adjacent sources changed; refusing to finalize v2 commit.");
      await this.markFinalized();
      await rm(path.join(this.lock, "journal.json"));
      return;
    }

    if (journal.oldCatalog === null) throw new Error("V2 file replacement rollback requires its original catalog.");
    if (!rollbackMarker) { await writePrivate(path.join(this.lock, "rollback.json"), this.token); await syncDirectory(this.lock); }
    await this.checkpoint?.("rollback-started", this.root);
    for (const [index, state] of states.entries()) {
      const { operation, target } = state;
      await this.assertLease(false);
      const current = await sourceFileTreeIfPresent(target);
      if (current === operation.oldTree) continue;
      if (current !== null) {
        const displacedPath = path.join(this.lock, `displaced-${index}`);
        if (current !== operation.newTree || await statMaybe(displacedPath)) throw new Error("V2 live sources target changed during rollback; preserving the inode.");
        await rename(target, displacedPath);
        if (await sourceFileTreeIfPresent(displacedPath) !== operation.newTree) throw new Error("V2 replacement inode changed while being displaced; preserving it.");
        await this.checkpoint?.("rollback-displaced", this.root);
      }
      await this.assertLease(false);
      if (await statMaybe(target)) throw new Error("An external file appeared at the v2 sources target during rollback.");
      const original = path.join(this.lock, `old-${index}`);
      if (await sourceFileTreeIfPresent(original) !== operation.oldTree) throw new Error("V2 original sources inode changed before restoration; preserving it.");
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
      const current = await checkedSourceFileTarget(this.root, operation.target);
      if (!current || await sourceFileTreeIfPresent(current) !== operation.oldTree) throw new Error("V2 rollback did not restore the checked original inode.");
      for (const [prefix, expectedTree] of [["next", operation.newTree], ["displaced", operation.newTree], ["old", operation.oldTree]] as const) {
        const leftover = await sourceFileTreeIfPresent(path.join(this.lock, `${prefix}-${index}`));
        if (leftover !== null && leftover !== expectedTree) throw new Error("V2 retained source stage or backup changed during recovery.");
      }
    }
    if (stableNow !== await tree(sourcesRoot, undefined, true, targets)) throw new Error("Adjacent or unregistered sources changed during v2 rollback; retaining the journal.");
    if (!stableMatches) throw new Error("Adjacent or unregistered sources changed during v2 transaction; checked targets rolled back, journal retained.");
    const restoredCatalog = await checkedFile(path.join(this.root, "catalog.json"));
    if (!restoredCatalog || hash(restoredCatalog) !== journal.oldCatalog) throw new Error("V2 rollback failed to restore the exact original catalog.");
    await syncDirectory(this.root);
    await this.markFinalized();
    await rm(path.join(this.lock, "journal.json"));
    await this.checkpoint?.("rollback-finalized", this.root);
  }
  async recover(rollback: boolean): Promise<void> {
    await this.assertLease();
    const raw = await checkedFile(path.join(this.lock, "journal.json"));
    if (!raw) {
      if (await this.verifyFinalized()) return;
      const entries = await readdir(this.lock);
      if (entries.some((entry) => entry !== "owner.json" && entry !== "journal.tmp" && entry !== "next-catalog" && entry !== "old-catalog" && !/^next-\d+$/.test(entry))) throw new Error("Unknown files in dead copi transaction lock; inspect before recovery.");
      return; // Journal precedes every live mutation; unjournalled stages are disposable.
    }
    const digest = await checkedFile(path.join(this.lock, "journal.digest"));
    if (!digest || digest.toString("utf8") !== hash(raw)) throw new Error("Transaction journal is missing integrity information or was altered; refusing recovery.");
    const parsed = parseStorageJournal(JSON.parse(raw.toString("utf8")) as unknown, { root: this.root, token: this.token });
    if (parsed.version === 2) { await this.recoverSources(parsed, rollback); return; }
    const journal = parsed;
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
