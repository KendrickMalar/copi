import { autocompleteMultiselect as clackMultiselect, cancel as clackCancel, confirm as clackConfirm, intro as clackIntro, isCancel, log, note as clackNote, outro as clackOutro, progress as clackProgress, select as clackSelect, spinner as clackSpinner, text as clackText } from "@clack/prompts";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, importPreparedResource, loadCatalog, prepareResource, readPreparedResource, readSnapshotFiles, saveCatalog, saveNameChanges, type PreparedFile, type PreparedInspection, type PreparedResource } from "./catalog.ts";
import { discoverResources, piAgentDirectories, type DiscoveryOptions, type DiscoveryProgress } from "./discovery.ts";
import { createGroup, renameGroup, setGroupItems } from "./groups.ts";
import { candidateHint, candidateLabels, collapseIdenticalCandidates, contentFingerprint, defaultRenameName, displayPath, findSelectionConflicts, formatSearchProgress, formatOutsideRootSummary, gatherCandidateStats, identicalCopiesSuffix, pendingNameError, sortCandidates } from "./setup-display.ts";
import { inspectPreparedResource, maskSensitiveText } from "./inspect.ts";
import { assertNameAvailable, assertNoNameConflicts, findNameConflicts, nameKey } from "./names.ts";
import type { ApplyDecisions, ApplyFileOption, ApplyPlan } from "./apply.ts";
import { executeApply, planApply } from "./apply.ts";
import type { Catalog, Group, LegacySavedItem, ResourceCandidate, SavedItem, StoredCatalog } from "./types.ts";

/** Mask display metadata too, and render controls literally rather than executing VT sequences. */
export function safeDisplay(value: string): string {
  return maskSensitiveText(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[internal reference]")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
let activeSignal: AbortSignal | undefined;
let editorOwnsControlInput = false;

/** The editor parses literal paste versus cancel keys; stream EOF/errors/signals stay global. */
export async function withEditorInput<T>(operation: () => Promise<T>): Promise<T> {
  const previous = editorOwnsControlInput;
  editorOwnsControlInput = true;
  try { return await operation(); }
  finally { editorOwnsControlInput = previous; }
}

function inheritedSignal(signal?: AbortSignal): { signal?: AbortSignal } {
  const current = signal ?? activeSignal;
  return current ? { signal: current } : {};
}
const select: typeof clackSelect = (options) => clackSelect({
  ...options, ...inheritedSignal(options.signal), message: safeDisplay(options.message),
  options: options.options.map((option) => ({ ...option, label: safeDisplay(option.label ?? "Unavailable entry"), ...(option.hint === undefined ? {} : { hint: safeDisplay(option.hint) }) })),
});
// Clack's own key legend is dim and below the list; repeat it in the question so Tab-to-select is not missed.
export const multiselectKeyHint = "(Tab: select, Enter: confirm)";
const autocompleteMultiselect: typeof clackMultiselect = (options) => clackMultiselect({
  ...options, ...inheritedSignal(options.signal), message: `${safeDisplay(options.message)} ${multiselectKeyHint}`,
  options: typeof options.options === "function" ? options.options : options.options.map((option) => ({ ...option, label: safeDisplay(option.label ?? "Unavailable entry"), ...(option.hint === undefined ? {} : { hint: safeDisplay(option.hint) }) })),
});
const text: typeof clackText = (options) => clackText({ ...options, ...inheritedSignal(options.signal), message: safeDisplay(options.message) });
const confirm: typeof clackConfirm = (options) => clackConfirm({ ...options, ...inheritedSignal(options.signal), message: safeDisplay(options.message) });
const note: typeof clackNote = (message, title, options) => clackNote(safeDisplay(message ?? ""), safeDisplay(title ?? ""), options);
const intro: typeof clackIntro = (message, options) => clackIntro(safeDisplay(message ?? ""), options);
const outro: typeof clackOutro = (message, options) => clackOutro(safeDisplay(message ?? ""), options);
const cancel: typeof clackCancel = (message, options) => clackCancel(safeDisplay(message ?? ""), options);

/** One process-wide interactive lifecycle shared by manage and its existing wizard routes. */
export async function withWizardLifecycle(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (activeSignal) throw new Error("An interactive wizard is already active.");
  const controller = new AbortController();
  const wasRaw = Boolean(process.stdin.isRaw), wasFlowing = process.stdin.readableFlowing === true;
  const abort = () => controller.abort();
  const eofKey = (chunk: Buffer | string) => {
    if (!editorOwnsControlInput && (typeof chunk === "string" ? chunk.includes("\u0004") : chunk.includes(4))) abort();
  };
  activeSignal = controller.signal;
  process.stdin.on("end", abort); process.stdin.on("close", abort); process.stdin.on("error", abort); process.stdin.on("data", eofKey);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, abort);
  try { await operation(controller.signal); }
  finally {
    activeSignal = undefined;
    process.stdin.off("end", abort); process.stdin.off("close", abort); process.stdin.off("error", abort); process.stdin.off("data", eofKey);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, abort);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    // Adding our data listener starts an inactive reader too; restore its original ownership.
    if (wasFlowing) process.stdin.resume();
    else process.stdin.pause();
    process.stdout.write("\u001b[?25h");
  }
}

const previewMaxBytes = 1_000_000;
const previewMaxFiles = 12;
const previewMaxLines = 24;

export interface SearchRoots {
  homeDir: string;
  agentDir: string;
  projectDir: string;
}

