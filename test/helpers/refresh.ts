import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type test from "node:test";
import { importPreparedResource, loadCatalog, prepareResource, saveCatalog } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";
import { sandbox } from "./sandbox.ts";
import type { ResourceCandidate } from "../../src/types.ts";
import { discoverResources } from "../../src/discovery.ts";

export async function refreshFixture(t: test.TestContext, kind: "instruction" | "skill" = "skill", contents = "source original\r\n日本語\n") {
  const box = await sandbox(t);
  const sourcePath = path.join(box.sourceRoot, kind === "skill" ? "bundle" : "AGENTS.md");
  if (kind === "skill") await mkdir(sourcePath);
  const sourceFile = kind === "skill" ? path.join(sourcePath, "SKILL.md") : sourcePath;
  await writeFile(sourceFile, contents);
  const candidate: ResourceCandidate = { id: "fixture", name: "Saved friendly name", kind, scope: "project", source: "project", sourceRoot: await realpath(box.sourceRoot), sourcePath: await realpath(sourcePath), destination: { kind: "project", path: kind === "skill" ? ".pi/skills/kept" : "AGENTS.md" } };
  const prepared = await prepareResource(candidate), inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(box.libraryDir, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups.push({ id: "first", name: "First group", itemIds: [item.id] }, { id: "second", name: "Second group", itemIds: [item.id] });
  await saveCatalog(box.libraryDir, catalog);
  return { ...box, item, candidate, sourceFile, file: path.join(box.libraryDir, "items", item.id, "files", path.basename(sourceFile)) };
}
export async function packageRefreshFixture(t: test.TestContext) {
  const box = await sandbox(t);
  const packageRoot = path.join(box.agentDir, "npm", "node_modules", "@fixture", "resources");
  const sourcePath = path.join(packageRoot, "skills", "declared");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@fixture/resources", pi: { skills: ["skills/*"] } }));
  await writeFile(path.join(box.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@fixture/resources@1.0.0"] }));
  const sourceFile = path.join(sourcePath, "SKILL.md"); await writeFile(sourceFile, "declared original\n");
  const options = { homeDir: box.homeDir, agentDir: box.agentDir, projectDir: box.projectDir, scopes: { home: true, project: false } };
  const candidate = (await discoverResources(options)).candidates.find(entry => entry.name === "declared"); assert.ok(candidate);
  const prepared = await prepareResource(candidate), inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(box.libraryDir, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths }); assert.ok(item);
  return { ...box, item, candidate, options, sourceFile, file: path.join(box.libraryDir, "items", item.id, "files", "SKILL.md") };
}
export type RefreshFixture = Awaited<ReturnType<typeof refreshFixture>>;
export async function refreshCustody(box: RefreshFixture) {
  return { catalog: await readFile(path.join(box.libraryDir, "catalog.json")), file: await readFile(box.file), source: await readFile(box.sourceFile) };
}
