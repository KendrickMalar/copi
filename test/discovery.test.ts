import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverResources } from "../src/discovery.ts";

async function put(root: string, relative: string, value: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

test("discovers Pi and shared/project skill bundles and declared package resources without traversing excluded trees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  await Promise.all([mkdir(homeDir), mkdir(agentDir), mkdir(projectDir)]);

  await put(homeDir, ".agents/skills/shared/SKILL.md", "shared guidance");
  await put(agentDir, "skills/portable/SKILL.md", "portable guidance");
  await put(agentDir, "skills/portable/scripts/run.mjs", "export default 1;");
  await put(agentDir, "skills/portable/auth/private.ts", "export const authenticationHelper = true;");
  await put(agentDir, "skills/portable/.env", "TOKEN=do-not-copy");
  await put(agentDir, "skills/portable/.envrc", "ENVRC_READ_SENTINEL");
  await put(agentDir, "skills/portable/.env-production", "ENV_PRODUCTION_READ_SENTINEL");
  await put(agentDir, "skills/portable/env_helper.py", "support code");
  await put(agentDir, "agents/scout.md", "---\nname: scout\n---\nScout instructions");
  await put(agentDir, "shared-skills/custom/SKILL.md", "configured shared guidance");
  await put(agentDir, "settings.json", JSON.stringify({
    skills: ["./shared-skills"],
    packages: [{ source: "./declared-package" }, "npm:@sample/pi-resource@1.0.0"],
  }));
  await put(agentDir, "declared-package/package.json", JSON.stringify({
    name: "declared-package",
    pi: { skills: ["resources/skills"] },
  }));
  await put(agentDir, "declared-package/resources/skills/package-skill/SKILL.md", "package skill");
  await put(agentDir, "npm/node_modules/@sample/pi-resource/package.json", JSON.stringify({
    name: "@sample/pi-resource",
    pi: { skills: ["skills/*"] },
  }));
  await put(agentDir, "npm/node_modules/@sample/pi-resource/skills/npm-skill/SKILL.md", "installed package skill");

  await put(projectDir, "AGENTS.md", "project instructions");
  await put(projectDir, ".agents/skills/project-skill/SKILL.md", "project skill");
  await put(projectDir, ".agents/skills/project-skill/assets/data.bin", "supporting file");
  await put(projectDir, ".pi/settings.json", JSON.stringify({
    skills: ["../extra-skills"],
    packages: [{ source: "../project-package" }],
  }));
  await put(projectDir, "extra-skills/extra/SKILL.md", "configured project skill");
  await put(projectDir, "project-package/package.json", JSON.stringify({
    name: "project-package",
    pi: { skills: ["skills"] },
  }));
  await put(projectDir, "project-package/skills/declarative/SKILL.md", "declared project skill");
  await put(agentDir, "skills/portable/node_modules/embedded/SKILL.md", "do not include dependencies");
  await put(projectDir, "node_modules/not-a-candidate/SKILL.md", "do not scan dependencies");
  await put(projectDir, ".pi/auth.json", "credential data");
  await put(agentDir, "mcp.json", JSON.stringify({ mcpServers: {} }));
  await put(agentDir, "models.json", JSON.stringify({ providers: {} }));
  await put(agentDir, "keybindings.json", JSON.stringify({}));
  await put(projectDir, ".pi/mcp.json", JSON.stringify({ mcpServers: {} }));
  await put(agentDir, "SYSTEM.md", "user system prompt");
  await put(agentDir, "APPEND_SYSTEM.md", "user appended system prompt");
  await put(projectDir, ".pi/SYSTEM.md", "project system prompt");
  await put(projectDir, ".pi/APPEND_SYSTEM.md", "project appended system prompt");

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  for (const name of ["shared", "portable", "scout.md", "custom", "package-skill", "AGENTS.md", "project-skill", "extra", "declarative"]) {
    assert.ok(names.has(name), `expected discovered resource ${name}`);
  }
  assert.ok(!names.has("not-a-candidate"));
  assert.ok(!result.candidates.some((candidate) => candidate.sourcePath.includes("auth.json")));
  assert.ok(result.excludedPaths.some((entry) => entry.endsWith(".env")));
  assert.ok(result.excludedPaths.some((entry) => entry.endsWith(".envrc")));
  assert.ok(result.excludedPaths.some((entry) => entry.endsWith(".env-production")));
  assert.ok(!result.excludedPaths.some((entry) => entry.endsWith("env_helper.py")));
  assert.ok(result.excludedPaths.some((entry) => entry.endsWith(path.join("auth"))));
  assert.ok(result.warnings.some((warning) => warning.code === "auth-directory-excluded"));
  assert.ok(result.excludedPaths.some((entry) => entry.includes("node_modules")));
  assert.ok(result.candidates.some((candidate) => candidate.destination.kind === "project" && candidate.destination.path === ".pi/skills/portable"));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "pi-settings" && candidate.destination.kind === "project" && candidate.destination.path === ".pi/settings.json"));
  assert.ok(names.has("npm-skill"));
  assert.ok(!result.candidates.some((candidate) => candidate.kind === "subagent" && candidate.sourcePath.endsWith(path.join(".agents", "skills", "project-skill", "SKILL.md"))));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "mcp-config" && candidate.scope === "user" && candidate.destination.kind === "project" && candidate.destination.path === ".pi/mcp.json"));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "mcp-config" && candidate.scope === "project" && candidate.destination.kind === "project" && candidate.destination.path === ".pi/mcp.json"));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "model-config" && candidate.destination.kind === "global-only"));
  assert.ok(result.candidates.some((candidate) => candidate.kind === "keybindings" && candidate.destination.kind === "global-only"));
  assert.ok(result.candidates.some((candidate) => candidate.sourcePath.endsWith(path.join("agent", "SYSTEM.md")) && candidate.destination.kind === "project" && candidate.destination.path === ".pi/SYSTEM.md"));
  assert.ok(result.candidates.some((candidate) => candidate.sourcePath.endsWith(path.join("project", ".pi", "APPEND_SYSTEM.md")) && candidate.destination.kind === "project" && candidate.destination.path === ".pi/APPEND_SYSTEM.md"));
});

