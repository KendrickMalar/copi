import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryResult, DiscoveryWarning, ResourceCandidate, ResourceDestination, ResourceKind, ResourceScope } from "./types.ts";

export interface DiscoveryScopes {
  home: boolean;
  project: boolean;
}

export interface DiscoveryOptions {
  homeDir: string;
  agentDir: string;
  projectDir: string;
  scopes?: DiscoveryScopes;
}

function inferSearchScopes(options: DiscoveryOptions): DiscoveryScopes {
  const homeDir = path.resolve(options.homeDir);
  const agentDir = path.resolve(options.agentDir);
  const projectDir = path.resolve(options.projectDir);
  if (homeDir === projectDir && agentDir === projectDir) return { home: false, project: true };
  if (homeDir === projectDir) return { home: true, project: false };
  return { home: true, project: true };
}

interface SearchRoot {
  path: string;
  scope: ResourceScope;
  source: string;
  destinationRoot: string;
  destinationKind: ResourceDestination["kind"];
}

interface PackageSelection {
  source: string;
  skills?: string[];
  agents?: string[];
}

const excludedNames = new Set([".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions"]);
const contextFiles = ["AGENTS.md", "AGENTS.MD", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD"];

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function shouldExclude(relativePath: string): boolean {
  return relativePath.split(path.sep).some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === "auth.json" || lower === "mcp-auth.json" || lower === "oauth.json" || lower.startsWith(".env");
  });
}