export interface SearchScopes {
  home: boolean;
  project: boolean;
  piDirs?: boolean;
}

export function buildSearchOptions(roots: SearchRoots, scopes: SearchScopes): DiscoveryOptions | undefined {
  if (!scopes.home && !scopes.project && !scopes.piDirs) return undefined;
  return {
    ...roots,
    scopes: { home: scopes.home, project: scopes.project, ...(scopes.piDirs ? { piDirs: true } : {}) },
  };
}

export function formatMaskedPreview(relativePath: string, content: string): string {
  const masked = maskSensitiveText(content);
  const lines = masked.split(/\r?\n/);
  const snippet = lines.slice(0, previewMaxLines).join("\n").slice(0, 2_000);
  const omitted = lines.length > previewMaxLines ? `\n… ${lines.length - previewMaxLines} more lines` : "";
  return safeDisplay(`${relativePath}:\n${snippet}${omitted}`);
}

function formatPreparedFiles(files: readonly PreparedFile[]): string[] {
  return files.slice(0, previewMaxFiles).map((file) => {
    if (file.bytes.length > previewMaxBytes || file.bytes.includes(0)) {
      return `${file.path}: [binary or large file, ${file.bytes.length} bytes]`;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      return formatMaskedPreview(file.path, text);
    } catch {
      return `${file.path}: [binary or large file, ${file.bytes.length} bytes]`;
    }
  });
}

export interface CandidateReview {
  candidate: ResourceCandidate;
  prepared: PreparedResource;
  inspection: PreparedInspection;
  preview: string[];
}

export async function prepareCandidateForReview(candidate: ResourceCandidate): Promise<CandidateReview> {
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const snapshot = readPreparedResource(prepared);
  return { candidate: snapshot.candidate, prepared, inspection, preview: formatPreparedFiles(snapshot.files) };
}

export async function saveReviewedCandidate(
  libraryDir: string,
  review: CandidateReview,
  groupIds: string[],
  approvedSensitivePaths: string[],
  confirmed: boolean,
): Promise<SavedItem | null> {
  if (!confirmed) return null;
  return importPreparedResource(libraryDir, review.prepared, {
    confirmed,
    groupIds,
    inspection: review.inspection,
    approvedSensitivePaths,
  });
}

function showSearchWarnings(warnings: readonly { code: string; path?: string; message: string }[], home: string): void {
  const summary = formatOutsideRootSummary(warnings.filter((warning) => warning.code === "resource-outside-root" && warning.path !== undefined).map((warning) => warning.path as string), home);
  if (summary) note(summary.body, summary.title);
  showWarnings(warnings.filter((warning) => warning.code !== "resource-outside-root" || warning.path === undefined), "Search warnings");
}

function showWarnings(warnings: readonly { code: string; path?: string; message: string }[], title: string): void {
  if (warnings.length === 0) return;
  note(warnings.map((warning) => `${warning.path ? `${warning.path}: ` : ""}${warning.message}`).join("\n"), title);
}

function savedItemHint(catalog: StoredCatalog, item: LegacySavedItem | SavedItem): string {
  const groups = catalog.groups.filter((group) => group.itemIds.includes(item.id)).map((group) => group.name).join(", ") || "no groups";
  return `${groups} · ${item.source} · ${item.destination.kind === "project" ? item.destination.path : "saved only"}`;
}

async function viewSavedEntry(libraryDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
  const entry = await select({
    message: "Select saved resource or group",
    options: [
      ...catalog.items.map((item) => ({ value: `item:${item.id}`, label: `[${item.kind}] ${item.name}`, hint: savedItemHint(catalog, item) })),
      ...catalog.groups.map((group) => ({ value: `group:${group.id}`, label: `[group] ${group.name}`, hint: `${group.itemIds.length} resources` })),
    ],
  });
  if (isCancel(entry)) return;
  const item = catalog.items.find((item) => `item:${item.id}` === entry);
  if (item) {
    const files = await readSnapshotFiles(libraryDir, item);
    note(formatPreparedFiles(files).join("\n\n") || "No previewable files.", `Masked saved preview: ${item.name}`);
  } else {
    const group = catalog.groups.find((group) => `group:${group.id}` === entry);
    if (!group) throw new Error("Selected group is no longer available.");
    note(group.itemIds.map((id) => {
      const member = catalog.items.find((item) => item.id === id);
      return member ? `[${member.kind}] ${member.name} · ${savedItemHint(catalog, member)}` : "Unavailable resource";
    }).join("\n") || "No saved resources.", group.name);
  }
}

