import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, newCatalog, saveCatalog } from "../src/catalog.ts";
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

function runCli(box: Sandbox, args: string[]) {
  return spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), ...args], {
    cwd: box.project,
    env: { HOME: box.home, PI_CODING_AGENT_DIR: box.agent },
    encoding: "utf8",
    timeout: 15_000,
  });
}

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
  await importResource(box.library, candidate, { confirmed: true, groupIds: ["bundle"] });

  const result = runCli(box, ["apply", "bundle", box.project, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credential-skill\/SKILL\.md/);
  assert.match(result.stdout, /REDACTED/);
  assert.ok(!result.stdout.includes(secret));
  await assert.rejects(readFile(path.join(box.project, ".pi", "skills", "credential-skill", "SKILL.md")), { code: "ENOENT" });
});
