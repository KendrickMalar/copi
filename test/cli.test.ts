import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, newCatalog, prepareResource, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import type { ResourceCandidate } from "../src/types.ts";

interface Sandbox {
  root: string;
  home: string;
  agent: string;
  project: string;
  library: string;
}

async function sandbox(t: test.TestContext): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "synthetic-home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "synthetic-project");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(project)]);
  return { root, home, agent, project, library: path.join(home, ".copi") };
}

function runCli(box: Sandbox, args: string[], entryPoint = path.resolve("dist/src/cli.js")) {
  return spawnSync(process.execPath, [entryPoint, ...args], {
    cwd: box.project,
    env: { HOME: box.home, PI_CODING_AGENT_DIR: box.agent },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("manage help explains saved-copy boundaries and all help aliases stay read-only", async (t) => {
  const box = await sandbox(t);
  let canonical: string | undefined;
  for (const args of [[], ["help"], ["--help"], ["-h"], ["manage", "--help"], ["manage", "-h"], ["setup", "--help"], ["groups", "-h"], ["list", "--help"], ["apply", "--help"]]) {
    const run = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), ...args], {
      cwd: box.project,
      env: { ...process.env, HOME: box.home, PI_CODING_AGENT_DIR: box.agent,
        TMPDIR: process.env.TMPDIR, NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE, NPM_CONFIG_USERCONFIG: "/dev/null" },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.equal(run.stderr, "");
    canonical ??= run.stdout;
    assert.equal(run.stdout, canonical, `help alias ${args.join(" ")}`);
  }
  assert.ok(canonical);
  for (const meaning of [
    /manage[\s\S]*names?[\s\S]*UUID.*not required/i,
    /unique[\s\S]*NFKC[\s\S]*Unicode 17[\s\S]*full case folding/i,
    /duplicate[\s\S]*manual/i,
    /existing UTF-8[\s\S]*1_000_000 bytes[\s\S]*binary[\s\S]*unsupported/i,
    /Ctrl-S[\s\S]*Esc[\s\S]*Ctrl-C/,
    /raw text[\s\S]*screen[\s\S]*individual approval[\s\S]*save/i,
    /fixed bytes[\s\S]*each suspected sensitive file/i,
    /refresh[\s\S]*reselect[\s\S]*whole[\s\S]*copi-only edits/i,
    /display name[\s\S]*contents.*not rewritten/i,
    /original[\s\S]*not written back/i,
    /0600[\s\S]*apply[\s\S]*source mode/i,
    /no history[\s\S]*restore[\s\S]*automatic merge/i,
    /file addition[\s\S]*deletion[\s\S]*internal rename[\s\S]*global settings/i,
  ]) assert.match(canonical, meaning);
  await assert.rejects(readFile(path.join(box.library, "catalog.json")), { code: "ENOENT" });
});

test("help and list are read-only commands under a synthetic home", async (t) => {
  const box = await sandbox(t);
  const help = runCli(box, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /setup/);
  assert.match(help.stdout, /apply/);
  assert.match(help.stdout, /directories named auth[\s\S]*authentication-specific code may be missing/i);

  const list = runCli(box, ["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /no saved snapshots/i);
  await assert.rejects(readFile(path.join(box.library, "catalog.json")), { code: "ENOENT" });
});

test("npm-style command symlink starts help, readonly list, and non-TTY guards", async (t) => {
  const box = await sandbox(t);
  const binDir = path.join(box.root, "npm-bin");
  const linkedCommand = path.join(binDir, "copi");
  await mkdir(binDir);
  await symlink(path.resolve("dist/src/cli.js"), linkedCommand);

  const help = runCli(box, ["--help"], linkedCommand);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("copi — copy and organize"));

  const list = runCli(box, ["list"], linkedCommand);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /no saved snapshots/i);

  const setup = runCli(box, ["setup"], linkedCommand);
  assert.notEqual(setup.status, 0);
  assert.match(setup.stderr, /interactive|terminal|tty/i);
  await assert.rejects(readFile(path.join(box.library, "catalog.json")), { code: "ENOENT" });
});

test("non-interactive mutations stop before creating the library", async (t) => {
  const box = await sandbox(t);
  const setup = runCli(box, ["setup"]);
  assert.notEqual(setup.status, 0);
  assert.match(setup.stderr, /interactive|terminal|tty/i);

  const apply = runCli(box, ["apply", "bundle"]);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /interactive|terminal|tty/i);
  await assert.rejects(readFile(path.join(box.library, "catalog.json")), { code: "ENOENT" });
});

test("manage rejects non-TTY before creating a library, including npm-style symlink entry", async (t) => {
  const box = await sandbox(t);
  const linked = path.join(box.root, "copi");
  await symlink(path.resolve("dist/src/cli.js"), linked);
  for (const entry of [path.resolve("dist/src/cli.js"), linked]) {
    const result = runCli(box, ["manage"], entry);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manage.*TTY|TTY.*manage/i);
    await assert.rejects(readFile(path.join(box.library, "catalog.json")), { code: "ENOENT" });
  }
  assert.match(runCli(box, []).stdout, /manage/);
});

