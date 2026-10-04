import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { catalogBytes, importPreparedResource, loadCatalog, prepareResource, saveCatalog } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";
import { readSavedChange, type PreparedSavedChange } from "../../src/resource-mutations.ts";
import { StorageTransactions, type StorageOptions } from "../../src/storage-transaction.ts";
import type { ResourceCandidate } from "../../src/types.ts";

export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const modules = {
  catalog: new URL("../../src/catalog.js", import.meta.url).href,
  mutations: new URL("../../src/resource-mutations.js", import.meta.url).href,
  storage: new URL("../../src/storage-transaction.js", import.meta.url).href,
};
export async function box(contents: Record<string, Buffer | string> = { "SKILL.md": "独立 old e\u0301\r\n" }) {
  assert.ok(process.env.TMPDIR && process.env.HOME && process.env.PI_CODING_AGENT_DIR, "explicit isolated environment required");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-issue5-acceptance-"));
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "bundle");
  const library = path.join(root, "library");
  await mkdir(sourcePath, { recursive: true });
  for (const [name, bytes] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(sourcePath, name)), { recursive: true });
    await writeFile(path.join(sourcePath, name), bytes, { mode: 0o644 });
  }
  const candidate: ResourceCandidate = { id: "independent-fixture", kind: "skill", source: "acceptance", scope: "project", sourceRoot, sourcePath, name: "Independent 日本語", destination: { kind: "project", path: ".pi/skills/independent" } };
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(library, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  const catalog = await loadCatalog(library);
  catalog.groups.push({ id: "independent-team", name: "Independent team", itemIds: [item.id] });
  await saveCatalog(library, catalog);
  console.log(`fixture=${root}`); // Keep raw fixture and logs for independent review; no unknown-lock cleanup.
  return { root, library, sourceRoot, sourcePath, candidate, prepared, inspection, item, file: path.join(library, "items", item.id, "files", "SKILL.md") };
}
export type Box = Awaited<ReturnType<typeof box>>;
export async function rawTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(target: string, relative: string): Promise<void> {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) result[relative] = `link:${await readlink(target)}`;
    else if (stat.isDirectory()) {
      result[relative] = `directory:${(stat.mode & 0o777).toString(8)}`;
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), path.posix.join(relative, name));
    } else result[relative] = `mode:${(stat.mode & 0o777).toString(8)};hex:${(await readFile(target)).toString("hex")}`;
  }
  await visit(root, ".");
  return result;
}
export async function evidence(b: Box, label: string, extra: unknown = {}) {
  const output = { label, library: b.library, tree: await rawTree(b.library), extra };
  await writeFile(path.join(b.root, `${label}.json`), JSON.stringify(output, null, 2));
  console.log(`evidence=${path.join(b.root, `${label}.json`)}`);
  return output.tree;
}
export const approval = (change: PreparedSavedChange) => ({ confirmed: true, reviewId: change.reviewId, approvedSensitivePaths: readSavedChange(change).sensitivePaths });
export async function proposal(b: Box, values: Record<string, Buffer | string> = { "SKILL.md": "独立 next\r\n" }) {
  const next = await loadCatalog(b.library);
  const files = Object.entries(values).sort(([a], [z]) => a.localeCompare(z)).map(([name, bytes]) => ({ path: name, bytes: Buffer.from(bytes), mode: 0o644 }));
  next.items.find((item) => item.id === b.item.id)!.files = files.map((file) => ({ path: file.path, mode: file.mode, sha256: digest(file.bytes) }));
  return { next, bytes: catalogBytes(next), replacements: [{ itemId: b.item.id, files }] };
}
export async function kernel(b: Box, p: Awaited<ReturnType<typeof proposal>>, options: StorageOptions = {}) {
  return new StorageTransactions(options).run(b.library, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), p.bytes, p.replacements);
  });
}
export async function child(b: Box, code: string) {
  const root = await mkdtemp(path.join(b.root, "process-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const agent = path.join(home, ".pi", "agent");
  const cache = path.join(root, "cache");
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(tmp), mkdir(cache)]);
  await writeFile(path.join(root, "repro.mjs"), code);
  const processChild = spawn(process.execPath, [path.join(root, "repro.mjs")], { cwd: root, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, TMPDIR: tmp, NPM_CONFIG_CACHE: cache, NPM_CONFIG_USERCONFIG: "/dev/null" } });
  let output = "";
  processChild.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  processChild.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("close", async (code, signal) => {
      await writeFile(path.join(root, "output.log"), output);
      await writeFile(path.join(root, "exit.json"), JSON.stringify({ code, signal }));
      resolve({ code, signal, output });
    });
  });
  const timer = setTimeout(() => { processChild.kill("SIGKILL"); }, 15_000);
  void exit.finally(() => clearTimeout(timer));
  return { process: processChild, exit, root };
}
export function wait(childProcess: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { reject(new Error(`Did not reach ${marker}: ${output}`)); }, 7_000);
    childProcess.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
      if (output.includes(marker)) { clearTimeout(timer); resolve(); }
    });
    childProcess.once("close", () => { clearTimeout(timer); if (!output.includes(marker)) reject(new Error(`Exited before ${marker}: ${output}`)); });
  });
}
export function interrupted(b: Box, p: Awaited<ReturnType<typeof proposal>>, boundary: string, rollback = false): string {
  return `import {StorageTransactions} from ${JSON.stringify(modules.storage)};
const tx=new StorageTransactions({checkpoint:async(point)=>{
if(${rollback} && point==='catalog-renamed') throw new Error('independent rollback trigger');
if(point===${JSON.stringify(boundary)}) {console.log('BOUNDARY');setInterval(()=>{},1000);await new Promise(()=>{});}
}});
await tx.run(${JSON.stringify(b.library)},false,async(s)=>s.commit(await s.capture(),Buffer.from(${JSON.stringify(p.bytes.toString("base64"))},'base64'),${JSON.stringify(p.replacements)}.map(r=>({...r,files:r.files.map(f=>({...f,bytes:Buffer.from(f.bytes.data)}))}))));`;
}