test("reports out-of-root symlinks instead of following them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-discovery-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(homeDir), mkdir(agentDir), mkdir(projectDir), mkdir(outside)]);
  await put(outside, "SKILL.md", "outside material");
  await mkdir(path.join(agentDir, "skills"), { recursive: true });
  await symlink(outside, path.join(agentDir, "skills", "escape"));

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  assert.ok(result.warnings.some((warning) => warning.code === "external-symlink"));
  assert.ok(!result.candidates.some((candidate) => candidate.sourcePath === outside));
  assert.equal(await readFile(path.join(outside, "SKILL.md"), "utf8"), "outside material");
});

test("searches the approved synthetic home for other Pi projects and profiles while preserving exclusions and destinations", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "copi-home-discovery-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const projectDir = path.join(homeDir, "current");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const otherProject = path.join(homeDir, "Code", "other");
  const otherProfile = path.join(homeDir, ".pi", "agent-alt");
  await Promise.all([mkdir(projectDir, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  await put(otherProject, ".pi/skills/nested-project-skill/SKILL.md", "nested project resource");
  await put(otherProject, ".pi/settings.json", JSON.stringify({}));
  await put(otherProject, ".pi/mcp.json", JSON.stringify({ mcpServers: {} }));
  await put(otherProject, "AGENTS.override.md", "project override instructions");
  await put(otherProject, "CLAUDE.md", "project context");
  await put(otherProject, ".pi/SYSTEM.md", "project system prompt");
  await put(otherProject, ".pi/APPEND_SYSTEM.md", "project appended prompt");
  await put(otherProject, ".pi/auth.json", "never include credentials");
  await put(otherProject, ".pi/cache/hidden/SKILL.md", "cached material");
  await put(otherProject, ".cache/hidden/SKILL.md", "cache material");
  await put(otherProject, ".git/hidden/SKILL.md", "repository internals");
  await put(otherProject, "node_modules/hidden/SKILL.md", "dependency internals");

  await put(otherProfile, "skills/alternate-profile-skill/SKILL.md", "profile-specific resource");
  await put(otherProfile, "settings.json", JSON.stringify({}));
  await put(otherProfile, "mcp.json", JSON.stringify({ mcpServers: {} }));
  await put(agentDir, "settings.json", JSON.stringify({}));
  await put(agentDir, "mcp.json", JSON.stringify({ mcpServers: {} }));
  await put(agentDir, "models.json", JSON.stringify({ providers: {} }));
  await put(agentDir, "keybindings.json", JSON.stringify({}));

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  const nestedSkill = result.candidates.find((candidate) => candidate.name === "nested-project-skill");
  const profileSkill = result.candidates.find((candidate) => candidate.name === "alternate-profile-skill");
  assert.ok(nestedSkill, "expected a skill from another project under the approved home");
  assert.equal(nestedSkill.scope, "project");
  assert.deepEqual(nestedSkill.destination, { kind: "project", path: ".pi/skills/nested-project-skill" });
  assert.ok(profileSkill, "expected a skill from a second Pi profile");
  assert.equal(profileSkill.scope, "user");
  assert.ok(result.excludedPaths.some((entry) => entry.includes(".pi") && entry.endsWith("auth.json")));
  assert.ok(result.excludedPaths.some((entry) => entry.includes(".pi/cache")));
  assert.ok(result.excludedPaths.some((entry) => entry.includes(".cache")));
  assert.ok(!result.candidates.some((candidate) => candidate.sourcePath.includes("hidden")));

  const setting = result.candidates.find((candidate) => candidate.kind === "pi-settings" && candidate.sourcePath.endsWith(path.join(".pi", "agent", "settings.json")));
  const mcp = result.candidates.find((candidate) => candidate.kind === "mcp-config" && candidate.scope === "user");
  assert.deepEqual(setting?.destination, { kind: "project", path: ".pi/settings.json" });
  assert.deepEqual(mcp?.destination, { kind: "project", path: ".pi/mcp.json" });
  assert.ok(result.candidates.some((candidate) => candidate.name === "models.json" && candidate.destination.kind === "global-only"));
  assert.ok(result.candidates.some((candidate) => candidate.name === "keybindings.json" && candidate.destination.kind === "global-only"));

  const override = result.candidates.find((candidate) => candidate.name === "AGENTS.override.md");
  const claude = result.candidates.find((candidate) => candidate.name === "CLAUDE.md");
  const system = result.candidates.find((candidate) => candidate.name === "SYSTEM.md");
  const appended = result.candidates.find((candidate) => candidate.name === "APPEND_SYSTEM.md");
  assert.deepEqual(override?.destination, { kind: "project", path: "AGENTS.override.md" });
  assert.deepEqual(claude?.destination, { kind: "project", path: "CLAUDE.md" });
  assert.deepEqual(system?.destination, { kind: "project", path: ".pi/SYSTEM.md" });
  assert.deepEqual(appended?.destination, { kind: "project", path: ".pi/APPEND_SYSTEM.md" });
});

test("rejects package and package-manifest symlinks that resolve outside authorized roots while retaining in-root links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-package-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(homeDir, "project");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(outside)]);

  const manifest = (name: string): string => JSON.stringify({ name, pi: { skills: ["skills"] } });
  await put(outside, "local/package.json", manifest("outside-local"));
  await put(outside, "local/skills/outside-local-skill/SKILL.md", "outside local");
  await put(outside, "npm/package.json", manifest("outside-npm"));
  await put(outside, "npm/skills/outside-npm-skill/SKILL.md", "outside npm");
  await put(outside, "git/package.json", manifest("outside-git"));
  await put(outside, "git/skills/outside-git-skill/SKILL.md", "outside git");
  await put(outside, "linked-manifest.json", manifest("outside-manifest"));

  await put(agentDir, "inside-target/package.json", manifest("inside-target"));
  await put(agentDir, "inside-target/skills/inside-link-skill/SKILL.md", "in-root linked package");
  await mkdir(path.join(agentDir, "npm", "node_modules", "@sample"), { recursive: true });
  await mkdir(path.join(agentDir, "git", "github.com", "sample"), { recursive: true });
  await symlink(path.join(outside, "local"), path.join(agentDir, "linked-local"), "dir");
  await symlink(path.join(outside, "npm"), path.join(agentDir, "npm", "node_modules", "@sample", "pkg"), "dir");
  await symlink(path.join(outside, "git"), path.join(agentDir, "git", "github.com", "sample", "pkg"), "dir");
  await symlink(path.join(agentDir, "inside-target"), path.join(agentDir, "linked-inside"), "dir");
  await mkdir(path.join(agentDir, "manifest-link", "skills", "manifest-link-skill"), { recursive: true });
  await writeFile(path.join(agentDir, "manifest-link", "skills", "manifest-link-skill", "SKILL.md"), "internal file declared only by external manifest");
  await symlink(path.join(outside, "linked-manifest.json"), path.join(agentDir, "manifest-link", "package.json"));
  await put(agentDir, "git/github.com/sample/inside/package.json", manifest("inside-git"));
  await put(agentDir, "git/github.com/sample/inside/skills/inside-git-skill/SKILL.md", "in-root git package");
  await put(agentDir, "settings.json", JSON.stringify({
    packages: [
      "./linked-local",
      "npm:@sample/pkg@1.0.0",
      "git:github.com/sample/pkg",
      "./linked-inside",
      "./manifest-link",
      "git:github.com/sample/inside",
    ],
  }));

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  assert.ok(!names.has("outside-local-skill"));
  assert.ok(!names.has("outside-npm-skill"));
  assert.ok(!names.has("outside-git-skill"));
  assert.ok(!names.has("manifest-link-skill"));
  assert.ok(names.has("inside-link-skill"));
  assert.ok(names.has("inside-git-skill"));
  assert.ok(result.warnings.some((warning) => warning.code === "resource-outside-root" || warning.code === "package-unavailable"));
});

test("does not read or expand settings symlinks that resolve outside their authorized roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-settings-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(homeDir, "project");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(path.join(projectDir, ".pi"), { recursive: true }), mkdir(outside)]);

  await put(agentDir, "custom/via-user-settings/SKILL.md", "must not discover through external settings");
  await put(projectDir, "project-custom/via-project-settings/SKILL.md", "must not discover through external settings");
  await writeFile(path.join(outside, "user-settings.json"), JSON.stringify({ skills: ["./custom"] }));
  await writeFile(path.join(outside, "project-settings.json"), JSON.stringify({ skills: ["../project-custom"] }));
  await symlink(path.join(outside, "user-settings.json"), path.join(agentDir, "settings.json"));
  await symlink(path.join(outside, "project-settings.json"), path.join(projectDir, ".pi", "settings.json"));

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  assert.ok(!names.has("via-user-settings"));
  assert.ok(!names.has("via-project-settings"));
  assert.ok(result.warnings.filter((warning) => warning.code === "resource-outside-root").length >= 2);
});