/** Resolve all staged conflicts in one name-only catalog save; cancellation writes nothing. */
export async function resolveNameConflicts(libraryDir: string): Promise<void> {
  const before = await loadCatalog(libraryDir);
  assertModernCatalog(before);
  const catalog = structuredClone(before);
  if (findNameConflicts(catalog).length === 0) {
    outro("No name conflicts.");
    return;
  }
  while (true) {
    const conflicts = findNameConflicts(catalog);
    if (conflicts.length === 0) break;
    const options = conflicts.flatMap((conflict) => conflict.ids.map((id) => {
      if (conflict.namespace === "item") {
        const item = catalog.items.find((entry) => entry.id === id)!;
        return { value: `item:${id}`, label: `[${item.kind}] ${item.name}`, hint: savedItemHint(catalog, item) };
      }
      const group = catalog.groups.find((entry) => entry.id === id)!;
      return { value: `group:${id}`, label: `[group] ${group.name}`, hint: `${group.itemIds.length} resources` };
    }));
    const selected = await select({ message: "Select a conflicting name to rename", options });
    if (isCancel(selected)) {
      cancel("Name changes were not saved.");
      return;
    }
    const namespace = selected.startsWith("item:") ? "item" : "group";
    const id = selected.slice(namespace.length + 1);
    const entries = namespace === "item" ? catalog.items : catalog.groups;
    const entry = entries.find((entry) => entry.id === id);
    if (!entry) throw new Error("Selected name is no longer available.");
    const name = await text({
      message: `New name for ${entry.name}`,
      validate: (value) => {
        try {
          assertNameAvailable(catalog, namespace, value ?? "", id);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "Choose a unique non-empty name.";
        }
      },
    });
    if (isCancel(name)) {
      cancel("Name changes were not saved.");
      return;
    }
    entry.name = name.trim();
  }
  const changes: string[] = [];
  for (const namespace of ["item", "group"] as const) {
    const oldEntries = namespace === "item" ? before.items : before.groups;
    const nextEntries = namespace === "item" ? catalog.items : catalog.groups;
    for (const entry of nextEntries) {
      const previous = oldEntries.find((previous) => previous.id === entry.id)!;
      if (previous.name !== entry.name) changes.push(`[${namespace}] ${previous.name} → ${entry.name}`);
    }
  }
  note(changes.join("\n"), "Explicit name changes; saved contents and destinations stay unchanged");
  const save = await confirm({ message: "Save these name changes?", initialValue: false });
  if (isCancel(save) || !save) {
    outro("Name changes were not saved.");
    return;
  }
  assertNoNameConflicts(catalog);
  await saveNameChanges(libraryDir, before, catalog);
  outro("Name conflicts resolved. Run setup or groups again to make other changes.");
}

async function handleNameConflicts(libraryDir: string): Promise<boolean> {
  if (findNameConflicts(await loadCatalog(libraryDir)).length === 0) return false;
  while (true) {
    const catalog = await loadCatalog(libraryDir);
    const conflicts = findNameConflicts(catalog);
    if (conflicts.length === 0) return true;
    const modern = catalog.version === 2;
    note(conflicts.map((conflict) => {
      const entries = conflict.namespace === "item" ? catalog.items : catalog.groups;
      return `[${conflict.namespace}] ${conflict.ids.map((id) => entries.find((entry) => entry.id === id)!.name).join(" / ")}`;
    }).join("\n"), modern ? "Duplicate names: only listing, masked viewing, and resolution are allowed" : "Legacy catalog v1 is read-only; duplicate names are not changed here");
    const action = await select({
      message: "Unresolved names",
      options: [
        { value: "view", label: "View saved resources or groups (masked)" },
        ...(modern ? [{ value: "resolve", label: "Resolve name conflicts" }] : []),
        { value: "done", label: "Finish without changes" },
      ],
    });
    if (isCancel(action) || action === "done") return true;
    if (action === "view") await viewSavedEntry(libraryDir);
    else if (modern) await resolveNameConflicts(libraryDir);
  }
}

function groupOptions(groups: Group[], pendingCounts?: ReadonlyMap<string, number>) {
  return groups.map((group) => ({
    value: group.id,
    label: group.name,
    hint: pendingCounts ? `${group.itemIds.length} saved \u00b7 ${pendingCounts.get(group.id) ?? 0} pending` : `${group.itemIds.length} saved resources`,
  }));
}

async function askForGroupName(message: string, placeholder?: string): Promise<string | undefined> {
  const value = await text({
    message,
    ...(placeholder !== undefined ? { placeholder } : {}),
    validate: (name) => {
      try { nameKey(name ?? ""); return undefined; }
      catch { return "Enter a non-empty group name."; }
    },
  });
  return isCancel(value) ? undefined : value.trim();
}

/**
 * Rename prompt text. The suggestion is prefilled only when it renders unchanged through `safeDisplay`
 * (`initialValue` is echoed raw); otherwise the field stays empty and the masked suggestion is shown in the message.
 */
export function renamePrompt(name: string, sourceDir: string, suggestion: string): { message: string; initialValue?: string } {
  const message = `New display name for ${name} \u2014 ${sourceDir} (display name only; files are not changed)`;
  return safeDisplay(suggestion) === suggestion
    ? { message, initialValue: suggestion }
    : { message: `${message}. Suggestion: ${suggestion}` };
}

/**
 * Resolve display-name conflicts right after selection (#9): within the selection first, one group at a time,
 * then against saved library names. Returns the candidates to review (renamed ones are copies with a new
 * display name only), "back" to re-show the list, or "cancel".
 */
