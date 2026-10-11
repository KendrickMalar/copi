import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, importPreparedResource, loadCatalog, prepareResource, saveCatalog } from "./catalog.ts";
import { shouldExclude } from "./discovery.ts";
import { createGroup } from "./groups.ts";
import { inspectPreparedResource } from "./inspect.ts";
import { assertNameAvailable, assertNoNameConflicts, nameKey } from "./names.ts";
import type { ResourceCandidate, ResourceKind } from "./types.ts";

export interface AddOptions {
  paths: string[];
  group: string;
  name?: string;
  kind?: ResourceKind;
  dryRun: boolean;
  json: boolean;
}

export interface AddOutcome {
  path: string;
  status: "added" | "would-add" | "refused";
  name?: string;
  kind?: ResourceKind;
  reason?: string;
}

const usage = "Usage: copi add <path>... --group <name> [--name <display name>] [--kind skill|subagent|instruction] [--dry-run] [--json]";
const addableKinds = new Set<ResourceKind>(["skill", "subagent", "instruction"]);
const contextFiles = new Set(["AGENTS.md", "AGENTS.MD", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD"]);
const settingsFiles = new Set(["settings.json", "mcp.json", "models.json", "keybindings.json"]);

export function parseAddArgs(args: readonly string[]): AddOptions {
  const paths: string[] = [];
  let group: string | undefined, name: string | undefined, kind: string | undefined;
  let dryRun = false, json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value. ${usage}`);
      index += 1;
      return next;
    };
    if (argument === "--group") group = value();
    else if (argument === "--name") name = value();
    else if (argument === "--kind") kind = value();
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--json") json = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}. ${usage}`);
    else paths.push(argument);
  }
  if (paths.length === 0 || !group?.trim()) throw new Error(usage);
  if (name !== undefined && paths.length > 1) throw new Error(`--name can only be used with a single path. ${usage}`);
  if (kind !== undefined && !addableKinds.has(kind as ResourceKind)) throw new Error(`--kind must be skill, subagent or instruction; settings files are registered with copi setup. ${usage}`);
  return { paths, group, ...(name !== undefined ? { name } : {}), ...(kind !== undefined ? { kind: kind as ResourceKind } : {}), dryRun, json };
}

/** Build a candidate for one explicit path, or explain why it cannot be added without a human review. */
export async function candidateForPath(sourcePath: string, kindOverride: ResourceKind | undefined, nameOverride: string | undefined): Promise<ResourceCandidate | string> {
  const stat = await lstat(sourcePath).catch(() => undefined);
  if (!stat) return "path does not exist";
  if (stat.isSymbolicLink()) return "symbolic links are not added";
  const base = path.basename(sourcePath);
  if (shouldExclude(base)) return "this path is always excluded (auth, .env*, caches, history, .git, node_modules)";
  if (stat.isFile() && settingsFiles.has(base)) return "settings files are registered with copi setup, where a person reviews them";
  let kind: ResourceKind | undefined = kindOverride;
  if (!kind) {
    if (stat.isDirectory()) {
      const skill = await lstat(path.join(sourcePath, "SKILL.md")).catch(() => undefined);
      if (skill?.isFile()) kind = "skill";
    } else if (stat.isFile()) {
      if (contextFiles.has(base) || base === "SYSTEM.md" || base === "APPEND_SYSTEM.md") kind = "instruction";
      else if (base.toLowerCase().endsWith(".md") && path.basename(path.dirname(sourcePath)) === "agents") kind = "subagent";
    }
  }
  if (!kind) return "cannot tell the kind; pass --kind skill|subagent|instruction";
  if (kind === "skill" && !stat.isDirectory()) return "a skill must be a directory containing SKILL.md";
  if (kind !== "skill" && !stat.isFile()) return `a ${kind} must be a regular file`;
  const name = (nameOverride ?? base).trim();
  const destinationPath = kind === "skill" ? path.posix.join(".pi/skills", base)
    : kind === "subagent" ? path.posix.join(".pi/agents", base)
      : base === "SYSTEM.md" || base === "APPEND_SYSTEM.md" ? path.posix.join(".pi", base) : base;
  return {
    id: createHash("sha256").update(`${kind}\0${sourcePath}`).digest("hex").slice(0, 24),
    kind,
    source: "cli-add",
    scope: "project",
    sourceRoot: path.dirname(sourcePath),
    sourcePath,
    name,
    destination: { kind: "project", path: destinationPath },
  };
}

/**
 * Non-interactive add for scripts and AI agents: saves explicit paths whose inspection finds nothing suspected
 * sensitive; anything else is refused and left for a person to review with `copi setup`.
 */
export async function runAdd(libraryDir: string, cwd: string, options: AddOptions): Promise<{ outcomes: AddOutcome[]; exitCode: number }> {
  const catalog = await loadCatalog(libraryDir);
  assertModernCatalog(catalog);
  assertNoNameConflicts(catalog);
  const outcomes: AddOutcome[] = [];
  const accepted: Array<{ outcome: AddOutcome; prepared: Awaited<ReturnType<typeof prepareResource>>; inspection: Awaited<ReturnType<typeof inspectPreparedResource>> }> = [];
  const pendingNames = new Set<string>();
  for (const raw of options.paths) {
    const sourcePath = path.resolve(cwd, raw);
    const candidate = await candidateForPath(sourcePath, options.kind, options.name);
    if (typeof candidate === "string") { outcomes.push({ path: sourcePath, status: "refused", reason: candidate }); continue; }
    const outcome: AddOutcome = { path: sourcePath, status: options.dryRun ? "would-add" : "added", name: candidate.name, kind: candidate.kind };
    try {
      assertNameAvailable(catalog, "item", candidate.name);
      if (pendingNames.has(nameKey(candidate.name))) throw new Error("another path in this command uses the same display name");
    } catch (error) {
      outcomes.push({ ...outcome, status: "refused", reason: `name conflict: ${error instanceof Error ? error.message : String(error)}; pass --name or rename with copi manage` });
      continue;
    }
    const prepared = await prepareResource(candidate);
    const inspection = await inspectPreparedResource(prepared);
    if (inspection.sensitivePaths.length > 0) {
      outcomes.push({ ...outcome, status: "refused", reason: `suspected sensitive content in ${inspection.sensitivePaths.join(", ")}; review it with copi setup` });
      continue;
    }
    pendingNames.add(nameKey(candidate.name));
    accepted.push({ outcome, prepared, inspection });
    outcomes.push(outcome);
  }
  if (!options.dryRun && accepted.length > 0) {
    let group = catalog.groups.find((existing) => nameKey(existing.name) === nameKey(options.group));
    if (!group) {
      group = createGroup(catalog, options.group);
      await saveCatalog(libraryDir, catalog);
    }
    for (const { prepared, inspection } of accepted) {
      await importPreparedResource(libraryDir, prepared, { confirmed: true, groupIds: [group.id], inspection, approvedSensitivePaths: [] });
    }
  }
  return { outcomes, exitCode: outcomes.some((outcome) => outcome.status === "refused") ? 1 : 0 };
}
