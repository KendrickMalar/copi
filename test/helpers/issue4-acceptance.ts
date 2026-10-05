import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPreparedResource, loadCatalog, prepareResource, saveCatalog } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";
import { readRefresh, type PreparedRefresh } from "../../src/refresh.ts";
import type { ResourceCandidate, ResourceKind } from "../../src/types.ts";
import { custody, down, environment, hash, noIds, plain, pty, restored, tree, type Box, type Step } from "./issue6-acceptance.ts";
export { custody, down, environment, hash, noIds, plain, pty, restored, tree };
export type { Step };
export const cli = new URL("../../src/cli.js", import.meta.url).pathname;
// Expectations derive from approved R1–R6, not implementation's reported behaviour.
export const contract = Object.freeze({ preserve: ["id", "name", "kind", "savedAt", "destination"], final: "Replace saved copy with this approved source snapshot?", diff: "Approve this refresh diff and source metadata?", permission: "Authorize reading only this selected source file or directory tree now?" });
export async function fixture(files: Record<string, string | Buffer> = { "SKILL.md": "# Original embedded name\ncopi-only edit\n" }, kind: ResourceKind = "skill") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "copi-r4-independent-")));
  assert.ok(root.startsWith("/private/tmp/copi-issue1-tester4.G7sT9W/") || root.startsWith("/tmp/copi-issue1-tester4.G7sT9W/"), "fixtures must stay in assigned sandbox");
  const home = path.join(root, "home"), agent = path.join(home, ".pi/agent"), cwd = path.join(root, "project"), source = path.join(root, "source"), tmp = path.join(root, "tmp"), cache = path.join(root, "cache");
  for (const dir of [agent, cwd, source, tmp, cache]) await mkdir(dir, { recursive: true });
  const b: Box = { root, home, agent, cwd, source, tmp, cache, library: path.join(home, ".copi") };
  const sourcePath = kind === "skill" ? path.join(source, "original") : path.join(source, Object.keys(files)[0]!);
  for (const [relative, bytes] of Object.entries(files)) { const file = kind === "skill" ? path.join(sourcePath, relative) : sourcePath; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
  const candidate: ResourceCandidate = { id: "fixture-source", name: "保存済みの名前", kind, source: "acceptance-original", scope: "project", sourceRoot: source, sourcePath, destination: kind === "model-config" || kind === "keybindings" ? { kind: "global-only" } : { kind: "project", path: kind === "skill" ? ".pi/skills/retained" : "AGENTS.md" } };
  const prepared = await prepareResource(candidate), inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(b.library, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths }); assert.ok(item);
  const catalog = await loadCatalog(b.library);
  catalog.groups = [{ id: "alpha", name: "first group", itemIds: [item.id] }, { id: "beta", name: "second group", itemIds: [item.id] }]; await saveCatalog(b.library, catalog);
  const saved = (relative: string) => path.join(b.library, "items", item.id, "files", relative);
  const replacement = async (next: Record<string, string | Buffer>, overrides: Partial<ResourceCandidate> = {}) => {
    const target = path.join(source, `replacement-${randomUUID()}`); await mkdir(target);
    for (const [relative, bytes] of Object.entries(next)) { const file = path.join(target, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
    return { ...candidate, name: "DO NOT ADOPT THIS NAME", source: "explicit-refresh-path", scope: "shared" as const, sourcePath: kind === "skill" ? target : path.join(target, Object.keys(next)[0]!), sourceRoot: target, ...overrides };
  };
  return { ...b, candidate, item, sourcePath, saved, replacement };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function approval(p: PreparedRefresh) { return { reviewId: p.reviewId, confirmed: true, approvedSensitivePaths: [...readRefresh(p).sensitivePaths] }; }
export async function evidence(b: Box, label: string, extra: unknown = {}) { const observed = { label, library: await tree(b.library), source: await tree(b.source), home: await tree(b.agent), project: await tree(b.cwd), extra }; const bytes = Buffer.from(JSON.stringify(observed)); const log = path.join(b.root, `${label}-${randomUUID()}.json`); await writeFile(log, bytes); console.log(`R4 FS evidence bytes=${bytes.length} sha256=${hash(bytes)} path=${log}`); return observed; }
export async function bytes(b: Fixture) { return Promise.all(b.item.files.map(f => readFile(b.saved(f.path)))); }
export const enter: Step[] = [{ wait: "Manage saved resources", text: "\r" }, { wait: "Select saved resource", text: "\r" }, { wait: "Resource action", text: `${down.repeat(4)}\r` }];
export const finish: Step = { wait: "◆  Manage saved resources", text: "\x03" };
export const yes: Step = { text: "y\r" };
export const at = (wait: string, text = "y\r"): Step => ({ wait, text });
export async function manage(b: Box, steps: Step[]) { const r = await pty(b, [process.execPath, cli, "manage"], steps, "tty", [45, 180]); restored(r); noIds(r.output, (await loadCatalog(b.library)).items.map(i => i.id)); return r; }
export async function packageFixture() {
  const b = await fixture(); const pkg = path.join(b.agent, "npm/node_modules/declared-r4"), skill = path.join(pkg, "skills/declared");
  await mkdir(skill, { recursive: true }); await writeFile(path.join(skill, "SKILL.md"), "declared package bytes\n");
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "declared-r4", pi: { skills: ["skills/declared"] } }));
  await writeFile(path.join(b.agent, "settings.json"), JSON.stringify({ packages: ["npm:declared-r4"] }));
  const c = await loadCatalog(b.library); c.items[0]!.sourcePath = skill; c.items[0]!.source = "package:npm:declared-r4"; c.items[0]!.scope = "package"; await saveCatalog(b.library, c);
  const options = { homeDir: b.home, agentDir: b.agent, projectDir: b.cwd, scopes: { home: true, project: false } };
  return { ...b, pkg, skill, options, originItem: (await loadCatalog(b.library)).items[0]! };
}