async function resolveSelectedNames(
  selection: readonly ResourceCandidate[],
  library: StoredCatalog,
  labels: ReadonlyMap<string, string>,
  homeDir: string,
): Promise<ResourceCandidate[] | "back" | "cancel"> {
  let pending = [...selection];
  const libraryKeys = new Set(library.items.map((item) => nameKey(item.name)));
  const askNewName = async (candidate: ResourceCandidate, group: readonly ResourceCandidate[] = [candidate]): Promise<string | undefined> => {
    // Taken: every saved name and every other pending name (assertNameAvailable semantics for the library).
    const taken = new Set([...libraryKeys, ...pending.filter((other) => other.id !== candidate.id).map((other) => nameKey(other.name))]);
    const value = await text({
      ...renamePrompt(candidate.name, displayPath(path.dirname(candidate.sourcePath), homeDir), defaultRenameName(candidate, group)),
      validate: (name) => {
        const error = pendingNameError(name, taken);
        if (error) return error;
        try { assertNameAvailable(library, "item", name ?? ""); return undefined; }
        catch { return "That name is already used by a saved or selected resource; choose another."; }
      },
    });
    return isCancel(value) ? undefined : value.trim();
  };
  const rename = (candidate: ResourceCandidate, name: string) => {
    pending = pending.map((entry) => (entry.id === candidate.id ? { ...entry, name } : entry));
  };

  for (const group of findSelectionConflicts(pending)) {
    const choice = await select<string>({
      message: `${group.length} selected resources share the name ${group[0]!.name}; choose what to save`,
      options: [
        ...group.map((candidate) => ({ value: `keep:${candidate.id}`, label: `Keep ${labels.get(candidate.id) ?? candidate.name}` })),
        { value: "rename", label: "Keep all and rename the others" },
        { value: "back", label: "Go back to the list" },
      ],
    });
    if (isCancel(choice)) return "cancel";
    if (choice === "back") return "back";
    if (choice === "rename") {
      for (const candidate of group.slice(1)) {
        const name = await askNewName(pending.find((entry) => entry.id === candidate.id)!, group);
        if (name === undefined) return "cancel";
        rename(candidate, name);
      }
    } else {
      const kept = choice.slice("keep:".length);
      const dropped = new Set(group.filter((candidate) => candidate.id !== kept).map((candidate) => candidate.id));
      pending = pending.filter((candidate) => !dropped.has(candidate.id));
    }
  }

  for (const candidate of [...pending]) {
    if (!libraryKeys.has(nameKey(candidate.name))) continue;
    const choice = await select<"skip" | "rename" | "back">({
      message: `${candidate.name} \u2014 ${displayPath(path.dirname(candidate.sourcePath), homeDir)}: a saved resource already uses this name. To update the saved copy, use Refresh in copi manage.`,
      options: [
        { value: "skip", label: "Skip (keep the saved copy)" },
        { value: "rename", label: "Rename" },
        { value: "back", label: "Go back to the list" },
      ],
    });
    if (isCancel(choice)) return "cancel";
    if (choice === "back") return "back";
    if (choice === "skip") {
      pending = pending.filter((entry) => entry.id !== candidate.id);
      continue;
    }
    const name = await askNewName(candidate);
    if (name === undefined) return "cancel";
    rename(candidate, name);
  }
  return pending;
}

