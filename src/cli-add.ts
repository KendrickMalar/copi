import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { assertModernCatalog, importPreparedResource, loadCatalog, prepareResource, saveCatalog } from "./catalog.ts";
import { shouldExclude } from "./discovery.ts";
import { createGroup } from "./groups.ts";
import { resolveRefreshPath } from "./refresh.ts";
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
  status: "added" | "would-add" | "refused" | "error";
  name?: string;
  kind?: ResourceKind;
  reason?: string;
}

const usage = "Usage: copi add <path>... --group <name> [--name <display name>] [--kind skill|subagent|instruction] [--dry-run] [--json]";
const addableKinds = new Set<ResourceKind>(["skill", "subagent", "instruction"]);
const contextFiles = new Set(["AGENTS.md", "AGENTS.MD", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD"]);
/** Lower-cased names that never enter the library without a person: settings and credential files. */
const settingsFiles = new Set(["settings.json", "mcp.json", ".mcp.json", "models.json", "keybindings.json"]);
const credentialFiles = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc", ".pypirc", "credentials", ".git-credentials"]);
const credentialExtensions = [".pem", ".key", ".p12", ".pfx", ".keystore"];
function needsPerson(base: string): boolean {
  const lower = base.toLowerCase();
  return settingsFiles.has(lower) || credentialFiles.has(lower) || credentialExtensions.some((extension) => lower.endsWith(extension));
}

/** First file inside a skill directory that only `copi setup` may take in, or a symlink, which saving refuses. */
async function blockedInside(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (shouldExclude(entry.name)) continue;
    if (entry.isSymbolicLink()) return `${path.basename(child)} is a symbolic link`;
    if (entry.isFile() && needsPerson(entry.name)) return `${entry.name} looks like a settings or credential file`;
    if (entry.isDirectory()) {
      const nested = await blockedInside(child);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function parseAddArgs(args: readonly string[]): AddOptions {
  const paths: string[] = [];
  let group: string | undefined, name: string | undefined, kind: string | undefined;
  let dryRun = false, json = false, optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsEnded) { paths.push(argument); continue; }
    if (argument === "--") { optionsEnded = true; continue; }
    const once = (current: string | undefined) => { if (current !== undefined) throw new Error(`${argument} was given twice. ${usage}`); };
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value. ${usage}`);
      index += 1;
      return next;
    };
    if (argument === "--group") { once(group); group = value(); }
    else if (argument === "--name") { once(name); name = value(); }
    else if (argument === "--kind") { once(kind); kind = value(); }
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--json") json = true;
    else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}. ${usage}`);
    else paths.push(argument);
  }
  if (paths.length === 0 || !group?.trim()) throw new Error(usage);
  if (name !== undefined && !name.trim()) throw new Error(`--name must not be empty. ${usage}`);
  if (name !== undefined && paths.length > 1) throw new Error(`--name can only be used with a single path. ${usage}`);
  if (kind !== undefined && !addableKinds.has(kind as ResourceKind)) throw new Error(`--kind must be skill, subagent or instruction; settings files are registered with copi setup. ${usage}`);
  return { paths, group, ...(name !== undefined ? { name } : {}), ...(kind !== undefined ? { kind: kind as ResourceKind } : {}), dryRun, json };
}

/** Build a candidate for one explicit path, or explain why it cannot be added without a human review. */
export async function candidateForPath(requested: string, kindOverride: ResourceKind | undefined, nameOverride: string | undefined, libraryDir: string): Promise<ResourceCandidate | string> {
  if (!(await lstat(requested).catch(() => undefined))) return "path does not exist";
  let sourcePath: string;
  try { sourcePath = await resolveRefreshPath(requested); } catch { return "symbolic links (in the path or its parent directories) are not followed"; }
  const physicalLibrary = await realpath(libraryDir).catch(() => path.resolve(libraryDir));
  for (const library of new Set([path.resolve(libraryDir), physicalLibrary])) {
    const relativeToLibrary = path.relative(library, sourcePath);
    const inside = relativeToLibrary === "" || (relativeToLibrary !== ".." && !relativeToLibrary.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToLibrary));
    if (inside) return "paths inside the copi library cannot be added";
  }
  if (shouldExclude(sourcePath.slice(path.parse(sourcePath).root.length))) return "this path is in an excluded location (auth, .env*, caches, history, sessions, .git, node_modules)";
  const stat = await lstat(sourcePath);
  const base = path.basename(sourcePath);
  if (needsPerson(base)) return "settings and credential files are registered with copi setup, where a person reviews them";
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
  if (kind === "skill") {
    if (!stat.isDirectory() || !(await lstat(path.join(sourcePath, "SKILL.md")).catch(() => undefined))?.isFile()) return "a skill must be a directory containing a regular SKILL.md";
    const blocked = await blockedInside(sourcePath);
    if (blocked) return `${blocked}; register this skill with copi setup`;
  } else {
    const article = kind === "instruction" ? "an" : "a";
    if (!stat.isFile()) return `${article} ${kind} must be a regular file`;
    if (!base.toLowerCase().endsWith(".md")) return `${article} ${kind} must be a Markdown (.md) file`;
  }
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
    let candidate: ResourceCandidate | string;
    try {
      candidate = await candidateForPath(sourcePath, options.kind, options.name, libraryDir);
    } catch (error) {
      candidate = `cannot be inspected: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (typeof candidate === "string") { outcomes.push({ path: sourcePath, status: "refused", reason: candidate }); continue; }
    const outcome: AddOutcome = { path: sourcePath, status: options.dryRun ? "would-add" : "added", name: candidate.name, kind: candidate.kind };
    try {
      assertNameAvailable(catalog, "item", candidate.name);
      if (pendingNames.has(nameKey(candidate.name))) throw new Error("another path in this command uses the same display name");
    } catch (error) {
      outcomes.push({ ...outcome, status: "refused", reason: `name conflict: ${error instanceof Error ? error.message : String(error)}; pass --name or rename with copi manage` });
      continue;
    }
    let prepared: Awaited<ReturnType<typeof prepareResource>>;
    let inspection: Awaited<ReturnType<typeof inspectPreparedResource>>;
    try {
      prepared = await prepareResource(candidate);
      inspection = await inspectPreparedResource(prepared);
    } catch (error) {
      outcomes.push({ ...outcome, status: "refused", reason: `cannot be read for saving: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
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
    const createdGroup = !group;
    try {
      if (!group) {
        group = createGroup(catalog, options.group);
        await saveCatalog(libraryDir, catalog);
      }
    } catch (error) {
      for (const { outcome } of accepted) Object.assign(outcome, { status: "error", reason: `group could not be saved: ${error instanceof Error ? error.message : String(error)}` });
      return { outcomes, exitCode: 1 };
    }
    let failed = false;
    for (const { outcome, prepared, inspection } of accepted) {
      if (failed) { Object.assign(outcome, { status: "error", reason: "not attempted after an earlier save failed" }); continue; }
      try {
        await importPreparedResource(libraryDir, prepared, { confirmed: true, groupIds: [group.id], inspection, approvedSensitivePaths: [] });
      } catch (error) {
        failed = true;
        Object.assign(outcome, { status: "error", reason: `save failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    // Do not leave behind an empty group that only this failed command created.
    if (failed && createdGroup) {
      try {
        const current = await loadCatalog(libraryDir);
        assertModernCatalog(current);
        const created = current.groups.find((existing) => existing.id === group!.id);
        if (created && created.itemIds.length === 0) {
          current.groups = current.groups.filter((existing) => existing.id !== created.id);
          await saveCatalog(libraryDir, current);
        }
      } catch { /* best effort; the outcome already reports the failure */ }
    }
  }
  return { outcomes, exitCode: outcomes.some((outcome) => outcome.status === "refused" || outcome.status === "error") ? 1 : 0 };
}
