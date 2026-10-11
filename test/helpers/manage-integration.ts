import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, readSnapshotFiles } from "../../src/catalog.ts";
import { cli, down, environment, hash, noIds, plain, pty, restored, runCli, tree, type Box, type Step } from "./issue6-acceptance.ts";
export { cli, down, hash, plain, runCli, tree };
export type { Step };

// No teardown: retain all new integration fixtures and raw PTY/FS evidence.
export async function integrationBox(): Promise<Box & { sourcePath: string; target: string }> {
  const assigned = await realpath(process.env.TMPDIR!);
  const runtimes = [
    {
      home: "/tmp/copi-issue1-tester3.3V4nH5/home",
      cache: "/tmp/copi-issue1-tester3.3V4nH5/npm-cache",
      tmp: "/private/tmp/copi-issue1-tester3.3V4nH5/tmp",
    },
    {
      home: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/coder/home",
      cache: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/coder/cache",
      tmp: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/coder/tmp",
    },
    {
      home: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/tester/home",
      cache: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/tester/cache",
      tmp: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/tester/tmp",
    },
    {
      home: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/coder/home",
      cache: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/coder/cache",
      tmp: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/coder/tmp",
    },
    {
      home: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/tester/home",
      cache: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/tester/cache",
      tmp: "/Users/papillon/Code/copi/.worktrees/sources-only/.pi/subagents/sandboxes/production/tester/tmp",
    },
  ];
  const matches = (runtime: { home: string; cache: string; tmp: string }) =>
    process.env.HOME === runtime.home && process.env.PI_CODING_AGENT_DIR === `${runtime.home}/.pi/agent` &&
    process.env.NPM_CONFIG_CACHE === runtime.cache && assigned === runtime.tmp;
  assert.ok(runtimes.some(matches), "integration requires one exactly assigned isolated environment tuple");
  assert.equal(process.env.NPM_CONFIG_USERCONFIG, "/dev/null");
  const root = await realpath(await mkdtemp(path.join(assigned, "copi-manage-integration-")));
  assert.equal(path.dirname(root), assigned);
  const home = path.join(root, "home"), agent = path.join(home, ".pi/agent"), cwd = path.join(root, "project");
  const tmp = path.join(root, "tmp"), cache = path.join(root, "cache"), target = path.join(root, "target");
  const source = path.join(cwd, ".pi/skills"), sourcePath = path.join(source, "original");
  for (const directory of [agent, tmp, cache, target, sourcePath]) await mkdir(directory, { recursive: true });
  const b = { root, home, agent, cwd, source, tmp, cache, target, sourcePath, library: path.join(home, ".copi") };
  assert.equal(environment(b).HOME, home); assert.equal(environment(b).PI_CODING_AGENT_DIR, agent);
  assert.equal(environment(b).TMPDIR, tmp); assert.equal(environment(b).NPM_CONFIG_CACHE, cache);
  assert.equal(environment(b).NPM_CONFIG_USERCONFIG, "/dev/null");
  return b;
}
export type IntegrationBox = Awaited<ReturnType<typeof integrationBox>>;
export const initialFiles = {
  "SKILL.md": "# Original embedded name\napiKey: sk_live_setupFirst12345678\ninitial body\n",
  "second.md": "password: setupSecond12345678\nsecondary body\n",
};
export async function sourceFiles(b: IntegrationBox) {
  for (const [file, text] of Object.entries(initialFiles)) await writeFile(path.join(b.sourcePath, file), text);
  await chmod(path.join(b.sourcePath, "SKILL.md"), 0o751);
  await chmod(path.join(b.sourcePath, "second.md"), 0o640);
  for (const file of ["auth/private.md", ".env-local", "cache/ignored.md"]) {
    const absolute = path.join(b.sourcePath, file); await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "excluded fixture must not be saved\n");
  }
}
export const choose = (wait: string, index = 0): Step => ({ wait: `◆  ${wait}`, text: `${down.repeat(index)}\r` });
export const at = (wait: string, text = "y\r"): Step => ({ wait, text });
export const finish = choose("Manage saved resources", 4);
export const resource = (index: number): Step[] => [choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action", index)];
export function setupSteps(): Step[] {
  return [at("Choose the locations copi may inspect", `${down}\r`), at("Authorize copi to search only", "y\r"),
    at("Select resources to review", "\t\r"), at("Create the first resource group", "First bundle\r"),
    at("Save suspected sensitive file second.md", "y\r"), at("Save suspected sensitive file SKILL.md", "y\r"),
    at("Assign original to one or more groups", "\t\r"), at("Save 1 copied resource(s)", "y\r")];
}
export function addGroupSteps(name: string, index: number): Step[] {
  return [choose("Manage saved resources", 1), choose("Manage saved groups"), at("New group name", `${name}\r`),
    choose("Manage saved groups", 2), choose("Select group", index), at(`Select resources in ${name}`, "\t\r"),
    choose("Manage saved groups", 3), at("Save these group changes"), finish];
}
export async function interactive(b: IntegrationBox, label: string, command: "setup" | "manage", steps: Step[], expectedCode = 0) {
  for (const step of steps) {
    const sent = step.text ?? (step.hex ? Buffer.from(step.hex, "hex").toString() : "");
    assert.doesNotMatch(sent, /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i, "no UUID input");
  }
  const run = await pty(b, [process.execPath, cli, command], steps, "tty", [45, 180]);
  await evidence(b, `${label}-pty`, { ...run, raw: undefined });
  restored(run); assert.equal(run.code, expectedCode, run.output);
  for (const action of run.timeline) assert.equal(action.written, action.sentHex.length / 2, "all input bytes reached PTY");
  const catalog = await loadCatalog(b.library);
  noIds(run.output, [...catalog.items.map(i => i.id), ...catalog.groups.map(g => g.id)]);
  assert.doesNotMatch(run.output, /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i);
  return run;
}
export async function evidence(b: IntegrationBox, label: string, extra: unknown = {}) {
  const catalog = await loadCatalog(b.library);
  const snapshots = await Promise.all(catalog.items.map(async item => ({ item,
    files: (await readSnapshotFiles(b.library, item)).map(file => ({ path: file.path, mode: file.mode,
      bytes: file.bytes.length, hex: file.bytes.toString("hex"), sha256: hash(file.bytes) })) })));
  const observed = { label, catalog, snapshots, library: await tree(b.library), source: await tree(b.source),
    target: await tree(b.target), extra };
  const bytes = Buffer.from(JSON.stringify(observed));
  const file = path.join(b.root, `${label}-${randomUUID()}.json`); await writeFile(file, bytes);
  console.log(`integration FS evidence bytes=${bytes.length} sha256=${hash(bytes)} path=${file}`);
  return observed;
}
export async function registered(b: IntegrationBox) {
  await sourceFiles(b);
  const before = await tree(b.source);
  const run = await interactive(b, "setup", "setup", setupSteps());
  assert.match(plain(run.output), /Masked preview: original/);
  assert.match(plain(run.output), /Search scope and exclusions/);
  assert.ok(!run.output.includes("sk_live_setupFirst12345678"));
  assert.ok(!run.output.includes("setupSecond12345678"));
  assert.deepEqual(await tree(b.source), before);
  const catalog = await loadCatalog(b.library);
  if (catalog.version !== 2) throw new Error("New registrations must use catalog v2 sources content.");
  assert.equal(catalog.items.length, 1); assert.equal(catalog.groups.length, 1);
  const item = catalog.items[0]!;
  assert.deepEqual(item.content, { kind: "tree", path: `sources/${item.id}` });
  assert.equal(item.name, "original"); assert.equal(item.kind, "skill");
  assert.deepEqual(item.destination, { kind: "project", path: ".pi/skills/original" });
  assert.deepEqual(catalog.groups[0]!.itemIds, [item.id]);
  assert.deepEqual(item.files.map(f => f.path).sort(), ["SKILL.md", "second.md"].sort());
  const contentRoot = path.join(b.library, ...item.content.path.split("/"));
  for (const [file, text] of Object.entries(initialFiles)) assert.deepEqual(await readFile(path.join(contentRoot, file)), Buffer.from(text));
  await evidence(b, "registered");
  return item;
}
