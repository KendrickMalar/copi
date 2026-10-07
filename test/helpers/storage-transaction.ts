import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { assertModernCatalog, catalogBytes, importResource, loadCatalog } from "../../src/catalog.ts";
import { StorageTransactions, type StorageCheckpoint } from "../../src/storage-transaction.ts";
import { sandbox } from "./sandbox.ts";

export async function transactionFixture(t: TestContext) {
  const box = await sandbox(t);
  const sourcePath = path.join(box.sourceRoot, "source.md");
  await writeFile(sourcePath, "old snapshot\n");
  const candidate = { id: "fixture", kind: "instruction" as const, source: "test", scope: "project" as const, sourceRoot: box.sourceRoot, sourcePath, name: "Snapshot", destination: { kind: "project" as const, path: "AGENTS.md" } };
  const item = await importResource(box.libraryDir, candidate, { confirmed: true, groupIds: [] });
  assert.ok(item);
  const catalog = await loadCatalog(box.libraryDir);
  assertModernCatalog(catalog);
  if (item.content.kind !== "file") throw new Error("Expected a v2 single-file transaction fixture.");
  const next = structuredClone(catalog);
  const bytes = Buffer.from("new snapshot\n");
  next.items[0]!.files[0]!.sha256 = createHash("sha256").update(bytes).digest("hex");
  const files = [{ path: "source.md", mode: item.files[0]!.mode, bytes }];
  const file = path.join(box.libraryDir, ...item.content.path.split("/"));
  return { ...box, candidate, item, catalog, next, bytes, files, file };
}
export type TransactionFixture = Awaited<ReturnType<typeof transactionFixture>>;

export async function kernelCommit(box: TransactionFixture, checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>) {
  const kernel = new StorageTransactions(checkpoint ? { checkpoint } : {});
  return kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), catalogBytes(box.next), [{ itemId: box.item.id, files: box.files }]);
  });
}
export function child(box: TransactionFixture, code: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: box.projectDir, env: { ...process.env, HOME: box.homeDir, PI_CODING_AGENT_DIR: box.agentDir, TMPDIR: process.env.TMPDIR!, NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE!, NPM_CONFIG_USERCONFIG: "/dev/null" } });
}
export function childExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}
export function waitForLine(child: ChildProcessWithoutNullStreams, expected: string) {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { reject(new Error(`Child did not reach ${expected}: ${output}`)); }, 5_000);
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); if (output.includes(expected)) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); if (!output.includes(expected)) reject(new Error(`Child stopped before ${expected}: ${output}`)); });
  });
}
export function interruptedCode(box: TransactionFixture, checkpoint: StorageCheckpoint) {
  const module = new URL("../../src/storage-transaction.js", import.meta.url).href;
  return `import {StorageTransactions} from ${JSON.stringify(module)};
const kernel=new StorageTransactions({checkpoint:async(point)=>{if(point===${JSON.stringify(checkpoint)}) { console.log('PAUSED'); setInterval(()=>{},1000); await new Promise(()=>{}); }}});
await kernel.run(${JSON.stringify(box.libraryDir)},false,async(session)=>{await session.commit(await session.capture(),Buffer.from(${JSON.stringify(catalogBytes(box.next).toString("base64"))},'base64'),[{itemId:${JSON.stringify(box.item.id)},files:[{path:'source.md',mode:${box.files[0]!.mode},bytes:Buffer.from('new snapshot\\n')}]}]);});`;
}
