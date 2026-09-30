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
  await put(agentDir, "skills/portable/.env", "TOKEN=do-not-copy");
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
