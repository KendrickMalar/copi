import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { catalogBytes, readPreparedResource, withSavedLibrary, type PreparedResource, type SavedLibraryState } from "./catalog.ts";
import { inspectFixedResource, maskSensitiveText } from "./inspect.ts";
import { assertNoNameConflicts } from "./names.ts";
import { prepareStorageReview, privateStoragePath as privatePath, safeStoragePath, type StorageFile, type StorageRevision } from "./storage-transaction.ts";
import type { Catalog, InspectionResult, InspectionWarning, ResourceCandidate, ResourceDestination, SavedItem, SnapshotFileContents } from "./types.ts";

declare const editBrand: unique symbol;
declare const changeBrand: unique symbol;
export interface PreparedSavedEdit { readonly [editBrand]: true }
export interface PreparedSavedChange { readonly [changeBrand]: true; readonly reviewId: string }
export interface ChangeApproval { reviewId: string; confirmed: boolean; approvedSensitivePaths: readonly string[] }
export interface SavedEditView { readonly item: SavedItem; readonly file: SnapshotFileContents; readonly sensitivePaths: readonly string[]; readonly warnings: readonly InspectionWarning[] }
export interface SavedFileDiff { readonly path: string; readonly bytesChanged: boolean; readonly diff: string; readonly summary: string }
export interface SavedChangeView { readonly reviewId: string; readonly item: SavedItem; readonly diffs: readonly SavedFileDiff[]; readonly sensitivePaths: readonly string[]; readonly warnings: readonly InspectionWarning[]; readonly bytesChanged: boolean }
interface EditState { libraryDir: string; revision: StorageRevision; catalog: Catalog; item: SavedItem; files: SnapshotFileContents[]; filePath: string }
interface ChangeState extends Omit<EditState, "filePath"> { nextFiles: StorageFile[]; nextItem: SavedItem; inspection: InspectionResult; diffs: SavedFileDiff[]; changed: boolean; used: boolean }
const edits = new WeakMap<PreparedSavedEdit, EditState>();
const changes = new WeakMap<PreparedSavedChange, ChangeState>();
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function editable(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes)) throw new Error("Editing requires UTF-8 bytes.");
  if (bytes.length > 1_000_000) throw new Error("Saved text editing is limited to 1_000_000 bytes (1 MB).");
  if (bytes.includes(0)) throw new Error("Binary/NUL content is not editable as UTF-8 text.");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error("Unsupported encoding: saved text must be valid UTF-8."); }
}
function candidate(item: SavedItem): ResourceCandidate { return { ...structuredClone(item), sourceRoot: path.dirname(item.sourcePath) }; }
function findItem(state: SavedLibraryState, itemId: string): SavedItem {
  const item = state.catalog.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error("Unknown saved item.");
  return item;
}
async function assertKnownLayout(root: string, item: SavedItem): Promise<void> {
  const itemRoot = path.join(root, "items", item.id);
  if ((await readdir(itemRoot)).some((name) => name !== "files")) throw new Error("Unexpected unregistered content in saved item layout; no files were removed.");
  const known = new Set(item.files.map((file) => file.path));
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const child = path.join(directory, name);
      const filePath = relative ? `${relative}/${name}` : name;
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) throw new Error("Unsafe symbolic link in snapshot layout.");
      if (stat.isDirectory()) {
        if (![...known].some((entry) => entry.startsWith(`${filePath}/`))) throw new Error("Unexpected unregistered directory in saved snapshot layout.");
        await visit(child, filePath);
      } else if (!stat.isFile() || !known.has(filePath)) throw new Error("Unexpected unregistered file in saved snapshot layout; no files were removed.");
    }
  };
  await visit(path.join(itemRoot, "files"), "");
}

