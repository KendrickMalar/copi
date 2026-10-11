import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalog, readSnapshotFiles } from "../src/catalog.ts";
import { parseAddArgs } from "../src/cli-add.ts";

async function box(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-add-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await Promise.all([mkdir(path.join(home, ".pi", "agent"), { recursive: true }), mkdir(project)]);
  return { root, home, project, library: path.join(home, ".copi") };
}
type Box = Awaited<ReturnType<typeof box>>;
// No TTY: spawnSync pipes stdio, exactly how an AI agent runs the command.
function add(b: Box, args: string[]) {
  const result = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "add", ...args], {
    cwd: b.project, env: { HOME: b.home, PI_CODING_AGENT_DIR: path.join(b.home, ".pi", "agent") }, encoding: "utf8", timeout: 20_000,
  });
  return { ...result, json: (() => { try { return JSON.parse(result.stdout); } catch { return undefined; } })() };
}
async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test("parseAddArgs requires paths and a group and rejects settings kinds", () => {
  assert.deepEqual(parseAddArgs(["a", "b", "--group", "g", "--dry-run"]), { paths: ["a", "b"], group: "g", dryRun: true, json: false });
  assert.throws(() => parseAddArgs(["a"]), /Usage: copi add/);
  assert.throws(() => parseAddArgs(["--group", "g"]), /Usage: copi add/);
  assert.throws(() => parseAddArgs(["a", "--group", "g", "--kind", "mcp-config"]), /--kind must be skill, subagent or instruction/);
  assert.throws(() => parseAddArgs(["a", "b", "--group", "g", "--name", "x"]), /--name can only be used with a single path/);
});

test("add saves clean resources without a TTY, detects kinds and creates the group", async (t) => {
  const b = await box(t);
  await put(path.join(b.project, "skills", "mapper", "SKILL.md"), "# Mapper\nUses the map.\n");
  await put(path.join(b.project, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReviews.\n");
  await put(path.join(b.project, "AGENTS.md"), "# Project rules\n");
  const result = add(b, ["skills/mapper", "agents/reviewer.md", "AGENTS.md", "--group", "game", "--json"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.json.results.map((r: { status: string; kind: string; name: string }) => [r.status, r.kind, r.name]),
    [["added", "skill", "mapper"], ["added", "subagent", "reviewer.md"], ["added", "instruction", "AGENTS.md"]]);
  const catalog = await loadCatalog(b.library);
  assert.deepEqual(catalog.items.map((item) => [item.name, item.destination]).sort(),
    [["AGENTS.md", { kind: "project", path: "AGENTS.md" }], ["mapper", { kind: "project", path: ".pi/skills/mapper" }], ["reviewer.md", { kind: "project", path: ".pi/agents/reviewer.md" }]]);
  assert.equal(catalog.groups.length, 1);
  assert.equal(catalog.groups[0]!.name, "game");
  assert.equal(catalog.groups[0]!.itemIds.length, 3);
  const mapper = catalog.items.find((item) => item.name === "mapper")!;
  const files = await readSnapshotFiles(b.library, mapper);
  assert.equal(files[0]!.bytes.toString(), "# Mapper\nUses the map.\n");

  // A second add reuses the existing group (matched by name key) instead of creating another.
  await put(path.join(b.project, "agents", "helper.md"), "---\nname: helper\n---\nHelps.\n");
  assert.equal(add(b, ["agents/helper.md", "--group", "GAME"]).status, 0);
  const after = await loadCatalog(b.library);
  assert.equal(after.groups.length, 1);
  assert.equal(after.groups[0]!.itemIds.length, 4);
});

test("add refuses suspected secrets, settings files, symlinks, name conflicts and unknown kinds, saving the rest", async (t) => {
  const b = await box(t);
  const secret = ["sk", "live", "addSecret1234567890"].join("_");
  await put(path.join(b.project, "skills", "leaky", "SKILL.md"), `# Leaky\napiKey: ${secret}\n`);
  await put(path.join(b.project, "settings.json"), "{}\n");
  await put(path.join(b.project, "notes.txt"), "plain\n");
  await put(path.join(b.project, "agents", "ok.md"), "---\nname: ok\n---\nFine.\n");
  await put(path.join(b.root, "outside.md"), "outside\n");
  await symlink(path.join(b.root, "outside.md"), path.join(b.project, "agents", "linked.md"));
  const result = add(b, ["skills/leaky", "settings.json", "notes.txt", "agents/linked.md", "missing", "agents/ok.md", "--group", "g", "--json"]);
  assert.equal(result.status, 1);
  const reasons = Object.fromEntries(result.json.results.map((r: { path: string; status: string; reason?: string }) => [path.basename(r.path), `${r.status}: ${r.reason ?? ""}`]));
  assert.match(reasons.leaky, /^refused: suspected sensitive content in SKILL\.md/);
  assert.match(reasons["settings.json"], /^refused: settings files are registered with copi setup/);
  assert.match(reasons["notes.txt"], /^refused: cannot tell the kind/);
  assert.match(reasons["linked.md"], /^refused: symbolic links are not added/);
  assert.match(reasons.missing, /^refused: path does not exist/);
  assert.match(reasons["ok.md"], /^added/);
  assert.ok(!result.stdout.includes(secret));
  const catalog = await loadCatalog(b.library);
  assert.deepEqual(catalog.items.map((item) => item.name), ["ok.md"]);

  const conflict = add(b, ["agents/ok.md", "--group", "g"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /refused: .*name conflict/);
  assert.equal(add(b, ["agents/ok.md", "--group", "g", "--name", "ok copy"]).status, 0);
});

test("add --dry-run reports without creating the library", async (t) => {
  const b = await box(t);
  await put(path.join(b.project, "agents", "dry.md"), "---\nname: dry\n---\n");
  const result = add(b, ["agents/dry.md", "--group", "g", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would add: dry\.md \[subagent\] → g/);
  await assert.rejects(readFile(path.join(b.library, "catalog.json")), { code: "ENOENT" });
});
