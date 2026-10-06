import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { catalogBytes, readPreparedResource, withSavedLibrary, type PreparedResource, type SavedLibraryState } from "./catalog.ts";
import { inspectFixedResource, maskSensitiveText } from "./inspect.ts";
import { assertNoNameConflicts } from "./names.ts";
import { privateStoragePath as privatePath, readStorageBeforeReviewFiles, safeStoragePath, type StorageFile, type StorageReview, type StorageRevision, type StorageSession } from "./storage-transaction.ts";
import type { Catalog, InspectionResult, InspectionWarning, ResourceCandidate, ResourceDestination, SavedItem, SnapshotFileContents } from "./types.ts";

declare const editBrand: unique symbol;
declare const changeBrand: unique symbol;
export interface PreparedSavedEdit { readonly [editBrand]: true }
export interface PreparedSavedChange { readonly [changeBrand]: true; readonly reviewId: string }
export interface ChangeApproval { reviewId: string; confirmed: boolean; approvedSensitivePaths: readonly string[] }
export interface SavedEditView { readonly item: SavedItem; readonly file: SnapshotFileContents; readonly sensitivePaths: readonly string[]; readonly warnings: readonly InspectionWarning[] }
export interface SavedFileDiff { readonly path: string; readonly bytesChanged: boolean; readonly diff: string; readonly summary: string }
export interface SavedChangeView { readonly reviewId: string; readonly item: SavedItem; readonly diffs: readonly SavedFileDiff[]; readonly sensitivePaths: readonly string[]; readonly excludedPaths: readonly string[]; readonly warnings: readonly InspectionWarning[]; readonly bytesChanged: boolean }
interface EditState { libraryDir: string; revision: StorageRevision; catalog: Catalog; item: SavedItem; files: SnapshotFileContents[]; filePath: string }
interface ChangeState extends Omit<EditState, "filePath"> { storageReview: StorageReview; nextFiles: StorageFile[]; nextItem: SavedItem; excludedPaths: string[]; inspection: InspectionResult; diffs: SavedFileDiff[]; changed: boolean; used: boolean }
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
function assertKnownLayout(item: SavedItem, files: readonly SnapshotFileContents[]): void {
  const current = new Map(files.map((file) => [file.path, file]));
  if (current.size !== files.length) throw new Error("Registered sources content has duplicate paths.");
  if (item.content.kind === "file" && (files.length !== 1 || files[0]?.path !== path.posix.basename(item.content.path))) {
    throw new Error("Registered sources file must resolve to its single catalog path.");
  }
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
function inspect(item: SavedItem, files: readonly StorageFile[], excludedPaths: readonly string[] = []): InspectionResult {
  return inspectFixedResource({ candidate: candidate(item), files, excludedPaths });
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
function sameIncludedFiles(before: readonly StorageFile[], current: readonly SnapshotFileContents[]): boolean {
  if (before.length !== current.length) return false;
  const byPath = new Map(current.map((file) => [file.path, file]));
  return byPath.size === current.length && before.every((file) => {
    const listed = byPath.get(file.path);
    return listed !== undefined && file.bytes.equals(listed.bytes);
  });
}
async function makeChange(state: Omit<EditState, "filePath">, session: StorageSession, nextFiles: readonly StorageFile[], nextItem: SavedItem, excludedPaths: readonly string[] = []): Promise<PreparedSavedChange> {
  const files = nextFiles.map((file) => ({ path: file.path, mode: file.mode, bytes: Buffer.from(file.bytes) }));
  for (const file of files) if (!safeStoragePath(file.path) || privatePath(file.path)) throw new Error("Unsafe or excluded snapshot path in saved change.");
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Saved replacement must contain unique registered files.");
  const item = structuredClone(nextItem);
  item.files = files.map((file) => ({ path: file.path, mode: file.mode, sha256: sha256(file.bytes) }));
  const catalog = structuredClone(state.catalog);
  const itemIndex = catalog.items.findIndex((entry) => entry.id === item.id);
  if (itemIndex < 0) throw new Error("Saved item changed after preparation.");
  catalog.items[itemIndex] = structuredClone(item);
  const replacements = [{ itemId: item.id, files }];
  const storageReview = await session.prepareSourcesReview(state.revision, catalogBytes(catalog), replacements);
  const capturedBefore = readStorageBeforeReviewFiles(storageReview, item.id);
  if (!sameIncludedFiles(capturedBefore, state.files)) throw new Error("Before-reviewed source list does not match the current included files for this revision.");
  const currentByPath = new Map(state.files.map((file) => [file.path, file]));
  const beforeFiles = capturedBefore.map((file) => ({
    ...file,
    mode: currentByPath.get(file.path)!.mode,
  }));
  const diffs = fileDiffs(beforeFiles, files);
  const change = Object.freeze({ reviewId: randomUUID() }) as PreparedSavedChange;
  changes.set(change, { ...state, storageReview, nextFiles: files, nextItem: item, excludedPaths: [...excludedPaths], inspection: inspect(item, files, excludedPaths), diffs, changed: diffs.some((diff) => diff.bytesChanged) || JSON.stringify(item) !== JSON.stringify(state.item), used: false });
  return change;
}
export async function prepareSavedEdit(libraryDir: string, itemId: string, filePath: string): Promise<PreparedSavedEdit> {
  if (!safeStoragePath(filePath) || privatePath(filePath)) throw new Error("Unsafe or excluded saved edit path.");
  return withSavedLibrary(libraryDir, async (state) => {
    assertNoNameConflicts(state.catalog);
    const item = findItem(state, itemId);
    const files = state.files.get(item.id)!;
    assertKnownLayout(item, files);
    if (!item.files.some((entry) => entry.path === filePath)) throw new Error("Only an existing registered snapshot file can be edited.");
    const file = files.find((entry) => entry.path === filePath);
    if (!file) throw new Error("Only an existing registered snapshot file can be edited.");
    editable(file.bytes);
    const edit = Object.freeze({}) as PreparedSavedEdit;
    edits.set(edit, { libraryDir: state.session.root, revision: state.revision, catalog: structuredClone(state.catalog), item: structuredClone(item), files, filePath });
    return edit;
  });
}
export async function prepareSavedChange(edit: PreparedSavedEdit, bytes: Buffer): Promise<PreparedSavedChange> {
  const prepared = editState(edit);
  const fixed = Buffer.from(bytes);
  editable(fixed);
  return withSavedLibrary(prepared.libraryDir, async (state) => {
    await state.session.assertRevision(prepared.revision);
    assertNoNameConflicts(state.catalog);
    const item = findItem(state, prepared.item.id);
    const files = state.files.get(item.id)!;
    assertKnownLayout(item, files);
    if (!item.files.some((entry) => entry.path === prepared.filePath)) throw new Error("Only an existing registered snapshot file can be edited.");
    const sourceFile = files.find((file) => file.path === prepared.filePath);
    if (!sourceFile) throw new Error("Registered source file disappeared before edit preparation.");
    const current: Omit<EditState, "filePath"> = {
      libraryDir: state.session.root,
      revision: state.revision,
      catalog: structuredClone(state.catalog),
      item: structuredClone(item),
      files,
    };
    return makeChange(current, state.session, files.map((file) => ({ ...file, bytes: file.path === prepared.filePath ? fixed : file.bytes })), item);
  });
}
export function readSavedEdit(edit: PreparedSavedEdit): SavedEditView {
  const state = editState(edit);
  const file = state.files.find((file) => file.path === state.filePath)!;
  const inspection = inspect(state.item, [file]);
  return { item: structuredClone(state.item), file: { ...file, bytes: Buffer.from(file.bytes) }, sensitivePaths: [...inspection.sensitivePaths], warnings: structuredClone(inspection.warnings) };
}
export function readSavedChange(change: PreparedSavedChange): SavedChangeView {
  const state = changeState(change);
  return { reviewId: change.reviewId, item: structuredClone(state.nextItem), diffs: structuredClone(state.diffs), sensitivePaths: [...state.inspection.sensitivePaths], excludedPaths: [...state.excludedPaths], warnings: structuredClone(state.inspection.warnings), bytesChanged: state.diffs.some((diff) => diff.bytesChanged) };
}
export async function commitSavedChange(change: PreparedSavedChange, approval: ChangeApproval): Promise<SavedItem> {
  const state = changeState(change);
  if (state.used) throw new Error("Prepared change was already committed; prepare and review again.");
  if (approval.confirmed !== true) throw new Error("Saved change was not confirmed; no bytes were written.");
  if (approval.reviewId !== change.reviewId) throw new Error("Approval reviewId does not match this prepared change.");
  const inspected = inspect(state.nextItem, state.nextFiles, state.excludedPaths);
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
    const review = state.storageReview;
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
    const currentFiles = state.files.get(item.id)!;
    assertKnownLayout(item, currentFiles);
    if (source.candidate.kind !== item.kind) throw new Error("Replacement source must have the same resource kind.");
    if (source.candidate.destination.kind === "global-only" && item.destination.kind !== "global-only") throw new Error("A reference-only/global-only replacement source cannot become project-applicable.");
    const next = { ...structuredClone(item), source: source.candidate.source, scope: source.candidate.scope, sourcePath: source.candidate.sourcePath };
    return makeChange({ libraryDir: state.session.root, revision: state.revision, catalog: structuredClone(state.catalog), item: structuredClone(item), files: currentFiles }, state.session, source.files, next, source.excludedPaths);
  });
}
