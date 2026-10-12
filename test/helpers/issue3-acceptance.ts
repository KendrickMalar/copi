import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, readSnapshotFiles } from "../../src/catalog.ts";
import type { SavedItem } from "../../src/types.ts";
// Reuse only the earlier independent transport/FS observer, never coder fixtures or oracles.
import { cli, down, environment, hash, plain, pty, tree, type Step } from "./issue6-acceptance.ts";
export { cli, down, environment, hash, plain, pty, tree };
export type { Step };
export const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
export const select = (message: string, index = 0): Step => ({ wait: `◆  ${message}`, text: `${down.repeat(index)}\r`, checkpoint: true });
export const answer = (message: string, text = "y\r"): Step => ({ wait: message, text, checkpoint: true });
export const finish = select("Manage saved resources", 4);
export const route = (index: number): Step[] => [select("Manage saved resources"), select("Select saved resource"), select("Resource action", index)];

// Retain every new fixture; accept only complete, explicitly assigned runtimes.
export async function box() {
  const envHome = process.env.HOME;
  const envAgent = process.env.PI_CODING_AGENT_DIR;
  const envCache = process.env.NPM_CONFIG_CACHE;
  const assigned = await realpath(process.env.TMPDIR!);
  const legacy = {
    home: "/tmp/copi-issue1-tester3.3V4nH5/home",
    cache: "/tmp/copi-issue1-tester3.3V4nH5/npm-cache",
    tmp: "/private/tmp/copi-issue1-tester3.3V4nH5/tmp",
  };
  const sandboxes = [
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
    envHome === runtime.home && envAgent === `${runtime.home}/.pi/agent` && envCache === runtime.cache && assigned === runtime.tmp;
  assert.ok(matches(legacy) || sandboxes.some(matches), "I3 requires one exactly assigned isolated environment");
  assert.equal(process.env.NPM_CONFIG_USERCONFIG, "/dev/null");
  const root = await realpath(await mkdtemp(path.join(assigned, "copi-i3-independent-")));
  assert.equal(path.dirname(root), assigned);
  const home = path.join(root, "home"), agent = path.join(home, ".pi/agent"), cwd = path.join(root, "project");
  const source = path.join(cwd, ".pi/skills"), sourcePath = path.join(source, "MapKit");
  const tmp = path.join(root, "tmp"), cache = path.join(root, "cache"), target = path.join(root, "target");
  for (const p of [agent, sourcePath, tmp, cache, target]) await mkdir(p, { recursive: true });
  const b = { root, home, agent, cwd, source, sourcePath, tmp, cache, target, library: path.join(home, ".copi") };
  const env = environment(b);
  for (const [key, expected] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: agent, TMPDIR: tmp, NPM_CONFIG_CACHE: cache, NPM_CONFIG_USERCONFIG: "/dev/null" })) assert.equal(env[key], expected);
  console.log(`I3 independent fixture=${root}`);
  return b;
}
export type Fixture = Awaited<ReturnType<typeof box>>;
export function savedContentRoot(b: Fixture, item: SavedItem): string {
  return path.join(b.library, ...item.content.path.split("/"));
}
export const originals = {
  "SKILL.md": "# Embedded MapKit\napiKey: sk_live_i3OriginalMap123456\n最初の本文\n",
  "a.md": "password: i3OriginalOther123456\nsecond original\n",
  "empty.txt": "",
  "retired.md": "old bundle member\n",
};
export const originalModes: Record<string, number> = { "SKILL.md": 0o751, "a.md": 0o640, "empty.txt": 0o644, "retired.md": 0o600 };
export async function source(b: Fixture, files: Record<string, string | Buffer> = originals, modes: Record<string, number> = originalModes, directory = b.sourcePath) {
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); await chmod(file, modes[relative] ?? 0o644);
  }
}
export function setupSteps(secret = true): Step[] {
  return [answer("Choose the locations copi may inspect", `${down}\r`), answer("Authorize copi to search only the selected locations"),
    answer("Select resources to review and save", "\t\r"), answer("Create the first resource group", "Alpha 日本\r"), answer("to one or more groups", "\r"),
    ...(secret ? [answer("Save suspected sensitive file a.md"), answer("Save suspected sensitive file SKILL.md")] : []),
    answer("Save 1 copied resource(s)")];
}
export async function observe(b: Fixture, label: string, extra: unknown = {}) {
  const catalog = await loadCatalog(b.library);
  const snapshots = await Promise.all(catalog.items.map(async item => ({ item, files: (await readSnapshotFiles(b.library, item)).map(f => ({ path: f.path, mode: f.mode, sha256: hash(f.bytes), bytes: f.bytes.length, hex: f.bytes.toString("hex") })) })));
  const state = { label, catalog, snapshots, library: await tree(b.library), source: await tree(b.source), target: await tree(b.target), extra };
  const file = path.join(b.root, `${label}-${randomUUID()}.json`), bytes = Buffer.from(JSON.stringify(state));
  await writeFile(file, bytes); console.log(`I3 independent FS ${label} bytes=${bytes.length} sha256=${hash(bytes)} path=${file}`);
  return state;
}
export async function run(b: Fixture, label: string, command: string[], steps: Step[], expectedExit = 0, mode = "tty") {
  for (const s of steps) assert.doesNotMatch(s.text ?? Buffer.from(s.hex ?? "", "hex").toString(), uuid, "ID input prohibited");
  const r = await pty(b, [process.execPath, cli, ...command], steps, mode, [32, 160]);
  // Keep even failure evidence, before making claims or reading potentially corrupt copies.
  const record = path.join(b.root, `${label}-${randomUUID()}.result.json`);
  await writeFile(record, JSON.stringify({ label, ...r, raw: undefined }));
  console.log(`I3 independent result=${record}`);
  assert.equal(r.timeout, false, `driver timeout ${r.actions}/${r.totalActions}: ${r.log}`);
  assert.equal(r.code, expectedExit, r.output); assert.equal(r.actions, steps.length, r.output);
  assert.equal(r.exact, true, JSON.stringify({ before: r.before, after: r.after, xor: r.xor }));
  assert.equal(r.checkpoints.length, steps.filter(s => s.checkpoint).length);
  for (const action of r.timeline) assert.equal(action.written, Buffer.from(action.sentHex, "hex").length);
  assert.doesNotMatch(r.output, uuid, "normal screen must not expose any UUID");
  return r;
}
export async function register(b: Fixture, files: Record<string, string | Buffer> = originals, modes = originalModes, sensitive = true) {
  await source(b, files, modes);
  const before = await tree(b.source);
  const r = await run(b, "registration", ["setup"], setupSteps(sensitive));
  assert.match(plain(r.output), /Masked preview \(1\/1\): MapKit/);
  assert.ok(!r.output.includes("sk_live_i3OriginalMap123456") && !r.output.includes("i3OriginalOther123456"));
  assert.deepEqual(await tree(b.source), before);
  const c = await loadCatalog(b.library);
  if (c.version !== 2) throw new Error("New registrations must use catalog v2 sources content.");
  assert.equal(c.items.length, 1); assert.equal(c.groups.length, 1);
  const item = c.items[0]!;
  assert.deepEqual(item.content, { kind: "tree", path: `sources/${item.id}` });
  assert.equal(item.name, "MapKit"); assert.equal(item.kind, "skill");
  assert.deepEqual(item.destination, { kind: "project", path: ".pi/skills/MapKit" });
  assert.deepEqual(c.groups[0]!.itemIds, [item.id]);
  await snapshot(b, files, modes); await observe(b, "registered");
  return item;
}
export async function snapshot(b: Fixture, expected: Record<string, string | Buffer>, modes: Record<string, number>) {
  const c = await loadCatalog(b.library);
  if (c.version !== 2) throw new Error("Saved snapshots must use catalog v2 sources content.");
  const item = c.items[0]!;
  const actual = await readSnapshotFiles(b.library, item);
  assert.deepEqual(actual.map(f => f.path).sort(), Object.keys(expected).sort());
  assert.deepEqual(item.files.map(f => f.path).sort(), Object.keys(expected).sort());
  for (const f of actual) {
    const bytes = Buffer.from(expected[f.path]!);
    assert.deepEqual(f.bytes, bytes); assert.equal(f.sha256, hash(bytes)); assert.equal(f.mode, modes[f.path]);
    const desc = item.files.find(d => d.path === f.path)!;
    assert.equal(desc.sha256, hash(bytes)); assert.equal(desc.mode, modes[f.path]);
    const inode = (await tree(savedContentRoot(b, item)))[f.path]!;
    assert.equal(inode.mode, 0o600); assert.equal(inode.hex, bytes.toString("hex"));
  }
  return item;
}
export function groupSteps(name: string, index: number): Step[] {
  return [select("Manage saved resources", 1), select("Manage saved groups"), answer("New group name", `${name}\r`),
    select("Manage saved groups", 2), select("Select group", index), answer(`Select resources in ${name}`, "\t\r"),
    select("Manage saved groups", 4), answer("Save these group changes"), finish];
}
export const refreshRoute = () => [...route(4), answer("Authorize reading only this selected source file or directory tree now?")];
export function refreshApprovals(): Step[] {
  return [answer("Approve this refresh diff and source metadata?"), answer("Save suspected sensitive file a.md"), answer("Save suspected sensitive file SKILL.md"), answer("Replace saved copy with this approved source snapshot?")];
}
export function normalized(output: string) { return plain(output).replace(/[│◇◆┌└─]/g, " ").replace(/\s+/g, " "); }
export async function unchanged(b: Fixture, before: Awaited<ReturnType<typeof observe>>, label: string) {
  const after = await observe(b, label);
  for (const key of ["library", "source", "target", "catalog", "snapshots"] as const) assert.deepEqual(after[key], before[key], key);
}