test("list and non-TTY groups display names/kind/destination without internal UUIDs", async (t) => {
  const box = await sandbox(t);
  const source = path.join(box.root, "source.md");
  await writeFile(source, "ordinary text\n");
  const catalog = newCatalog();
  const groupId = "9f2a4d22-eeba-43d3-b7d4-1325234a197f";
  catalog.groups.push({ id: groupId, name: "Named group", itemIds: [] });
  await saveCatalog(box.library, catalog);
  const item = await importResource(box.library, {
    id: "source", name: "Named resource", kind: "instruction", source: "test", scope: "project",
    sourceRoot: box.root, sourcePath: source, destination: { kind: "project", path: "AGENTS.md" },
  }, { confirmed: true, groupIds: [groupId] });
  assert.ok(item);
  const before = await readFile(path.join(box.library, "catalog.json"));
  for (const command of ["list", "groups", "manage"]) {
    const run = runCli(box, [command]);
    assert.equal(run.status, command === "manage" ? 1 : 0, run.stderr);
    assert.ok(!run.stdout.includes(item.id));
    assert.ok(!run.stdout.includes(groupId));
    if (command === "list") { assert.match(run.stdout, /Named resource/); assert.match(run.stdout, /AGENTS.md/); }
    if (command === "groups") assert.match(run.stdout, /Named group/);
    assert.deepEqual(await readFile(path.join(box.library, "catalog.json")), before);
  }
});

test("apply --dry-run displays masked plans without changing the synthetic project", async (t) => {
  const box = await sandbox(t);
  const sourceRoot = path.join(box.root, "synthetic-source");
  const sourcePath = path.join(sourceRoot, "credential-skill");
  await mkdir(sourcePath, { recursive: true });
  const secret = "sk_live_1234567890abcdef";
  const content = `apiKey: ${secret}\n`;
  const sourceFile = path.join(sourcePath, "SKILL.md");
  await writeFile(sourceFile, content);

  const catalog = newCatalog();
  catalog.groups.push({ id: "bundle", name: "Bundle", itemIds: [] });
  await saveCatalog(box.library, catalog);
  const candidate: ResourceCandidate = {
    id: "synthetic-skill",
    kind: "skill",
    source: "synthetic-test",
    scope: "project",
    sourceRoot,
    sourcePath,
    name: "credential-skill",
    destination: { kind: "project", path: ".pi/skills/credential-skill" },
  };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  await importResource(box.library, candidate, { confirmed: true, groupIds: ["bundle"], inspection, approvedSensitivePaths: ["SKILL.md"] });

  const result = runCli(box, ["apply", "bundle", box.project, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credential-skill\/SKILL\.md/);
  assert.match(result.stdout, /REDACTED/);
  assert.ok(!result.stdout.includes(secret));
  await assert.rejects(readFile(path.join(box.project, ".pi", "skills", "credential-skill", "SKILL.md")), { code: "ENOENT" });
});