test("discovers npm and git packages declared by project settings from the explicitly selected Pi agent directory", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "copi-project-package-cache-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(homeDir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(projectDir, ".pi"), { recursive: true });

  const manifest = (name: string): string => JSON.stringify({ name, pi: { skills: ["skills"] } });
  await put(agentDir, "npm/node_modules/@sample/pkg/package.json", manifest("npm-cache-package"));
  await put(agentDir, "npm/node_modules/@sample/pkg/skills/from-npm-cache/SKILL.md", "selected managed npm package");
  await put(agentDir, "git/github.com/sample/pkg/package.json", manifest("git-cache-package"));
  await put(agentDir, "git/github.com/sample/pkg/skills/from-git-cache/SKILL.md", "selected managed git package");
  await put(projectDir, ".pi/settings.json", JSON.stringify({
    packages: ["npm:@sample/pkg@1.0.0", "git:github.com/sample/pkg"],
  }));

  const result = await discoverResources({ homeDir, agentDir, projectDir });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  assert.ok(names.has("from-npm-cache"));
  assert.ok(names.has("from-git-cache"));
});

test("honors home-only, project-only, both, and none discovery scopes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-discovery-scopes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(projectDir, ".pi"), { recursive: true });

  await put(agentDir, "skills/home-profile-skill/SKILL.md", "home profile");
  await put(homeDir, "Code/other/.pi/skills/other-home-project-skill/SKILL.md", "other home project");
  await put(projectDir, ".pi/skills/current-project-skill/SKILL.md", "current project");
  await put(projectDir, ".pi/settings.json", JSON.stringify({}));
  await put(projectDir, "settings.json", JSON.stringify({ skills: ["./legacy-user-skills"] }));
  await put(projectDir, "legacy-user-skills/leaked-as-user/SKILL.md", "must not treat project root settings as user settings");

  const homeOnly = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: true, project: false } });
  const homeNames = new Set(homeOnly.candidates.map((candidate) => candidate.name));
  assert.ok(homeNames.has("home-profile-skill"));
  assert.ok(homeNames.has("other-home-project-skill"));
  assert.ok(!homeNames.has("current-project-skill"));

  const projectOnly = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: false, project: true } });
  const projectNames = new Set(projectOnly.candidates.map((candidate) => candidate.name));
  assert.ok(projectNames.has("current-project-skill"));
  assert.ok(!projectNames.has("home-profile-skill"));
  assert.ok(!projectNames.has("other-home-project-skill"));

  const both = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: true, project: true } });
  const bothNames = new Set(both.candidates.map((candidate) => candidate.name));
  assert.ok(bothNames.has("home-profile-skill"));
  assert.ok(bothNames.has("other-home-project-skill"));
  assert.ok(bothNames.has("current-project-skill"));

  const none = await discoverResources({
    homeDir: path.join(root, "missing-home"),
    agentDir: path.join(root, "missing-agent"),
    projectDir: path.join(root, "missing-project"),
    scopes: { home: false, project: false },
  });
  assert.deepEqual(none, { candidates: [], warnings: [], excludedPaths: [] });

  const projectOnlyAliases = await discoverResources({ homeDir: projectDir, agentDir: projectDir, projectDir });
  const aliasNames = new Set(projectOnlyAliases.candidates.map((candidate) => candidate.name));
  assert.ok(aliasNames.has("current-project-skill"));
  assert.ok(!aliasNames.has("leaked-as-user"));
});