function editState(edit: PreparedSavedEdit): EditState {
  const state = edits.get(edit);
  if (!state) throw new Error("Invalid or unavailable prepared edit token.");
  return state;
}
function changeState(change: PreparedSavedChange): ChangeState {
  const state = changes.get(change);
  if (!state) throw new Error("Invalid or unavailable prepared change token.");
  return state;
}
function inspect(item: SavedItem, files: readonly StorageFile[]): InspectionResult {
  return inspectFixedResource({ candidate: candidate(item), files, excludedPaths: [] });
}
function fileDiffs(before: readonly StorageFile[], after: readonly StorageFile[]): SavedFileDiff[] {
  const previous = new Map(before.map((file) => [file.path, file]));
  const next = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...previous.keys(), ...next.keys()])].sort().map((filePath) => {
    const old = previous.get(filePath);
    const current = next.get(filePath);
    const bytesChanged = !old || !current || !old.bytes.equals(current.bytes);
    let diff = "";
    try {
      diff = createTwoFilesPatch(old ? filePath : "(new)", current ? filePath : "(removed)", maskSensitiveText(old ? editable(old.bytes) : ""), maskSensitiveText(current ? editable(current.bytes) : ""));
    } catch { /* Binary/large replacement files are summarized, never decoded or exposed. */ }
    return { path: filePath, bytesChanged, diff, summary: `${bytesChanged ? "Bytes changed" : "Bytes unchanged"}; ${old?.bytes.length ?? 0} → ${current?.bytes.length ?? 0} bytes; mode ${old?.mode.toString(8) ?? "absent"} → ${current?.mode.toString(8) ?? "absent"}.` };
  });
}
function makeChange(state: Omit<EditState, "filePath">, nextFiles: readonly StorageFile[], nextItem: SavedItem): PreparedSavedChange {
  const files = nextFiles.map((file) => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.bytes) }));
  for (const file of files) if (!safeStoragePath(file.path) || privatePath(file.path)) throw new Error("Unsafe or excluded snapshot path in saved change.");
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Saved replacement must contain unique registered files.");
  const diffs = fileDiffs(state.files, files);
  const item = structuredClone(nextItem);
  item.files = files.map((file) => ({ path: file.path, mode: file.mode, sha256: sha256(file.bytes) }));
  const change = Object.freeze({ reviewId: randomUUID() }) as PreparedSavedChange;
  changes.set(change, { ...state, nextFiles: files, nextItem: item, inspection: inspect(item, files), diffs, changed: diffs.some((diff) => diff.bytesChanged) || JSON.stringify(item) !== JSON.stringify(state.item), used: false });
  return change;
}
export async function prepareSavedEdit(libraryDir: string, itemId: string, filePath: string): Promise<PreparedSavedEdit> {
  if (!safeStoragePath(filePath) || privatePath(filePath)) throw new Error("Unsafe or excluded saved edit path.");
  return withSavedLibrary(libraryDir, async (state) => {
    assertNoNameConflicts(state.catalog);
    const item = findItem(state, itemId);
    await assertKnownLayout(state.session.root, item);
    const files = state.files.get(item.id)!;
    const file = files.find((entry) => entry.path === filePath);
    if (!file) throw new Error("Only an existing registered snapshot file can be edited.");
    editable(file.bytes);
    const edit = Object.freeze({}) as PreparedSavedEdit;
    edits.set(edit, { libraryDir: state.session.root, revision: state.revision, catalog: structuredClone(state.catalog), item: structuredClone(item), files, filePath });
    return edit;
  });
}
export async function prepareSavedChange(edit: PreparedSavedEdit, bytes: Buffer): Promise<PreparedSavedChange> {
  const state = editState(edit);
  const fixed = Buffer.from(bytes);
  editable(fixed);
  return makeChange(state, state.files.map((file) => ({ ...file, bytes: file.path === state.filePath ? fixed : file.bytes })), state.item);
}
export function readSavedEdit(edit: PreparedSavedEdit): SavedEditView {
  const state = editState(edit);
  const file = state.files.find((file) => file.path === state.filePath)!;
  const inspection = inspect(state.item, [file]);
  return { item: structuredClone(state.item), file: { ...file, bytes: Buffer.from(file.bytes) }, sensitivePaths: [...inspection.sensitivePaths], warnings: structuredClone(inspection.warnings) };
}
export function readSavedChange(change: PreparedSavedChange): SavedChangeView {
  const state = changeState(change);
  return { reviewId: change.reviewId, item: structuredClone(state.nextItem), diffs: structuredClone(state.diffs), sensitivePaths: [...state.inspection.sensitivePaths], warnings: structuredClone(state.inspection.warnings), bytesChanged: state.diffs.some((diff) => diff.bytesChanged) };
}
export async function commitSavedChange(change: PreparedSavedChange, approval: ChangeApproval): Promise<SavedItem> {
  const state = changeState(change);
  if (state.used) throw new Error("Prepared change was already committed; prepare and review again.");
  if (!approval.confirmed) throw new Error("Saved change was not confirmed; no bytes were written.");
  if (approval.reviewId !== change.reviewId) throw new Error("Approval reviewId does not match this prepared change.");
  const inspected = inspect(state.nextItem, state.nextFiles);
  const approved = new Set(approval.approvedSensitivePaths);
  if (approved.size !== approval.approvedSensitivePaths.length || approved.size !== inspected.sensitivePaths.length || inspected.sensitivePaths.some((filePath) => !approved.has(filePath))) throw new Error("Individual approval is required for every suspected sensitive file in this saved change.");
  return withSavedLibrary(state.libraryDir, async ({ catalog, session }) => {
    assertNoNameConflicts(catalog);
    await session.assertRevision(state.revision);
    const item = catalog.items.find((item) => item.id === state.item.id);
    if (!item) throw new Error("Saved item changed after preparation.");
    if (!state.changed) { state.used = true; return structuredClone(item); }
    catalog.items[catalog.items.indexOf(item)] = structuredClone(state.nextItem);
    const bytes = catalogBytes(catalog);
    const replacements = [{ itemId: item.id, files: state.nextFiles }];
    const review = prepareStorageReview(bytes, replacements);
    await session.commit(state.revision, bytes, replacements, { review, approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths: [...approved].map((filePath) => `${item.id}/${filePath}`) } });
    state.used = true;
    return structuredClone(state.nextItem);
  });
}
export async function changeSavedDestination(libraryDir: string, itemId: string, destination: ResourceDestination): Promise<SavedItem> {
  if (!destination || (destination.kind !== "global-only" && (destination.kind !== "project" || !safeStoragePath(destination.path) || privatePath(destination.path)))) throw new Error("Unsafe or private/excluded saved destination.");
  const fixed = { ...destination };
  return withSavedLibrary(libraryDir, async ({ catalog, revision, session }) => {
    assertNoNameConflicts(catalog);
    const item = catalog.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error("Unknown saved item.");
    if (item.destination.kind === "global-only" && fixed.kind !== "global-only") throw new Error("A reference-only/global-only resource cannot become project-applicable.");
    if (JSON.stringify(item.destination) === JSON.stringify(fixed)) return structuredClone(item);
    item.destination = fixed;
    await session.commit(revision, catalogBytes(catalog));
    return structuredClone(item);
  });
}
export async function prepareSavedReplacement(libraryDir: string, itemId: string, preparedSource: PreparedResource): Promise<PreparedSavedChange> {
  const source = readPreparedResource(preparedSource);
  return withSavedLibrary(libraryDir, async (state) => {
    assertNoNameConflicts(state.catalog);
    const item = findItem(state, itemId);
    await assertKnownLayout(state.session.root, item);
    if (source.candidate.kind !== item.kind) throw new Error("Replacement source must have the same resource kind.");
    if (source.candidate.destination.kind === "global-only" && item.destination.kind !== "global-only") throw new Error("A reference-only/global-only replacement source cannot become project-applicable.");
    const next = { ...structuredClone(item), source: source.candidate.source, scope: source.candidate.scope, sourcePath: source.candidate.sourcePath };
    return makeChange({ libraryDir: state.session.root, revision: state.revision, catalog: structuredClone(state.catalog), item: structuredClone(item), files: state.files.get(item.id)! }, source.files, next);
  });
}
