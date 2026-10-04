import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseStoredCatalog } from "./catalog.ts";
import { inspectFixedResource } from "./inspect.ts";
import { assertNoNameConflicts, findNameConflicts, nameKey } from "./names.ts";
import type { Catalog, InspectionWarning, SavedItem, SnapshotFile } from "./types.ts";

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
interface TreeEntry { path: string; kind: "directory" | "file" | "link"; value: string; mode: number }
export interface StorageRevision { readonly root: string; readonly catalog: string | null; readonly tree: string }
export type StorageCheckpoint = "stage-write" | "stage-sync" | "journal" | "before-swap" | "old-renamed" | "new-renamed" | "before-catalog" | "catalog-held" | "catalog-renamed" | "directory-sync" | "committed" | "rollback-started" | "rollback-displaced" | "rollback-restored" | "rollback-catalog-held" | "finalized" | "rollback-finalized";
export interface StorageOptions { checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>; waitMilliseconds?: number }
interface Owner { version: 1; pid: number; host: string; token: string; blocked?: boolean }
interface JournalOperation { itemId: string; oldTree: string | null; newTree: string }
interface Journal { version: 1; root: string; token: string; oldCatalog: string | null; newCatalog: string; operations: JournalOperation[] }

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
async function tree(target: string, replacements?: ReadonlyMap<string, string>): Promise<string | null> {
  if (!await statMaybe(target)) return null;
  const entries: TreeEntry[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) entries.push({ path: relative, kind: "link", value: await readlink(current), mode: stat.mode & 0o777 });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", value: "", mode: stat.mode & 0o777 });
      const names = await readdir(current);
      const atRoot = relative === "." && replacements;
      for (const entry of [...new Set([...names, ...(atRoot ? replacements.keys() : [])])].sort()) {
        await visit(atRoot ? replacements.get(entry) ?? path.join(current, entry) : path.join(current, entry), path.posix.join(relative, entry));
      }
    } else if (stat.isFile()) entries.push({ path: relative, kind: "file", value: hash(await readFile(current)), mode: stat.mode & 0o777 });
    else throw new Error("Unsupported special file in copi storage.");
  }
  await visit(target, ".");
  return hash(JSON.stringify(entries));
}
async function snapshotBytes(root: string, item: SavedItem, file: SnapshotFile): Promise<Buffer> {
  const parents = ["items", item.id, "files", ...file.path.split("/").slice(0, -1)];
  let directory = root;
  for (const segment of parents) {
    directory = path.join(directory, segment);
    if (!await checkedDirectory(directory)) throw new Error("Snapshot contains a missing directory.");
  }
  const bytes = await checkedFile(path.join(directory, path.posix.basename(file.path)));
  if (!bytes || hash(bytes) !== file.sha256) throw new Error(`Snapshot checksum mismatch for ${file.path}; saved bytes were manually changed or damaged. Automatic checksum repair is refused.`);
  return bytes;
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
async function validateCommitCatalogs(root: string, previous: Catalog, next: Catalog, replacements: readonly StorageReplacement[]): Promise<void> {
  validateMutationNames(previous, next, replacements);
  for (const item of previous.items) for (const file of item.files) await snapshotBytes(root, item, file);
  for (const item of next.items) {
    const old = previous.items.find((entry) => entry.id === item.id);
    if (old?.destination.kind === "global-only" && item.destination.kind !== "global-only") throw new Error("A reference-only/global-only resource cannot become project-applicable.");
    if (item.destination.kind === "project" && JSON.stringify(old?.destination) !== JSON.stringify(item.destination) && privateStoragePath(item.destination.path)) throw new Error("Unsafe private/excluded resource destination.");
    if (replacements.some((replacement) => replacement.itemId === item.id)) continue;
    const newlyRegistered: StorageFile[] = [];
    for (const file of item.files) {
      const bytes = await snapshotBytes(root, item, file);
      if (!old?.files.some((entry) => JSON.stringify(entry) === JSON.stringify(file))) {
        if (privateStoragePath(file.path)) throw new Error("Private/excluded paths cannot be registered through a catalog save.");
        newlyRegistered.push({ ...file, bytes });
      }
    }
    if (newlyRegistered.length > 0 && inspectFixedResource({ candidate: { ...item, sourceRoot: path.dirname(item.sourcePath) }, files: newlyRegistered, excludedPaths: [] }).sensitivePaths.length > 0) throw new Error("Registering sensitive content requires a prepared storage inspection and individual approval, not a catalog-only update.");
  }
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
  return Object.freeze({ root, catalog: null, tree: "absent" });
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
  await checkedDirectory(lock);
  const bytes = await checkedFile(path.join(lock, "owner.json"));
  try { return ownerFrom(bytes ? JSON.parse(bytes.toString("utf8")) as unknown : null); } catch (error) { throw new Error("Copi transaction lock owner is missing or malformed; inspect the lock before recovery.", { cause: error }); }
}

async function storageDirectories(root: string, lock: string, checkItems = true): Promise<void> {
  await checkedDirectory(root);
  if (await realpath(root) !== root) throw new Error("Copi storage root changed through a symbolic link.");
  await checkedDirectory(lock);
  if (checkItems) await checkedDirectory(path.join(root, "items"));
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
    try { return await operation(session); } finally {
      await storageDirectories(root, lock, false);
      const actual = await readOwner(lock);
      if (actual.token !== owner.token) throw new Error("Copi transaction lock owner changed; refusing cleanup.");
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
    try {
      const lock = path.join(root, lockName);
      const current = await readOwner(lock);
      if (current.token !== expected.token || alive(current)) return;
      const session = new StorageSession(root, lock, current.token);
      await session.recover(false);
      await rm(lock, { recursive: true });
      await syncDirectory(root);
    } finally { await rm(claim, { recursive: true }); }
  }
}

export class StorageSession {
  constructor(readonly root: string, private readonly lock: string, private readonly token: string, private readonly checkpoint?: StorageOptions["checkpoint"]) {}
  async capture(): Promise<StorageRevision> {
    const catalog = await checkedFile(path.join(this.root, "catalog.json"));
    return Object.freeze({ root: this.root, catalog: catalog?.toString("base64") ?? null, tree: await tree(path.join(this.root, "items")) ?? "absent" });
  }
  async assertRevision(expected: StorageRevision): Promise<void> {
    if (JSON.stringify(await this.capture()) !== JSON.stringify(expected)) throw new Error("Copi library changed after preparation (catalog or saved bytes); reload and review before retrying. A manual checksum mismatch must not be repaired automatically.");
  }
  async commit(expected: StorageRevision, catalog: Buffer, replacements: readonly StorageReplacement[] = [], authorization?: StorageAuthorization): Promise<void> {
    const prepared = approvedStorage(catalog, replacements, authorization);
    catalog = prepared.catalog;
    replacements = prepared.replacements;
    await storageDirectories(this.root, this.lock);
    await this.assertRevision(expected);
    const previous = expected.catalog === null ? { version: 1 as const, items: [], groups: [] } : parseStoredCatalog(JSON.parse(Buffer.from(expected.catalog, "base64").toString("utf8")) as unknown);
    const next = parseStoredCatalog(JSON.parse(catalog.toString("utf8")) as unknown);
    await validateCommitCatalogs(this.root, previous, next, replacements);
    const operations: JournalOperation[] = [];
    if (new Set(replacements.map((replacement) => replacement.itemId)).size !== replacements.length) throw new Error("Duplicate snapshot replacement.");
    for (const [index, replacement] of replacements.entries()) {
      if (!itemPattern.test(replacement.itemId)) throw new Error("Invalid snapshot identifier.");
      const target = path.join(this.root, "items", replacement.itemId);
      if (await statMaybe(target)) await checkedDirectory(target);
      const stage = path.join(this.lock, `next-${index}`);
      await mkdir(path.join(stage, "files"), { recursive: true, mode: 0o700 });
      for (const file of replacement.files) {
        await storageDirectories(this.root, this.lock);
        if (!safeStoragePath(file.path)) throw new Error("Unsafe relative snapshot path.");
        const parent = path.join(stage, "files", path.posix.dirname(file.path));
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const handle = await open(path.join(parent, path.posix.basename(file.path)), "wx", 0o600);
        try {
          await handle.writeFile(file.bytes);
          await this.checkpoint?.("stage-write", this.root);
          await this.checkpoint?.("stage-sync", this.root);
          await handle.sync();
        } finally { await handle.close(); }
        const stored = await checkedFile(path.join(parent, path.posix.basename(file.path)));
        if (!stored || !stored.equals(file.bytes)) throw new Error("Staged bytes changed from the fixed inspected bytes; refusing save.");
      }
      operations.push({ itemId: replacement.itemId, oldTree: await tree(target), newTree: (await tree(stage))! });
    }
    const catalogHandle = await open(path.join(this.lock, "next-catalog"), "wx", 0o600);
    try {
      await catalogHandle.writeFile(catalog);
      await this.checkpoint?.("stage-write", this.root);
      await this.checkpoint?.("stage-sync", this.root);
      await catalogHandle.sync();
    } finally { await catalogHandle.close(); }
    const stagedCatalog = await checkedFile(path.join(this.lock, "next-catalog"));
    if (!stagedCatalog || !stagedCatalog.equals(catalog)) throw new Error("Staged catalog changed before commit; refusing live snapshot renames.");
    if (expected.catalog !== null) await writePrivate(path.join(this.lock, "old-catalog"), Buffer.from(expected.catalog, "base64"));
    const journal: Journal = { version: 1, root: this.root, token: this.token, oldCatalog: expected.catalog === null ? null : hash(Buffer.from(expected.catalog, "base64")), newCatalog: hash(catalog), operations };
    await writePrivate(path.join(this.lock, "journal.tmp"), JSON.stringify(journal));
    await rename(path.join(this.lock, "journal.tmp"), path.join(this.lock, "journal.json"));
    await writePrivate(path.join(this.lock, "journal.digest"), hash(JSON.stringify(journal)));
    await syncDirectory(this.lock);
    try {
      await this.checkpoint?.("journal", this.root);
      await storageDirectories(this.root, this.lock);
      const writtenJournal = await checkedFile(path.join(this.lock, "journal.json"));
      const writtenDigest = await checkedFile(path.join(this.lock, "journal.digest"));
      if (!writtenJournal || hash(writtenJournal) !== hash(JSON.stringify(journal)) || writtenDigest?.toString("utf8") !== hash(writtenJournal)) throw new Error("Transaction journal changed before commit; refusing snapshot renames.");
      await this.assertRevision(expected);
      if (operations.length > 0 && !await checkedDirectory(path.join(this.root, "items"))) await mkdir(path.join(this.root, "items"), { mode: 0o700 });
      const expectedNextTree = await tree(path.join(this.root, "items"), new Map(operations.map((operation, index) => [operation.itemId, path.join(this.lock, `next-${index}`)])));
      for (const [index, operation] of operations.entries()) {
        const target = path.join(this.root, "items", operation.itemId);
        await this.checkpoint?.("before-swap", this.root);
        await storageDirectories(this.root, this.lock);
        if (await tree(target) !== operation.oldTree) throw new Error("Saved snapshot changed during commit; refusing overwrite.");
        if (operation.oldTree !== null) await rename(target, path.join(this.lock, `old-${index}`));
        await this.checkpoint?.("old-renamed", this.root);
        await storageDirectories(this.root, this.lock);
        if (await tree(path.join(this.lock, `old-${index}`)) !== operation.oldTree) throw new Error("Original saved bytes changed in the moved snapshot; retained external bytes instead of deleting them.");
        if (await statMaybe(target)) throw new Error("An external file appeared during commit; refusing overwrite.");
        if (await tree(path.join(this.lock, `next-${index}`)) !== operation.newTree) throw new Error("Staged bytes changed during commit; refusing save.");
        await rename(path.join(this.lock, `next-${index}`), target);
        await this.checkpoint?.("new-renamed", this.root);
      }
      await this.checkpoint?.("before-catalog", this.root);
      await storageDirectories(this.root, this.lock);
      if (await tree(path.join(this.root, "items")) !== expectedNextTree) throw new Error("Saved bytes or another item changed during commit; refusing catalog update.");
      const actual = await checkedFile(path.join(this.root, "catalog.json"));
      if ((actual ? hash(actual) : null) !== journal.oldCatalog) throw new Error("Catalog changed during commit; refusing overwrite.");
      for (const operation of operations) if (await tree(path.join(this.root, "items", operation.itemId)) !== operation.newTree) throw new Error("Saved bytes changed during commit; refusing catalog update.");
      await this.assertOldSnapshots(operations);
      if (!(await checkedFile(path.join(this.lock, "next-catalog")))?.equals(catalog)) throw new Error("Staged catalog changed during commit; refusing save.");
      const destination = path.join(this.root, "catalog.json");
      const held = path.join(this.lock, "held-catalog");
      if (await statMaybe(held)) throw new Error("Unexpected held catalog; refusing overwrite.");
      if (actual) await rename(destination, held);
      await this.checkpoint?.("catalog-held", this.root);
      await storageDirectories(this.root, this.lock);
      const original = await checkedFile(held);
      if ((original ? hash(original) : null) !== journal.oldCatalog) throw new Error("Original catalog changed in its held inode; retained external bytes instead of deleting them.");
      // link() atomically refuses an externally recreated catalog.json; rename() could overwrite it.
      await link(path.join(this.lock, "next-catalog"), destination);
      await this.checkpoint?.("catalog-renamed", this.root);
      await this.checkpoint?.("directory-sync", this.root);
      await storageDirectories(this.root, this.lock);
      if (operations.length > 0) await syncDirectory(path.join(this.root, "items"));
      await syncDirectory(this.root);
      await this.checkpoint?.("committed", this.root);
      if (await tree(path.join(this.root, "items")) !== expectedNextTree || hash((await checkedFile(path.join(this.root, "catalog.json")))!) !== journal.newCatalog) throw new Error("Saved library changed during commit finalization.");
      await this.assertOldSnapshots(operations);
      const originalAtFinish = await checkedFile(held);
      if ((originalAtFinish ? hash(originalAtFinish) : null) !== journal.oldCatalog) throw new Error("Original held catalog changed during finalization; retained external bytes.");
      await this.markFinalized();
      await rm(path.join(this.lock, "journal.json"));
      await this.checkpoint?.("finalized", this.root);
    } catch (error) {
      try { await this.recover(true); } catch (recoveryError) { throw new Error("Copi transaction could not safely recover an external change; retained private journal, no external bytes were overwritten.", { cause: new AggregateError([error, recoveryError]) }); }
      throw error;
    }
  }
  private async assertOldSnapshots(operations: readonly JournalOperation[]): Promise<void> {
    for (const [index, operation] of operations.entries()) {
      if (await tree(path.join(this.lock, `old-${index}`)) !== operation.oldTree) throw new Error("Original saved bytes changed in a moved snapshot; retained external bytes instead of deleting them.");
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
  async recover(rollback: boolean): Promise<void> {
    await storageDirectories(this.root, this.lock);
    const raw = await checkedFile(path.join(this.lock, "journal.json"));
    if (!raw) {
      if (await this.verifyFinalized()) return;
      const entries = await readdir(this.lock);
      if (entries.some((entry) => entry !== "owner.json" && entry !== "journal.tmp" && entry !== "next-catalog" && entry !== "old-catalog" && !/^next-\d+$/.test(entry))) throw new Error("Unknown files in dead copi transaction lock; inspect before recovery.");
      return; // Journal precedes every live mutation; unjournalled stages are disposable.
    }
    const digest = await checkedFile(path.join(this.lock, "journal.digest"));
    if (!digest || digest.toString("utf8") !== hash(raw)) throw new Error("Transaction journal is missing integrity information or was altered; refusing recovery.");
    const journal = JSON.parse(raw.toString("utf8")) as Journal;
    if (journal.version !== 1 || journal.root !== this.root || journal.token !== this.token || !Array.isArray(journal.operations) || journal.operations.some((operation) => !itemPattern.test(operation.itemId) || typeof operation.newTree !== "string" || (operation.oldTree !== null && typeof operation.oldTree !== "string")) || new Set(journal.operations.map((operation) => operation.itemId)).size !== journal.operations.length || typeof journal.newCatalog !== "string" || (journal.oldCatalog !== null && typeof journal.oldCatalog !== "string")) throw new Error("Invalid copi transaction recovery journal; refusing recovery.");
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
      await storageDirectories(this.root, this.lock);
      const target = path.join(this.root, "items", operation.itemId);
      const current = await tree(target);
      if (current === operation.oldTree) continue;
      if (current !== null) {
        // Keep recovery itself restartable; never recursively delete a live snapshot.
        await rename(target, path.join(this.lock, `displaced-${index}`));
        if (await tree(path.join(this.lock, `displaced-${index}`)) !== operation.newTree) throw new Error("Snapshot changed externally during rollback; retained bytes instead of deleting them.");
        await this.checkpoint?.("rollback-displaced", this.root);
      }
      await storageDirectories(this.root, this.lock);
      if (await statMaybe(target)) throw new Error("An external snapshot appeared during rollback; refusing overwrite.");
      if (operation.oldTree !== null) {
        const original = path.join(this.lock, `old-${index}`);
        if (await tree(original) !== operation.oldTree) throw new Error("Original rollback bytes changed externally; retained them instead of restoring unchecked data.");
        await rename(original, target);
      }
      await this.checkpoint?.("rollback-restored", this.root);
    }
    if (committed) {
      const destination = path.join(this.root, "catalog.json");
      await rename(destination, path.join(this.lock, "displaced-catalog"));
      const displaced = await checkedFile(path.join(this.lock, "displaced-catalog"));
      if (!displaced || hash(displaced) !== journal.newCatalog) throw new Error("Catalog changed externally during rollback; retained bytes instead of deleting them.");
      await this.checkpoint?.("rollback-catalog-held", this.root);
    }
    if (committed || catalogInTransit) {
      if (oldCatalog) {
        await storageDirectories(this.root, this.lock);
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