test("configured packages cannot hide excluded ancestors by becoming new roots", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "copi-excluded-package-ancestors-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(homeDir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const packages = ["auth/pkg", ".cache/pkg", ".npm/pkg", "normal/pkg"];
  for (const [index, relative] of packages.entries()) {
    await put(agentDir, `${relative}/package.json`, JSON.stringify({ pi: { skills: ["skills"] } }));
    await put(agentDir, `${relative}/skills/ancestor-${index}/SKILL.md`, "synthetic package guidance");
  }
  await put(agentDir, "settings.json", JSON.stringify({ packages: packages.map((relative) => `./${relative}`) }));
  const result = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: true, project: true } });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  assert.ok(!names.has("ancestor-0"));
  assert.ok(!names.has("ancestor-1"));
  assert.ok(!names.has("ancestor-2"));
  assert.ok(names.has("ancestor-3"));
  assert.ok(result.excludedPaths.some((entry) => entry.includes(path.join("auth", "pkg"))));
});

test("project-only discovery never reads an unselected agent package cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-unselected-package-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(projectDir, ".pi"), { recursive: true });
  await put(agentDir, "npm/node_modules/@sample/pkg/package.json", JSON.stringify({ pi: { skills: ["skills"] } }));
  await put(agentDir, "npm/node_modules/@sample/pkg/skills/unselected-npm/SKILL.md", "must not read this agent asset");
  await put(agentDir, "git/github.com/sample/pkg/package.json", JSON.stringify({ pi: { skills: ["skills"] } }));
  await put(agentDir, "git/github.com/sample/pkg/skills/unselected-git/SKILL.md", "must not read this agent asset");
  await put(projectDir, ".pi/settings.json", JSON.stringify({ packages: ["npm:@sample/pkg@1.0.0", "git:github.com/sample/pkg"] }));
  const result = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: false, project: true } });
  const names = new Set(result.candidates.map((candidate) => candidate.name));
  assert.ok(!names.has("unselected-npm"));
  assert.ok(!names.has("unselected-git"));
  assert.ok(result.warnings.some((warning) => warning.code === "package-unavailable"));
  const approved = await discoverResources({ homeDir, agentDir, projectDir, scopes: { home: true, project: true } });
  const approvedNames = new Set(approved.candidates.map((candidate) => candidate.name));
  assert.ok(approvedNames.has("unselected-npm"));
  assert.ok(approvedNames.has("unselected-git"));
});

test("does not warn for configured files that do not exist, but warns for dangling symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const projectDir = path.join(homeDir, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);

  const missing = await discoverResources({ homeDir, agentDir, projectDir });
  assert.deepEqual(missing.warnings.filter((warning) => warning.code === "resource-outside-root"), []);

  await symlink(path.join(root, "nowhere.json"), path.join(agentDir, "models.json"));
  const dangling = await discoverResources({ homeDir, agentDir, projectDir });
  assert.equal(dangling.warnings.filter((warning) => warning.code === "resource-outside-root").length, 1);
});