/** Quote for POSIX shells only when needed (single quotes, embedded quotes escaped as '\\''). */
function shellQuote(value: string): string {
  if (value === "<group>" || /^[A-Za-z0-9_.\/@%+=:,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runSetup(libraryDir: string, roots: SearchRoots): Promise<void> {
  if (await handleNameConflicts(libraryDir)) return;
  const initial = await loadCatalog(libraryDir);
  assertModernCatalog(initial);
  assertNoNameConflicts(initial);
  intro("copi setup");
  type LocationChoice = "pi" | "home" | "project" | "both" | "cancel";
  const homeDir = roots.homeDir;
  const projectLabel = displayPath(roots.projectDir, homeDir);
  const homeBase = homeDir.length > 1 && homeDir.endsWith(path.sep) ? homeDir.slice(0, -1) : homeDir;
  const projectIsHome = Boolean(homeDir) && roots.projectDir === homeBase;
  const projectInsideHome = Boolean(homeDir) && !projectIsHome && roots.projectDir.startsWith(homeBase + path.sep);
  const locationOptions: Array<{ value: LocationChoice; label: string }> = [];
  if (homeDir) {
    locationOptions.push({ value: "pi", label: "Pi agent directories only \u2014 ~/.pi/agent, ~/.pi/agent-*, ~/.agents (fast)" });
    locationOptions.push({ value: "home", label: "All of HOME \u2014 ~ (can take a minute or more; worktree copies skipped)" });
  }
  if (!projectIsHome) locationOptions.push({ value: "project", label: `This project only \u2014 ${projectLabel} (fast)` });
  if (homeDir && !projectIsHome && !projectInsideHome) locationOptions.push({ value: "both", label: "Both" });
  locationOptions.push({ value: "cancel", label: "Cancel" });
  const choice = await select<LocationChoice>({
    message: "Choose the locations copi may inspect",
    options: locationOptions,
    initialValue: locationOptions[0]!.value,
  });
  if (isCancel(choice) || choice === "cancel") {
    cancel("Setup cancelled.");
    return;
  }
  const scopes: SearchScopes = { home: choice === "home" || choice === "both", project: choice === "project" || choice === "both", ...(choice === "pi" ? { piDirs: true } : {}) };
  const piDirectories = choice === "pi" ? await piAgentDirectories(homeDir) : [];
  const searchOptions = buildSearchOptions(roots, scopes)!; // every non-cancel choice enables at least one scope
  note(
    [
      `HOME: ${scopes.home ? displayPath(roots.homeDir, homeDir) : "not selected"}`,
      `Pi agent directory: ${scopes.home ? displayPath(roots.agentDir, homeDir) : choice === "pi" ? (piDirectories.map((dir) => displayPath(dir, homeDir)).join(", ") || "none found") : "not selected"}`,
      `Project: ${scopes.project ? projectLabel : "not selected"}`,
      "Always excluded: entire directories named auth (authentication-specific code may be missing), auth.json, mcp-auth.json, oauth.json, .env* paths, history, cache/caches, .cache, .npm, node_modules, and .git. Whole-HOME searches also skip worktree copies (.worktrees, .claude/worktrees, .config/superpowers/worktrees, .treehouse).",
      "Secret detection is heuristic and cannot guarantee completeness. Preview text is masked by default.",
    ].join("\n"),
    "Search scope and exclusions",
  );
  const authorized = await confirm({
    message: "Authorize copi to search only the selected locations now?",
    initialValue: false,
  });
  if (isCancel(authorized) || !authorized) {
    outro("Search not authorized; no resources were inspected or saved.");
    return;
  }

  // A spinner covers the quick phases; once HOME's top-level directories are known, a bar fills one step per directory.
  let indicator: ReturnType<typeof clackSpinner> = clackSpinner(inheritedSignal());
  indicator.start("Searching selected locations (searching all of HOME can take a minute or more)");
  let bar: ReturnType<typeof clackProgress> | undefined;
  let barDone = 0;
  const onProgress = (event: DiscoveryProgress) => {
    if (!bar) {
      if (event.total === 0) return;
      indicator.clear();
      bar = clackProgress({ ...inheritedSignal(), max: event.total });
      indicator = bar;
      bar.start(safeDisplay(formatSearchProgress(event, homeDir)));
      return;
    }
    const step = event.done - barDone;
    barDone = event.done;
    bar.advance(step, safeDisplay(formatSearchProgress(event, homeDir)));
  };
  let discovery: Awaited<ReturnType<typeof discoverResources>>;
  try {
    discovery = await discoverResources(searchOptions, onProgress);
  } catch (error) {
    indicator.error("Search failed");
    throw error;
  }
  indicator.stop(`Search complete: ${discovery.candidates.length} supported resource(s) found`);
  showSearchWarnings(discovery.warnings, roots.homeDir);
  if (discovery.excludedPaths.length > 0) note(discovery.excludedPaths.map((excluded) => displayPath(excluded, homeDir)).join("\n"), "Excluded paths");
  if (discovery.candidates.length === 0) {
    outro("No supported resources were found.");
    return;
  }
  const allSorted = sortCandidates(discovery.candidates);
  const fingerprints = new Map(await Promise.all(allSorted.map(async (candidate) => [candidate.id, await contentFingerprint(candidate)] as const)));
  const { kept: sortedCandidates, copies: identicalCopies } = collapseIdenticalCandidates(allSorted, fingerprints, homeDir);
  const merged = allSorted.length - sortedCandidates.length;
  if (merged > 0) log.info(safeDisplay(`Merged ${merged} identical copies; ${sortedCandidates.length} distinct resource(s) to choose from.`));
  const candidateStats = await gatherCandidateStats(sortedCandidates);
  const savedNames = new Set(initial.items.map((item) => nameKey(item.name)));
  const candidateLabelMap = candidateLabels(sortedCandidates, homeDir, (candidate) => savedNames.has(nameKey(candidate.name)), process.stdout.columns);
  let previousSelection: string[] = [];
  let resolvedCandidates: ResourceCandidate[];
  while (true) {
    const selectedIds = await autocompleteMultiselect({
      message: "Select resources to review and save as copied snapshots",
      options: sortedCandidates.map((candidate) => {
        const label = candidateLabelMap.get(candidate.id)! + identicalCopiesSuffix(identicalCopies.get(candidate.id));
        return { value: candidate.id, label, hint: candidateHint(candidate, candidateStats.get(candidate.id) ?? {}, homeDir, process.stdout.columns, label.length) };
      }),
      required: false,
      initialValues: previousSelection,
      placeholder: "Filter resources...",
    });
    if (isCancel(selectedIds)) {
      cancel("Setup cancelled; no resources were saved.");
      return;
    }
    previousSelection = selectedIds;
    const outcome = await resolveSelectedNames(sortedCandidates.filter((candidate) => selectedIds.includes(candidate.id)), initial, candidateLabelMap, homeDir);
    if (outcome === "cancel") {
      cancel("Setup cancelled; no resources were saved.");
      return;
    }
    if (outcome === "back") continue;
    resolvedCandidates = outcome;
    break;
  }
  if (resolvedCandidates.length === 0) {
    outro("No resources selected; nothing was saved.");
    return;
  }

  const catalog = await loadCatalog(libraryDir);
  assertModernCatalog(catalog);
  if (catalog.groups.length === 0) {
    const name = await askForGroupName("Create the first resource group \u2014 used later with: copi apply <group>", "e.g. game-review");
    if (name === undefined) {
      cancel("Setup cancelled; no resources were saved.");
      return;
    }
    createGroup(catalog, name);
  } else {
    while (true) {
      const add = await confirm({ message: "Create another group before assigning resources?", initialValue: false });
      if (isCancel(add)) {
        cancel("Setup cancelled; no resources were saved.");
        return;
      }
      if (!add) break;
      const name = await askForGroupName("New group name");
      if (name === undefined) {
        cancel("Setup cancelled; no resources were saved.");
        return;
      }
      createGroup(catalog, name);
    }
  }

  // Keep discovery order for review; renamed copies replace their originals by id.
  const resolvedById = new Map(resolvedCandidates.map((candidate) => [candidate.id, candidate]));
  const selectedCandidates = discovery.candidates.flatMap((candidate) => resolvedById.get(candidate.id) ?? []);
  const approvedCandidates: Array<{ review: CandidateReview; groupIds: string[]; approvedSensitivePaths: string[] }> = [];
  // Decide the assignment mode once; "bulk" assigns every approved resource to bulkGroupIds.
  let bulkGroupIds: string[] | undefined;
  const count = selectedCandidates.length;
  const onlyGroup = catalog.groups.length === 1 ? catalog.groups[0]! : undefined;
  let bulk = count === 1;
  if (count >= 2) {
    const mode = await select<"all" | "each">({
      message: "How should these resources be grouped?",
      options: [
        { value: "all", label: onlyGroup ? `Put all ${count} resources in "${onlyGroup.name}"` : `Put all ${count} resources in the same groups` },
        { value: "each", label: "Choose groups for each resource" },
      ],
      initialValue: "all",
    });
    if (isCancel(mode)) {
      cancel("Setup cancelled; no resources were saved.");
      return;
    }
    bulk = mode === "all";
  }
  if (bulk) {
    if (onlyGroup) bulkGroupIds = [onlyGroup.id];
    else {
      const chosen = await autocompleteMultiselect({
        message: count === 1 ? `Assign ${selectedCandidates[0]!.name} to one or more groups` : `Put all ${count} resources in these groups`,
        options: groupOptions(catalog.groups),
        required: true,
        placeholder: "Filter groups...",
      });
      if (isCancel(chosen)) {
        cancel("Setup cancelled; no resources were saved.");
        return;
      }
      bulkGroupIds = chosen;
    }
  }
  for (const [index, candidate] of selectedCandidates.entries()) {
    const review = await prepareCandidateForReview(candidate);
    const previewTitle = `Masked preview (${index + 1}/${count}): ${review.candidate.name} \u2014 ${displayPath(path.dirname(candidate.sourcePath), homeDir)}`;
    note(review.preview.length > 0 ? review.preview.join("\n\n") : "No previewable files.", previewTitle);
    // The heuristic caveat is stated once in the scope note and the summary; per-resource it would only repeat.
    showWarnings(review.inspection.warnings.filter((warning) => warning.code !== "secret-detection-limited"), `${review.candidate.name} inspection warnings`);
    if (review.inspection.excludedPaths.length > 0) {
      note(review.inspection.excludedPaths.join("\n"), `${review.candidate.name} excluded paths`);
    }
    let allSuspectedFilesApproved = true;
    const approvedSensitivePaths: string[] = [];
    for (const relativePath of review.inspection.sensitivePaths) {
      const approval = await confirm({
        message: `Save suspected sensitive file ${relativePath} from ${review.candidate.name}? Detection is heuristic; the file content remains masked in previews. No = ${review.candidate.name} will not be saved at all.`,
        initialValue: false,
      });
      if (isCancel(approval)) {
        cancel("Setup cancelled; nothing was saved.");
        return;
      }
      if (approval) approvedSensitivePaths.push(relativePath);
      else allSuspectedFilesApproved = false;
    }
    if (!allSuspectedFilesApproved) {
      log.warn(safeDisplay(`${review.candidate.name} was not selected for saving because a suspected sensitive file was not approved.`));
      continue;
    }
    if (bulkGroupIds) {
      approvedCandidates.push({ review, groupIds: bulkGroupIds, approvedSensitivePaths });
      continue;
    }
    const pendingCounts = new Map<string, number>();
    for (const approved of approvedCandidates) for (const id of approved.groupIds) pendingCounts.set(id, (pendingCounts.get(id) ?? 0) + 1);
    const groupIds = await autocompleteMultiselect({
      message: `Assign ${review.candidate.name} to one or more groups`,
      options: groupOptions(catalog.groups, pendingCounts),
      required: true,
      placeholder: "Filter groups...",
    });
    if (isCancel(groupIds)) {
      cancel("Setup cancelled; nothing was saved.");
      return;
    }
    approvedCandidates.push({ review, groupIds, approvedSensitivePaths });
  }

  if (approvedCandidates.length === 0) {
    outro("No resources were approved; nothing was saved.");
    return;
  }
  const summary = approvedCandidates.map(({ review, groupIds }) => {
    const names = groupIds.map((id) => catalog.groups.find((group) => group.id === id)?.name ?? "Unavailable group").join(", ");
    return `${review.candidate.name} → ${names}`;
  }).join("\n");
  note(`${summary}\n\nSecret detection is heuristic and cannot guarantee completeness.`, "Resources ready to copy");
  const libraryLabel = displayPath(libraryDir, homeDir);
  const save = await confirm({
    message: `Save ${approvedCandidates.length} copied resource(s) in ${libraryLabel}? Original files will not be changed.`,
    initialValue: false,
  });
  if (isCancel(save) || !save) {
    outro("Nothing was saved.");
    return;
  }

  // Validate the whole batch before saving groups or any snapshot.
  const pending = structuredClone(catalog);
  assertNoNameConflicts(pending);
  const pendingItemNames = new Set(pending.items.map((item) => nameKey(item.name)));
  for (const { review } of approvedCandidates) {
    const candidate = readPreparedResource(review.prepared).candidate;
    assertNameAvailable(pending, "item", candidate.name);
    const candidateName = nameKey(candidate.name);
    if (pendingItemNames.has(candidateName)) throw new Error("Duplicate item name; choose a unique display name.");
    pendingItemNames.add(candidateName);
  }
  await saveCatalog(libraryDir, catalog);
  for (const { review, groupIds, approvedSensitivePaths } of approvedCandidates) {
    await saveReviewedCandidate(libraryDir, review, groupIds, approvedSensitivePaths, true);
  }
  const usedGroupIds = new Set(approvedCandidates.flatMap(({ groupIds }) => groupIds));
  const usedGroups = catalog.groups.filter((group) => usedGroupIds.has(group.id)).map((group) => group.name);
  log.info(safeDisplay(`Saved ${approvedCandidates.length} copied resource(s) in ${libraryLabel} (group: ${usedGroups.join(", ")}).`));
  outro(`Next: copi apply ${shellQuote(usedGroups[0] ?? "<group>")} <project> --dry-run   (edit or rename: copi manage)`);
}

export async function runGroupManager(libraryDir: string): Promise<void> {
  if (await handleNameConflicts(libraryDir)) return;
  const catalog = await loadCatalog(libraryDir);
  assertModernCatalog(catalog);
  if (catalog.groups.length === 0) {
    note("No groups are saved yet.", "Groups");
  } else {
    note(catalog.groups.map((group) => `${group.name} (${group.itemIds.length} resources)`).join("\n"), "Groups");
  }
  const before = JSON.stringify(catalog);
  while (true) {
    const action = await select({
      message: "Manage saved groups",
      options: [
        { value: "create", label: "Create group" },
        ...(catalog.groups.length > 0 ? [
          { value: "rename", label: "Rename group" },
          { value: "assign", label: "Edit group membership" },
        ] : []),
        { value: "done", label: "Finish" },
      ],
    });
    if (isCancel(action)) {
      cancel("Group changes were not saved.");
      return;
    }
    if (action === "done") break;
    assertModernCatalog(catalog);
    if (action === "create") {
      const name = await askForGroupName("New group name");
      if (name === undefined) {
        cancel("Group changes were not saved.");
        return;
      }
      createGroup(catalog, name);
      continue;
    }
    const groupId = await select({ message: "Select group", options: groupOptions(catalog.groups) });
    if (isCancel(groupId)) {
      cancel("Group changes were not saved.");
      return;
    }
    if (action === "rename") {
      const group = catalog.groups.find((entry) => entry.id === groupId);
      if (!group) throw new Error("Selected group is no longer available.");
      const name = await askForGroupName(`New name for ${group.name}`);
      if (name === undefined) {
        cancel("Group changes were not saved.");
        return;
      }
      renameGroup(catalog, groupId, name);
      continue;
    }
    const options = catalog.items.map((item) => ({
      value: item.id,
      label: `[${item.kind}] ${item.name}`,
      hint: `${item.source} · ${item.destination.kind === "global-only" ? "saved only" : item.destination.path}`,
    }));
    const itemIds = await autocompleteMultiselect({
      message: `Select resources in ${catalog.groups.find((group) => group.id === groupId)?.name ?? "group"}`,
      options,
      required: false,
      initialValues: catalog.groups.find((group) => group.id === groupId)?.itemIds ?? [],
      placeholder: "Filter saved resources...",
    });
    if (isCancel(itemIds)) {
      cancel("Group changes were not saved.");
      return;
    }
    setGroupItems(catalog, groupId, itemIds);
  }
  if (JSON.stringify(catalog) === before) {
    outro("No group changes.");
    return;
  }
  const save = await confirm({ message: "Save these group changes to the private copi library?", initialValue: false });
  if (isCancel(save) || !save) {
    outro("Group changes were not saved.");
    return;
  }
  assertModernCatalog(catalog);
  await saveCatalog(libraryDir, catalog);
  outro("Group changes saved.");
}

export function printGroups(catalog: StoredCatalog): void {
  if (catalog.groups.length === 0) {
    process.stdout.write("No saved groups.\n");
    return;
  }
  for (const group of catalog.groups) process.stdout.write(`${safeDisplay(group.name)} — ${group.itemIds.length} resource(s)\n`);
}

export function printItems(items: Array<LegacySavedItem | SavedItem>): void {
  if (items.length === 0) {
    process.stdout.write("No saved snapshots.\n");
    return;
  }
  for (const item of items) {
    process.stdout.write(`${safeDisplay(item.name)} [${item.kind}] — ${item.files.length} file(s), ${safeDisplay(item.destination.kind === "global-only" ? "saved only" : item.destination.path)}\n`);
  }
}

function resolveGroup(catalog: Catalog, value: string): Group {
  const matching = catalog.groups.filter((group) => group.id === value || group.name === value);
  if (matching.length === 0) throw new Error("Unknown group; select a saved group with copi manage.");
  if (matching.length > 1) throw new Error("Group name is ambiguous; resolve name conflicts with copi manage.");
  const group = matching[0];
  if (!group) throw new Error("Selected group is unavailable.");
  return group;
}

function formatPlan(plan: ApplyPlan, catalog: Catalog): string {
  const itemNames = new Map(catalog.items.map((item) => [item.id, item.name]));
  const lines = plan.files.map((file) => {
    const mark = file.alternatives.some((option) => option.sensitive) ? " [suspected secret; approval required]" : "";
    const preview = file.preview.kind === "text" ? `\n${file.preview.diff}` : `\n${file.preview.summary}`;
    const alternatives = file.alternatives.length > 1
      ? `\n  candidates: ${file.alternatives.map((option) => itemNames.get(option.itemId) ?? "Unavailable resource").join(", ")}`
      : "";
    return `${file.status}: ${file.path}${mark}${alternatives}${preview}`;
  });
  const proposal = plan.referenceProposal;
  const reference = proposal
    ? [`reference (optional, approval required during apply): ${proposal.status}: ${proposal.path}${proposal.preview.kind === "text" ? `\n${proposal.preview.diff}` : `\n${proposal.preview.summary}`}`]
    : [];
  const warnings = plan.warnings.map((warning) => `warning${warning.path ? ` ${warning.path}` : ""}: ${warning.message}`);
  const skipped = plan.skippedItems.map((id) => `save-only resource skipped from apply: ${itemNames.get(id) ?? "Unavailable resource"}`);
  return [...lines, ...reference, ...warnings, ...skipped].join("\n\n") || "No project files need changes.";
}

export function formatApplyOptionPreview(filePath: string, resourceName: string, option: ApplyFileOption): string {
  const preview = option.preview.kind === "text" ? option.preview.diff : option.preview.summary;
  return safeDisplay(`${resourceName} → ${filePath}\n${preview}`);
}

export async function runApplyDryRun(libraryDir: string, groupValue: string, projectDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
  assertModernCatalog(catalog);
  const group = resolveGroup(catalog, groupValue);
  const plan = await planApply(libraryDir, group.id, projectDir);
  note(formatPlan(plan, catalog), `Dry run: ${group.name} → ${projectDir}`);
}

export async function runApplyWizard(libraryDir: string, groupValue: string, projectDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
  assertModernCatalog(catalog);
  const group = resolveGroup(catalog, groupValue);
  const plan = await planApply(libraryDir, group.id, projectDir);
  if (plan.files.length === 0) {
    note(formatPlan(plan, catalog), `Apply: ${group.name}`);
    return;
  }
  intro(`copi apply · ${group.name}`);
  note(formatPlan(plan, catalog), "Masked project diff and warnings");
  const collisionDecisions: Record<string, string> = {};
  const existingDecisions: Record<string, "keep" | "replace" | "abort"> = {};
  const decisions: ApplyDecisions = { collisions: collisionDecisions, existing: existingDecisions, secretApprovals: [] };
  const selectedSecrets = new Set<string>();
  for (const file of plan.files) {
    let sensitive = file.sensitive;
    if (file.alternatives.length > 1) {
      const selectedItem = await select({
        message: `Choose one resource for colliding path ${file.path}`,
        options: file.alternatives.map((option) => ({
          value: option.itemId,
          label: catalog.items.find((item) => item.id === option.itemId)?.name ?? "Unavailable resource",
          hint: option.preview.kind === "text" ? "masked text diff available" : option.preview.summary,
        })),
      });
      if (isCancel(selectedItem)) {
        cancel("Apply cancelled; project files were not changed.");
        return;
      }
      const selectedOption = file.alternatives.find((option) => option.itemId === selectedItem);
      if (!selectedOption) throw new Error(`Selected resource is unavailable for ${file.path}.`);
      collisionDecisions[file.path] = selectedItem;
      sensitive = selectedOption.sensitive;
      const selectedName = catalog.items.find((item) => item.id === selectedItem)?.name ?? "Unavailable resource";
      note(formatApplyOptionPreview(file.path, selectedName, selectedOption), "Selected colliding resource preview");
    }
    let hasExistingFile = file.status === "different";
    if (file.status === "collision") {
      try {
        await lstat(path.resolve(plan.projectDir, ...file.path.split("/")));
        hasExistingFile = true;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
    }
    const existingChoice = hasExistingFile
      ? await select<"keep" | "replace" | "abort">({
        message: `Existing file ${file.path}`,
        options: [
          { value: "keep", label: "Keep existing file" },
          { value: "replace", label: "Replace with snapshot and create a private backup" },
          { value: "abort", label: "Abort the whole apply" },
        ],
        initialValue: "abort",
      })
      : undefined;
    if (existingChoice !== undefined) {
      if (isCancel(existingChoice)) {
        cancel("Apply cancelled; project files were not changed.");
        return;
      }
      if (existingChoice === "abort") {
        outro("Apply aborted; project files were not changed.");
        return;
      }
      existingDecisions[file.path] = existingChoice;
    }
    if (sensitive && existingChoice !== "keep" && file.status !== "identical") {
      const approval = await confirm({
        message: `Apply suspected sensitive file ${file.path}? Detection is heuristic; the diff above is masked.`,
        initialValue: false,
      });
      if (isCancel(approval)) {
        cancel("Apply cancelled; project files were not changed.");
        return;
      }
      if (!approval) {
        outro("Apply cancelled because a suspected sensitive file was not approved; project files were not changed.");
        return;
      }
      selectedSecrets.add(file.path);
    }
  }
  decisions.secretApprovals = [...selectedSecrets];
  if (plan.referenceProposal) {
    const proposal = plan.referenceProposal;
    const addReference = await confirm({
      message: `${proposal.status === "new" ? "Create" : "Append to"} ${proposal.path} with a reference line for ${proposal.instructionPaths.join(", ")}? Pi does not load these files automatically.`,
      initialValue: false,
    });
    if (isCancel(addReference)) {
      cancel("Apply cancelled; project files were not changed.");
      return;
    }
    decisions.addReference = addReference;
  }
  const apply = await confirm({ message: `Apply the selected snapshots to ${projectDir}?`, initialValue: false });
  if (isCancel(apply) || !apply) {
    outro("Project files were not changed.");
    return;
  }
  const result = await executeApply(libraryDir, plan, decisions);
  if (result.cancelled) {
    outro("Apply aborted; project files were not changed.");
    return;
  }
  const referenceNote = result.referenceAdded ? ` Added a reference line to ${result.referenceAdded}.` : "";
  outro(`Applied ${result.written.length} file(s); kept ${result.kept.length}; saved ${result.backups.length} private backup(s).${referenceNote}`);
}