function displayRelative(root: string, target: string): string {
  return path.relative(root, target) || path.basename(target);
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function packageSelections(value: unknown): PackageSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: PackageSelection[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      selections.push({ source: entry });
      continue;
    }
    const item = record(entry);
    if (item && typeof item.source === "string") {
      selections.push({
        source: item.source,
        ...(Array.isArray(item.skills) ? { skills: strings(item.skills) } : {}),
        ...(Array.isArray(item.agents) ? { agents: strings(item.agents) } : {}),
      });
    }
  }
  return selections;
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${expression}$`);
}

function packagePaths(declared: string[], filters?: string[]): string[] {
  if (!filters) return declared;
  let selected: string[] = [];
  const positive = filters.filter((filter) => !filter.startsWith("!") && !filter.startsWith("-") && !filter.startsWith("+"));
  if (positive.length === 0) selected = [...declared];
  for (const filter of positive) {
    const pattern = globExpression(filter.replace(/^\+/, ""));
    selected.push(...declared.filter((entry) => pattern.test(entry)));
  }
  for (const filter of filters.filter((entry) => entry.startsWith("!") || entry.startsWith("-"))) {
    const pattern = globExpression(filter.slice(1));
    selected = selected.filter((entry) => !pattern.test(entry));
  }
  for (const filter of filters.filter((entry) => entry.startsWith("+"))) {
    const selectedPath = filter.slice(1);
    if (declared.includes(selectedPath)) selected.push(selectedPath);
  }
  return [...new Set(selected)];
}

function addWarning(warnings: DiscoveryWarning[], code: string, target: string, message: string): void {
  if (!warnings.some((warning) => warning.code === code && warning.path === target)) warnings.push({ code, path: target, message });
}

async function canonicalDirectory(directory: string): Promise<string | undefined> {
  try {
    const target = await realpath(directory);
    return (await lstat(target)).isDirectory() ? target : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverResources(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const scopes = options.scopes ?? inferSearchScopes(options);
  if (!scopes.home && !scopes.project) return { candidates: [], warnings: [], excludedPaths: [] };
  const warnings: DiscoveryWarning[] = [];
  const excludedPaths = new Set<string>();
  const candidates: ResourceCandidate[] = [];
  const candidateKeys = new Set<string>();
  const home = scopes.home ? await canonicalDirectory(options.homeDir) : undefined;
  const agent = scopes.home ? await canonicalDirectory(options.agentDir) : undefined;
  const project = scopes.project ? await canonicalDirectory(options.projectDir) : undefined;
  const packageAgentDir = agent ?? (scopes.project ? await canonicalDirectory(options.agentDir) : undefined);
  if (scopes.home && !home) addWarning(warnings, "unavailable-root", options.homeDir, "The explicitly selected home directory is unavailable.");
  if (scopes.home && !agent) addWarning(warnings, "unavailable-root", options.agentDir, "The explicitly selected Pi agent directory is unavailable.");
  if (scopes.project && !project) addWarning(warnings, "unavailable-root", options.projectDir, "The explicitly selected project directory is unavailable.");

  const roots: SearchRoot[] = [];
  if (home) roots.push({ path: home, scope: "shared", source: "shared-agent-skills", destinationRoot: ".pi/skills", destinationKind: "project" });
  if (agent) roots.push({ path: agent, scope: "user", source: "pi-agent-directory", destinationRoot: ".pi/skills", destinationKind: "global-only" });
  if (project) roots.push({ path: project, scope: "project", source: "project", destinationRoot: ".pi/skills", destinationKind: "project" });

  const addCandidate = async (kind: ResourceKind, root: string, sourcePath: string, name: string, scope: ResourceScope, source: string, destination: ResourceDestination): Promise<void> => {
    const canonicalSource = await realpath(sourcePath).catch(() => undefined);
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalSource || !canonicalRoot || !isWithin(canonicalRoot, canonicalSource)) {
      addWarning(warnings, "resource-outside-root", sourcePath, "A configured resource resolves outside its allowed search root and was not included.");
      return;
    }
    const stat = await lstat(canonicalSource).catch(() => undefined);
    if (!stat || (!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) return;
    const relative = displayRelative(canonicalRoot, canonicalSource);
    if (shouldExclude(relative)) {
      excludedPaths.add(canonicalSource);
      return;
    }
    const key = `${kind}\0${canonicalSource}`;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 24),
      kind,
      source,
      scope,
      sourceRoot: canonicalRoot,
      sourcePath: canonicalSource,
      name,
      destination,
    });
  };

  const walk = async (root: string, startPath: string, onFile: (file: string) => Promise<void>): Promise<void> => {
    const canonicalRoot = await canonicalDirectory(root);
    if (!canonicalRoot) return;
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        addWarning(warnings, code === "EACCES" ? "permission-denied" : "scan-error", directory, code === "EACCES" ? "Permission denied while searching this directory." : "Unable to search this directory.");
        return;
      }
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        const relative = path.relative(canonicalRoot, child);
        if (shouldExclude(relative)) {
          excludedPaths.add(child);
          if (relative.split(path.sep).some((part) => part.toLowerCase() === "auth")) {
            addWarning(warnings, "auth-directory-excluded", child, "An auth directory was excluded; copied resources may be missing authentication-specific code.");
          }
          continue;
        }
        if (entry.isSymbolicLink()) {
          const target = await realpath(child).catch(() => undefined);
          addWarning(warnings, target && isWithin(canonicalRoot, target) ? "symlink-skipped" : "external-symlink", child, "Symbolic links are not followed during resource discovery.");
          continue;
        }
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) await onFile(child);
      }
    };
    const canonicalStart = await realpath(startPath).catch(() => undefined);
    if (!canonicalStart || !isWithin(canonicalRoot, canonicalStart)) {
      addWarning(warnings, "resource-outside-root", startPath, "A configured resource root resolves outside its allowed search root.");
      return;
    }
    const startRelative = path.relative(canonicalRoot, canonicalStart);
    if (shouldExclude(startRelative)) {
      excludedPaths.add(canonicalStart);
      if (startRelative.split(path.sep).some((part) => part.toLowerCase() === "auth")) {
        addWarning(warnings, "auth-directory-excluded", canonicalStart, "An auth directory was excluded; copied resources may be missing authentication-specific code.");
      }
      return;
    }
    const stat = await lstat(canonicalStart).catch(() => undefined);
    if (!stat) return;
    if (stat.isFile()) await onFile(canonicalStart);
    else if (stat.isDirectory()) await visit(canonicalStart);
  };

  const addSkillRoot = async (root: string, startPath: string, scope: ResourceScope, source: string, destinationRoot: string): Promise<void> => {
    await walk(root, startPath, async (file) => {
      if (path.basename(file) !== "SKILL.md") return;
      const folder = path.dirname(file);
      await addCandidate("skill", root, folder, path.basename(folder), scope, source, { kind: "project", path: path.posix.join(destinationRoot, path.basename(folder)) });
    });
  };

  const addAgentRoot = async (root: string, startPath: string, scope: ResourceScope, source: string): Promise<void> => {
    await walk(root, startPath, async (file) => {
      const base = path.basename(file);
      const relativeParts = path.relative(root, file).split(path.sep);
      if (base.toLowerCase() === "skill.md" || relativeParts.some((part) => part.toLowerCase() === "skills") || !base.toLowerCase().endsWith(".md") || base.endsWith(".chain.md")) return;
      await addCandidate("subagent", root, file, base, scope, source, { kind: "project", path: path.posix.join(".pi/agents", base) });
    });
  };

  const addSettingCandidate = async (file: string, root: string, scope: ResourceScope, kind: ResourceKind, destination: ResourceDestination): Promise<void> => {
    await addCandidate(kind, root, file, path.basename(file), scope, scope === "project" ? "project-pi-config" : "pi-agent-directory", destination);
  };

  const scanConfiguredResource = async (settingDir: string, allowedRoots: string[], value: string, scope: ResourceScope, kind: "skill" | "subagent", source: string): Promise<void> => {
    const selected = value.replace(/^\+/, "");
    if (selected.startsWith("!") || selected.startsWith("-")) return;
    const resolved = path.resolve(settingDir, selected.replace(/^~/, options.homeDir));
    const allowed = allowedRoots.find((allowedRoot) => isWithin(allowedRoot, resolved));
    if (!allowed) {
      addWarning(warnings, "resource-outside-root", resolved, "A configured resource path is outside the authorized home or project tree.");
      return;
    }
    const destinationRoot = kind === "skill" ? ".pi/skills" : ".pi/agents";
    if (/[*?]/.test(selected)) {
      const pattern = globExpression(path.relative(allowed, resolved).split(path.sep).join("/"));
      await walk(allowed, allowed, async (file) => {
        const relativeFile = path.relative(allowed, file).split(path.sep).join("/");
        const base = path.basename(file);
        if (kind === "skill" && base === "SKILL.md") {
          const resourcePath = path.relative(allowed, path.dirname(file)).split(path.sep).join("/");
          if (!pattern.test(resourcePath) && !pattern.test(relativeFile)) return;
          await addCandidate("skill", allowed, path.dirname(file), path.basename(path.dirname(file)), scope, source, { kind: "project", path: path.posix.join(destinationRoot, path.basename(path.dirname(file))) });
        } else if (kind === "subagent" && base.toLowerCase().endsWith(".md") && base !== "SKILL.md" && !base.endsWith(".chain.md") && pattern.test(relativeFile)) {
          await addCandidate("subagent", allowed, file, base, scope, source, { kind: "project", path: path.posix.join(".pi/agents", base) });
        }
      });
      return;
    }
    if (kind === "skill") {
      await addSkillRoot(allowed, resolved, scope, source, destinationRoot);
    } else {
      await addAgentRoot(allowed, resolved, scope, source);
    }
  };

  const resolveAuthorizedPackageRoot = async (requestedPath: string, authorizedRoots: string[]): Promise<string | undefined> => {
    const packageRoot = await canonicalDirectory(requestedPath);
    if (!packageRoot) return undefined;
    if (!authorizedRoots.some((allowedRoot) => isWithin(allowedRoot, packageRoot))) {
      addWarning(warnings, "resource-outside-root", requestedPath, "A declared Pi package resolves outside the authorized home or project tree.");
      return undefined;
    }
    return packageRoot;
  };

  const packageRootFor = async (selection: PackageSelection, settingsDir: string, allowedRoots: string[], packageAgentDir: string): Promise<string | undefined> => {
    let selected = selection.source;
    if (selected.startsWith("npm:")) {
      const specifier = selected.slice(4);
      const packageName = specifier.startsWith("@")
        ? `${specifier.split("/")[0]}/${specifier.split("/")[1]?.split("@")[0] ?? ""}`
        : specifier.split("@")[0];
      if (!packageName) return undefined;
      return await resolveAuthorizedPackageRoot(path.join(packageAgentDir, "npm", "node_modules", ...packageName.split("/")), allowedRoots);
    }
    if (selected.startsWith("git:")) {
      selected = selected.slice(4).replace(/^https?:\/\//, "");
      selected = selected.replace(/\.git$/, "");
      const at = selected.lastIndexOf("@");
      if (at > selected.lastIndexOf("/")) selected = selected.slice(0, at);
      return await resolveAuthorizedPackageRoot(path.join(packageAgentDir, "git", ...selected.split("/")), allowedRoots);
    }
    if (selected.startsWith("file:")) selected = selected.slice(5);
    const resolved = path.resolve(settingsDir, selected);
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, resolved))) {
      addWarning(warnings, "resource-outside-root", resolved, "A declared local package is outside the authorized home or project tree.");
      return undefined;
    }
    return await resolveAuthorizedPackageRoot(resolved, allowedRoots);
  };

  const manifestResources = async (packageRoot: string, selection: PackageSelection, scope: ResourceScope, source: string, authorizedRoots: string[]): Promise<void> => {
    const canonicalPackageRoot = await canonicalDirectory(packageRoot);
    if (!canonicalPackageRoot || !authorizedRoots.some((allowedRoot) => isWithin(allowedRoot, canonicalPackageRoot))) {
      addWarning(warnings, "resource-outside-root", packageRoot, "The declared Pi package is outside the authorized home or project tree.");
      return;
    }
    const manifestPath = path.join(canonicalPackageRoot, "package.json");
    const canonicalManifest = await realpath(manifestPath).catch(() => undefined);
    if (!canonicalManifest || !authorizedRoots.some((allowedRoot) => isWithin(allowedRoot, canonicalManifest))) {
      addWarning(warnings, "resource-outside-root", manifestPath, "The declared package manifest resolves outside the authorized home or project tree.");
      return;
    }
    let manifest: Record<string, unknown> | undefined;
    try {
      manifest = record(parseJson(await readFile(canonicalManifest, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      addWarning(warnings, code === "ENOENT" ? "missing-package-manifest" : "invalid-package-manifest", manifestPath, "The declared package manifest could not be read.");
      return;
    }
    if (!manifest) {
      addWarning(warnings, "invalid-package-manifest", manifestPath, "The declared package manifest is not a JSON object.");
      return;
    }
    const pi = record(manifest.pi);
    const legacyPi = record(manifest["pi-subagents"]);
    const declaredSkills = strings(pi?.skills);
    const declaredAgents = [
      ...strings(record(pi?.subagents)?.agents),
      ...strings(legacyPi?.agents),
    ];
    const skills = packagePaths(declaredSkills, selection.skills);
    const agents = packagePaths(declaredAgents, selection.agents);
    for (const entry of skills) {
      await scanConfiguredResource(canonicalPackageRoot, [canonicalPackageRoot], entry, scope, "skill", source);
    }
    for (const entry of agents) {
      await scanConfiguredResource(canonicalPackageRoot, [canonicalPackageRoot], entry, scope, "subagent", source);
    }
  };

  const scanPackageSelections = async (value: unknown, settingsPath: string, allowedRoots: string[], packageAgentDir: string): Promise<void> => {
    for (const selection of packageSelections(value)) {
      const packageAuthorizedRoots = selection.source.startsWith("npm:") || selection.source.startsWith("git:")
        ? [...new Set([...allowedRoots, packageAgentDir])]
        : allowedRoots;
      const root = await packageRootFor(selection, path.dirname(settingsPath), packageAuthorizedRoots, packageAgentDir);
      if (!root) {
        addWarning(warnings, "package-unavailable", selection.source, "The declared Pi package is unavailable in the explicitly selected search roots.");
        continue;
      }
      const source = `package:${selection.source}`;
      await manifestResources(root, selection, "package", source, packageAuthorizedRoots);
    }
  };

  if (home) {
    const globalShared = path.join(home, ".agents", "skills");
    await addSkillRoot(home, globalShared, "shared", "shared-agent-skills", ".pi/skills");
  }
  if (agent) {
    for (const [name, kind, destination] of [
      ["settings.json", "pi-settings", { kind: "project", path: ".pi/settings.json" }],
      ["mcp.json", "mcp-config", { kind: "project", path: ".pi/mcp.json" }],
      ["models.json", "model-config", { kind: "global-only" }],
      ["keybindings.json", "keybindings", { kind: "global-only" }],
    ] as const) {
      const file = path.join(agent, name);
      await addSettingCandidate(file, agent, "user", kind, destination);
    }
    await addSkillRoot(agent, path.join(agent, "skills"), "user", "pi-user-skills", ".pi/skills");
    await addAgentRoot(agent, path.join(agent, "agents"), "user", "pi-user-agents");
    for (const name of contextFiles) {
      await addCandidate("instruction", agent, path.join(agent, name), name, "user", "pi-user-instructions", { kind: "project", path: name });
    }
    for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
      await addCandidate("instruction", agent, path.join(agent, name), name, "user", "pi-user-instructions", { kind: "project", path: path.posix.join(".pi", name) });
    }
  }
  if (project) {
    const piDir = path.join(project, ".pi");
    for (const [name, kind, destination] of [
      ["settings.json", "pi-settings", { kind: "project", path: ".pi/settings.json" }],
      ["mcp.json", "mcp-config", { kind: "project", path: ".pi/mcp.json" }],
    ] as const) {
      await addSettingCandidate(path.join(piDir, name), project, "project", kind, destination);
    }
    for (const [name, kind, destination] of [
      ["models.json", "model-config", { kind: "global-only" }],
      ["keybindings.json", "keybindings", { kind: "global-only" }],
    ] as const) {
      await addSettingCandidate(path.join(piDir, name), project, "project", kind, destination);
    }
    await addSkillRoot(project, path.join(piDir, "skills"), "project", "project-pi-skills", ".pi/skills");
    await addSkillRoot(project, path.join(project, ".agents", "skills"), "project", "project-agent-skills", ".pi/skills");
    await addAgentRoot(project, path.join(piDir, "agents"), "project", "project-pi-agents");
    await addAgentRoot(project, path.join(project, ".agents"), "project", "project-agent-definitions");
    for (const name of contextFiles) {
      await addCandidate("instruction", project, path.join(project, name), name, "project", "project-instructions", { kind: "project", path: name });
    }
    for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
      await addCandidate("instruction", project, path.join(piDir, name), name, "project", "project-instructions", { kind: "project", path: path.posix.join(".pi", name) });
    }
    const packageManifest = path.join(project, "package.json");
    if (await lstat(packageManifest).then((stat) => stat.isFile()).catch(() => false)) {
      await manifestResources(project, { source: path.basename(project) }, "project", `package:${path.basename(project)}`, [project]);
    }
  }

  const scanSettings = async (settingsPath: string, scope: ResourceScope, authorized: string[], packageAgentDir: string): Promise<void> => {
    const settingsStat = await lstat(settingsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") addWarning(warnings, error.code === "EACCES" ? "permission-denied" : "settings-unavailable", settingsPath, "Unable to access Pi settings.");
      return undefined;
    });
    if (!settingsStat) return;
    const canonicalSettingsPath = await realpath(settingsPath).catch(() => undefined);
    if (!canonicalSettingsPath || !authorized.some((allowedRoot) => isWithin(allowedRoot, canonicalSettingsPath))) {
      addWarning(warnings, "resource-outside-root", settingsPath, "Settings resolve outside the authorized home or project tree and were not read.");
      return;
    }
    let settings: Record<string, unknown>;
    try {
      const parsed = parseJson(await readFile(canonicalSettingsPath, "utf8"));
      if (!parsed) {
        addWarning(warnings, "invalid-settings", settingsPath, "Settings are not valid readable JSON; configured resources were not expanded.");
        return;
      }
      settings = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") addWarning(warnings, code === "EACCES" ? "permission-denied" : "invalid-settings", settingsPath, "Settings are not valid readable JSON; configured resources were not expanded.");
      return;
    }
    const settingDir = path.dirname(settingsPath);
    for (const entry of strings(settings.skills)) await scanConfiguredResource(settingDir, authorized, entry, scope, "skill", "settings-resource");
    const subagents = record(settings.subagents);
    for (const entry of strings(subagents?.agentScanDirs)) await scanConfiguredResource(settingDir, authorized, entry, scope, "subagent", "settings-agent-scan-root");
    await scanPackageSelections(settings.packages, settingsPath, authorized, packageAgentDir);
  };

  const homeProjects = new Set<string>();
  const homeProfiles = new Set<string>();
  if (home) {
    await walk(home, home, async (file) => {
      const relativeParts = path.relative(home, file).split(path.sep);
      const base = path.basename(file);
      const piIndex = relativeParts.indexOf(".pi");
      const profileName = piIndex >= 0 ? relativeParts[piIndex + 1] : undefined;
      if (piIndex >= 0 && profileName && (profileName === "agent" || profileName.startsWith("agent-") || profileName.startsWith("agent_"))) {
        const profileRoot = path.join(home, ...relativeParts.slice(0, piIndex + 2));
        const profilePath = relativeParts.slice(piIndex + 2);
        homeProfiles.add(profileRoot);
        if (profilePath.length === 1) {
          const config = new Map<string, [ResourceKind, ResourceDestination]>([
            ["settings.json", ["pi-settings", { kind: "project", path: ".pi/settings.json" }]],
            ["mcp.json", ["mcp-config", { kind: "project", path: ".pi/mcp.json" }]],
            ["models.json", ["model-config", { kind: "global-only" }]],
            ["keybindings.json", ["keybindings", { kind: "global-only" }]],
          ]);
          const resource = config.get(base);
          if (resource) await addSettingCandidate(file, home, "user", resource[0], resource[1]);
          if (contextFiles.includes(base)) await addCandidate("instruction", home, file, base, "user", "pi-user-instructions", { kind: "project", path: base });
          if (base === "SYSTEM.md" || base === "APPEND_SYSTEM.md") await addCandidate("instruction", home, file, base, "user", "pi-user-instructions", { kind: "project", path: path.posix.join(".pi", base) });
        } else if (profilePath[0] === "skills" && base === "SKILL.md") {
          const skillPath = path.dirname(file);
          await addCandidate("skill", home, skillPath, path.basename(skillPath), "user", "pi-user-skills", { kind: "project", path: path.posix.join(".pi/skills", path.basename(skillPath)) });
        } else if (profilePath[0] === "agents" && base.toLowerCase().endsWith(".md") && !base.endsWith(".chain.md")) {
          await addCandidate("subagent", home, file, base, "user", "pi-user-agents", { kind: "project", path: path.posix.join(".pi/agents", base) });
        }
        return;
      }
      if (piIndex >= 0) {
        const projectRoot = path.join(home, ...relativeParts.slice(0, piIndex));
        homeProjects.add(projectRoot);
        const piPath = relativeParts.slice(piIndex + 1);
        if (piPath[0] === "skills" && base === "SKILL.md") {
          const skillPath = path.dirname(file);
          await addCandidate("skill", home, skillPath, path.basename(skillPath), "project", "project-pi-skills", { kind: "project", path: path.posix.join(".pi/skills", path.basename(skillPath)) });
        } else if (piPath[0] === "agents" && base.toLowerCase().endsWith(".md") && !base.endsWith(".chain.md")) {
          await addCandidate("subagent", home, file, base, "project", "project-pi-agents", { kind: "project", path: path.posix.join(".pi/agents", base) });
        } else if (piPath.length === 1) {
          const config = new Map<string, [ResourceKind, ResourceDestination]>([
            ["settings.json", ["pi-settings", { kind: "project", path: ".pi/settings.json" }]],
            ["mcp.json", ["mcp-config", { kind: "project", path: ".pi/mcp.json" }]],
            ["models.json", ["model-config", { kind: "global-only" }]],
            ["keybindings.json", ["keybindings", { kind: "global-only" }]],
          ]);
          const resource = config.get(base);
          if (resource) await addSettingCandidate(file, home, "project", resource[0], resource[1]);
          if (base === "SYSTEM.md" || base === "APPEND_SYSTEM.md") await addCandidate("instruction", home, file, base, "project", "project-instructions", { kind: "project", path: path.posix.join(".pi", base) });
        }
      }
      const agentsIndex = relativeParts.indexOf(".agents");
      if (agentsIndex >= 0) {
        const agentsPath = relativeParts.slice(agentsIndex + 1);
        const projectRoot = path.join(home, ...relativeParts.slice(0, agentsIndex));
        if (projectRoot !== home) homeProjects.add(projectRoot);
        if (agentsPath[0] === "skills" && base === "SKILL.md") {
          const skillPath = path.dirname(file);
          const scope: ResourceScope = agentsIndex === 0 ? "shared" : "project";
          await addCandidate("skill", home, skillPath, path.basename(skillPath), scope, scope === "shared" ? "shared-agent-skills" : "project-agent-skills", { kind: "project", path: path.posix.join(".pi/skills", path.basename(skillPath)) });
        } else if (base.toLowerCase().endsWith(".md") && base !== "SKILL.md" && !base.endsWith(".chain.md") && !agentsPath.includes("skills")) {
          await addCandidate("subagent", home, file, base, "project", "project-agent-definitions", { kind: "project", path: path.posix.join(".pi/agents", base) });
        }
      }
      if (contextFiles.includes(base)) {
        const projectRoot = path.dirname(file);
        if (projectRoot !== home && !isWithin(path.join(home, ".pi"), projectRoot)) homeProjects.add(projectRoot);
        await addCandidate("instruction", home, file, base, "project", "project-instructions", { kind: "project", path: base });
      }
    });
    for (const profileRoot of homeProfiles) {
      await scanSettings(path.join(profileRoot, "settings.json"), "user", [profileRoot, home], profileRoot);
    }
    for (const projectRoot of homeProjects) {
      await scanSettings(path.join(projectRoot, ".pi", "settings.json"), "project", [projectRoot], packageAgentDir ?? projectRoot);
      const manifestPath = path.join(projectRoot, "package.json");
      if (await lstat(manifestPath).then((stat) => stat.isFile()).catch(() => false)) {
        await manifestResources(projectRoot, { source: path.basename(projectRoot) }, "project", `package:${path.basename(projectRoot)}`, [projectRoot]);
      }
    }
  }

  if (agent) {
    await scanSettings(path.join(agent, "settings.json"), "user", [agent, ...(home ? [home] : [])], agent);
  }
  if (project) {
    await scanSettings(path.join(project, ".pi", "settings.json"), "project", [project], packageAgentDir ?? project);
  }

  candidates.sort((left, right) => left.name.localeCompare(right.name) || left.sourcePath.localeCompare(right.sourcePath));
  return { candidates, warnings, excludedPaths: [...excludedPaths].sort() };
}
