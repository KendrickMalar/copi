import { autocompleteMultiselect, cancel, confirm, intro, isCancel, log, note, outro, select, text } from "@clack/prompts";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { importPreparedResource, loadCatalog, prepareResource, readPreparedResource, saveCatalog, type PreparedFile, type PreparedInspection, type PreparedResource } from "./catalog.ts";
import { discoverResources, type DiscoveryOptions } from "./discovery.ts";
import { createGroup, renameGroup, setGroupItems } from "./groups.ts";
import { inspectPreparedResource, maskSensitiveText } from "./inspect.ts";
import type { ApplyDecisions, ApplyFileOption, ApplyPlan } from "./apply.ts";
import { executeApply, planApply } from "./apply.ts";
import type { Catalog, Group, ResourceCandidate, SavedItem } from "./types.ts";

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
}

export function buildSearchOptions(roots: SearchRoots, scopes: SearchScopes): DiscoveryOptions | undefined {
  if (!scopes.home && !scopes.project) return undefined;
  return {
    ...roots,
    scopes: { home: scopes.home, project: scopes.project },
  };
}

export function formatMaskedPreview(relativePath: string, content: string): string {
  const masked = maskSensitiveText(content);
  const lines = masked.split(/\r?\n/);
  const snippet = lines.slice(0, previewMaxLines).join("\n").slice(0, 2_000);
  const omitted = lines.length > previewMaxLines ? `\n… ${lines.length - previewMaxLines} more lines` : "";
  return `${relativePath}:\n${snippet}${omitted}`;
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

function showWarnings(warnings: readonly { code: string; path?: string; message: string }[], title: string): void {
  if (warnings.length === 0) return;
  note(warnings.map((warning) => `${warning.path ? `${warning.path}: ` : ""}${warning.message}`).join("\n"), title);
}

function groupOptions(groups: Group[]) {
  return groups.map((group) => ({ value: group.id, label: group.name, hint: `${group.itemIds.length} saved resources` }));
}

async function askForGroupName(message: string): Promise<string | undefined> {
  const value = await text({
    message,
    validate: (name) => name === undefined || name.trim().length === 0 ? "Enter a non-empty group name." : undefined,
  });
  return isCancel(value) ? undefined : value.trim();
}

export async function runSetup(libraryDir: string, roots: SearchRoots): Promise<void> {
  intro("copi setup");
  const scopeOptions: Array<{ value: "home" | "project"; label: string; hint: string }> = [];
  if (roots.homeDir) {
    scopeOptions.push({
      value: "home",
      label: `Search entire HOME: ${roots.homeDir}`,
      hint: `Includes supported Pi resources under HOME and Pi agent directory ${roots.agentDir}`,
    });
  }
  scopeOptions.push({ value: "project", label: `Search current project: ${roots.projectDir}`, hint: "Supported Pi resources and instruction files in this project" });
  const selectedScopes = await autocompleteMultiselect({
    message: "Choose the locations copi may inspect",
    options: scopeOptions,
    required: false,
    placeholder: "Search locations...",
  });
  if (isCancel(selectedScopes)) {
    cancel("Setup cancelled.");
    return;
  }
  const scopes: SearchScopes = { home: selectedScopes.includes("home"), project: selectedScopes.includes("project") };
  const searchOptions = buildSearchOptions(roots, scopes);
  if (!searchOptions) {
    outro("No locations selected; nothing was searched or saved.");
    return;
  }
  note(
    [
      `HOME: ${scopes.home ? roots.homeDir : "not selected"}`,
      `Pi agent directory: ${scopes.home ? roots.agentDir : "not selected"}`,
      `Project: ${scopes.project ? roots.projectDir : "not selected"}`,
      "Always excluded: entire directories named auth (authentication-specific code may be missing), auth.json, mcp-auth.json, oauth.json, .env* paths, history, cache/caches, .cache, .npm, node_modules, and .git.",
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

  const discovery = await discoverResources(searchOptions);
  showWarnings(discovery.warnings, "Search warnings");
  if (discovery.excludedPaths.length > 0) note(discovery.excludedPaths.join("\n"), "Excluded paths");
  if (discovery.candidates.length === 0) {
    outro("No supported resources were found.");
    return;
  }
  const selectedIds = await autocompleteMultiselect({
    message: "Select resources to review and save as copied snapshots",
    options: discovery.candidates.map((candidate) => ({
      value: candidate.id,
      label: `[${candidate.kind}] ${candidate.name}`,
      hint: `${candidate.scope} · ${candidate.sourcePath} · ${candidate.destination.kind === "global-only" ? "save only" : candidate.destination.path}`,
    })),
    required: false,
    placeholder: "Filter resources...",
  });
  if (isCancel(selectedIds)) {
    cancel("Setup cancelled; no resources were saved.");
    return;
  }
  if (selectedIds.length === 0) {
    outro("No resources selected; nothing was saved.");
    return;
  }

  const catalog = await loadCatalog(libraryDir);
  if (catalog.groups.length === 0) {
    const name = await askForGroupName("Create the first resource group");
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

  const selectedCandidates = discovery.candidates.filter((candidate) => selectedIds.includes(candidate.id));
  const approvedCandidates: Array<{ review: CandidateReview; groupIds: string[]; approvedSensitivePaths: string[] }> = [];
  for (const candidate of selectedCandidates) {
    const review = await prepareCandidateForReview(candidate);
    note(review.preview.length > 0 ? review.preview.join("\n\n") : "No previewable files.", `Masked preview: ${review.candidate.name}`);
    showWarnings(review.inspection.warnings, `${review.candidate.name} inspection warnings`);
    if (review.inspection.excludedPaths.length > 0) {
      note(review.inspection.excludedPaths.join("\n"), `${review.candidate.name} excluded paths`);
    }
    let allSuspectedFilesApproved = true;
    const approvedSensitivePaths: string[] = [];
    for (const relativePath of review.inspection.sensitivePaths) {
      const approval = await confirm({
        message: `Save suspected sensitive file ${relativePath} from ${review.candidate.name}? Detection is heuristic; the file content remains masked in previews.`,
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
      log.warn(`${review.candidate.name} was not selected for saving because a suspected sensitive file was not approved.`);
      continue;
    }
    const groupIds = await autocompleteMultiselect({
      message: `Assign ${review.candidate.name} to one or more groups`,
      options: groupOptions(catalog.groups),
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
    const names = groupIds.map((id) => catalog.groups.find((group) => group.id === id)?.name ?? id).join(", ");
    return `${review.candidate.name} → ${names}`;
  }).join("\n");
  note(summary, "Resources ready to copy");
  const save = await confirm({
    message: `Save ${approvedCandidates.length} copied resource(s) in ${libraryDir}? Original files will not be changed.`,
    initialValue: false,
  });
  if (isCancel(save) || !save) {
    outro("Nothing was saved.");
    return;
  }

  await saveCatalog(libraryDir, catalog);
  for (const { review, groupIds, approvedSensitivePaths } of approvedCandidates) {
    await saveReviewedCandidate(libraryDir, review, groupIds, approvedSensitivePaths, true);
  }
  outro(`Saved ${approvedCandidates.length} copied resource(s) in ${libraryDir}.`);
}

export async function runGroupManager(libraryDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
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
  await saveCatalog(libraryDir, catalog);
  outro("Group changes saved.");
}

export function printGroups(catalog: Catalog): void {
  if (catalog.groups.length === 0) {
    process.stdout.write("No saved groups.\n");
    return;
  }
  for (const group of catalog.groups) process.stdout.write(`${group.name} (${group.id}) — ${group.itemIds.length} resource(s)\n`);
}

export function printItems(items: SavedItem[]): void {
  if (items.length === 0) {
    process.stdout.write("No saved snapshots.\n");
    return;
  }
  for (const item of items) {
    process.stdout.write(`${item.name} [${item.kind}] (${item.id}) — ${item.files.length} file(s), ${item.destination.kind === "global-only" ? "saved only" : item.destination.path}\n`);
  }
}

function resolveGroup(catalog: Catalog, value: string): Group {
  const matching = catalog.groups.filter((group) => group.id === value || group.name === value);
  if (matching.length === 0) throw new Error(`Unknown group: ${value}`);
  if (matching.length > 1) throw new Error(`Group name is ambiguous: ${value}; use a group ID.`);
  const group = matching[0];
  if (!group) throw new Error(`Unknown group: ${value}`);
  return group;
}

function formatPlan(plan: ApplyPlan, catalog: Catalog): string {
  const itemNames = new Map(catalog.items.map((item) => [item.id, item.name]));
  const lines = plan.files.map((file) => {
    const mark = file.alternatives.some((option) => option.sensitive) ? " [suspected secret; approval required]" : "";
    const preview = file.preview.kind === "text" ? `\n${file.preview.diff}` : `\n${file.preview.summary}`;
    const alternatives = file.alternatives.length > 1
      ? `\n  candidates: ${file.alternatives.map((option) => itemNames.get(option.itemId) ?? option.itemId).join(", ")}`
      : "";
    return `${file.status}: ${file.path}${mark}${alternatives}${preview}`;
  });
  const warnings = plan.warnings.map((warning) => `warning${warning.path ? ` ${warning.path}` : ""}: ${warning.message}`);
  const skipped = plan.skippedItems.map((id) => `save-only resource skipped from apply: ${itemNames.get(id) ?? id}`);
  return [...lines, ...warnings, ...skipped].join("\n\n") || "No project files need changes.";
}

export function formatApplyOptionPreview(filePath: string, resourceName: string, option: ApplyFileOption): string {
  const preview = option.preview.kind === "text" ? option.preview.diff : option.preview.summary;
  return `${resourceName} → ${filePath}\n${preview}`;
}

export async function runApplyDryRun(libraryDir: string, groupValue: string, projectDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
  const group = resolveGroup(catalog, groupValue);
  const plan = await planApply(libraryDir, group.id, projectDir);
  note(formatPlan(plan, catalog), `Dry run: ${group.name} → ${projectDir}`);
}

export async function runApplyWizard(libraryDir: string, groupValue: string, projectDir: string): Promise<void> {
  const catalog = await loadCatalog(libraryDir);
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
          label: catalog.items.find((item) => item.id === option.itemId)?.name ?? option.itemId,
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
      const selectedName = catalog.items.find((item) => item.id === selectedItem)?.name ?? selectedItem;
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
  outro(`Applied ${result.written.length} file(s); kept ${result.kept.length}; saved ${result.backups.length} private backup(s).`);
}
