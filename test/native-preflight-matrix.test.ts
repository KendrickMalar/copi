import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importResource, loadCatalog, saveCatalog } from "../src/catalog.ts";
import { commitMigration, prepareMigration, readMigration } from "../src/migration.ts";
import { StorageTransactions } from "../src/storage-transaction.ts";
import type { Catalog, ResourceCandidate, SavedItem } from "../src/types.ts";
import { acquireRootLease } from "../src/storage-root-lease.ts";
import type { StorageSession } from "../src/storage-transaction.ts";

const helperPath = path.resolve("dist/native/rename-exclusive-arm64");
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const childProcess = createRequire(import.meta.url)("node:child_process") as { spawn: typeof spawn };
const fsPromises = createRequire(import.meta.url)("node:fs/promises") as { lstat: typeof lstat; mkdir: typeof mkdir };

type Simulation = "unsupported-arch" | "unsupported-fs" | "helper-missing" | "fs-unknown";
type NodeEntry = {
  path: string; kind: "directory" | "file" | "symlink" | "special";
  dev: string; ino: string; mode: number; size: string; mtimeNs: string; ctimeNs: string;
  sha256: string | null; bytesBase64: string | null; linkTarget: string | null;
};
type Inventory = { exists: boolean; entries: NodeEntry[] };

async function inventory(root: string): Promise<Inventory> {
  const entries: NodeEntry[] = [];
  async function visit(target: string, relative: string): Promise<void> {
    const stat = await lstat(target, { bigint: true });
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "special";
    const value: NodeEntry = {
      path: relative || ".", kind, dev: stat.dev.toString(), ino: stat.ino.toString(),
      mode: Number(stat.mode & 0o7777n), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
      sha256: null, bytesBase64: null, linkTarget: null,
    };
    if (kind === "file") {
      const bytes = await readFile(target);
      value.sha256 = sha256(bytes);
      value.bytesBase64 = bytes.toString("base64");
    } else if (kind === "symlink") {
      value.linkTarget = await readlink(target);
    }
    entries.push(value);
    if (kind === "directory") {
      for (const name of (await readdir(target)).sort()) {
        await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    }
  }
  try {
    await visit(root, "");
    return { exists: true, entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, entries: [] };
    throw error;
  }
}

async function createBox(t: test.TestContext, existingSources: boolean): Promise<{ home: string; library: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-r4-ff-r3-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const library = path.join(home, ".copi");
  await mkdir(path.join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  if (existingSources) {
    await mkdir(path.join(library, "sources"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(library, "catalog.json"), `${JSON.stringify({ version: 2, items: [], groups: [] }, null, 2)}\n`, { mode: 0o600 });
  }
  return { home, library };
}

function makeItem(kind: "instruction" | "skill", name: string, sourcePath: string, files: readonly { path: string; mode: number; bytes: Buffer }[]): SavedItem {
  const id = randomUUID();
  const content = kind === "skill"
    ? { kind: "tree" as const, path: `sources/${id}` }
    : { kind: "file" as const, path: `sources/${id}/${files[0]!.path}` };
  return {
    id, kind, source: "R4 synthetic probe", scope: "project", sourcePath,
    destination: { kind: "project", path: kind === "skill" ? `.pi/skills/${name}` : `${name}.md` },
    name, savedAt: "2026-10-09T00:00:00.000Z",
    files: files.map((file) => ({ path: file.path, mode: file.mode, sha256: sha256(file.bytes) })), content,
  };
}

async function nativeRequiredLowLevel(library: string, kind: "instruction" | "skill", sourcePath: string): Promise<void> {
  const name = `low-${kind}`;
  const files = kind === "skill"
    ? [{ path: "SKILL.md", mode: 0o644, bytes: Buffer.from("# reviewed tree\n") }]
    : [{ path: `${name}.md`, mode: 0o644, bytes: Buffer.from("reviewed file\n") }];
  const item = makeItem(kind, name, sourcePath, files);
  let callbackCalls = 0;
  const kernel = new StorageTransactions({ checkpoint: () => { callbackCalls += 1; } });
  await kernel.run(library, true, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const previous = revision.catalog === null
      ? { version: 2 as const, items: [], groups: [] }
      : JSON.parse(Buffer.from(revision.catalog, "base64").toString("utf8")) as Catalog;
    const next = structuredClone(previous);
    next.items.push(item);
    await session.commit(revision, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), [{ itemId: item.id, files }]);
  }, { requiresNativePlacement: true });
  assert.equal(callbackCalls, 0);
}

async function createHighLevelCandidate(home: string, kind: "instruction" | "skill"): Promise<ResourceCandidate> {
  const name = `high-${kind}`;
  const sourceRoot = path.join(home, `origin-${kind}`);
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  const sourcePath = kind === "skill" ? sourceRoot : path.join(sourceRoot, `${name}.md`);
  if (kind === "skill") await writeFile(path.join(sourceRoot, "SKILL.md"), "# high-level reviewed tree\n", { mode: 0o644 });
  else await writeFile(sourcePath, "high-level reviewed file\n", { mode: 0o644 });
  return {
    id: `candidate-${name}`, kind, source: "R4 synthetic probe", scope: "project",
    sourceRoot, sourcePath, name, destination: { kind: "project", path: kind === "skill" ? `.pi/skills/${name}` : `${name}.md` },
  };
}

async function highLevelImport(library: string, candidate: ResourceCandidate): Promise<void> {
  await importResource(library, candidate, { confirmed: true, groupIds: [] });
}

async function withSimulation<T>(
  mode: Simulation,
  mockHelper: string,
  operation: () => Promise<T>,
  watchedLibrary?: string,
): Promise<{ value?: T; error?: unknown; capabilitySpawnCalls: number; placementSpawnCalls: number; transactionLockCreateCalls: number }> {
  const originalSpawn = childProcess.spawn;
  const originalLstat = fsPromises.lstat;
  const originalMkdir = fsPromises.mkdir;
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  const priorMode = process.env.COPI_NATIVE_TEST_MODE;
  let capabilitySpawnCalls = 0;
  let placementSpawnCalls = 0;
  let transactionLockCreateCalls = 0;
  if (mode === "unsupported-arch") Object.defineProperty(process, "arch", { configurable: true, value: "x64" });
  if (mode === "unsupported-fs") process.env.COPI_NATIVE_TEST_MODE = "unsupported-volume";
  if (mode === "fs-unknown") process.env.COPI_NATIVE_TEST_MODE = "filesystem-error";
  if (mode === "helper-missing") {
    fsPromises.lstat = ((target: Parameters<typeof lstat>[0], ...args: Parameters<typeof lstat> extends [unknown, ...infer Rest] ? Rest : never) => {
      if (path.resolve(String(target)) === helperPath) {
        return Promise.reject(Object.assign(new Error("simulated missing packaged helper"), { code: "ENOENT" })) as ReturnType<typeof lstat>;
      }
      return Reflect.apply(originalLstat, fsPromises, [target, ...args]) as ReturnType<typeof lstat>;
    }) as typeof lstat;
  }
  fsPromises.mkdir = ((target: Parameters<typeof mkdir>[0], ...args: Parameters<typeof mkdir> extends [unknown, ...infer Rest] ? Rest : never) => {
    if (watchedLibrary && path.resolve(String(target)) === path.join(watchedLibrary, ".copi-transaction")) transactionLockCreateCalls += 1;
    return Reflect.apply(originalMkdir, fsPromises, [target, ...args]) as ReturnType<typeof mkdir>;
  }) as typeof mkdir;
  childProcess.spawn = ((command: Parameters<typeof spawn>[0], args?: readonly string[], options?: SpawnOptions) => {
    if (path.resolve(String(command)) === helperPath && args?.[0] === "--check-exclusive-rename") {
      capabilitySpawnCalls += 1;
      return Reflect.apply(originalSpawn, childProcess, [mockHelper, args, options]) as ChildProcess;
    }
    if (path.resolve(String(command)) === helperPath && args?.[0] === "--protocol-version") {
      placementSpawnCalls += 1;
      return Reflect.apply(originalSpawn, childProcess, [mockHelper, args, options]) as ChildProcess;
    }
    return Reflect.apply(originalSpawn, childProcess, [command, args, options]) as ChildProcess;
  }) as typeof spawn;
  syncBuiltinESMExports();
  try {
    try {
      return { value: await operation(), capabilitySpawnCalls, placementSpawnCalls, transactionLockCreateCalls };
    } catch (error) {
      return { error, capabilitySpawnCalls, placementSpawnCalls, transactionLockCreateCalls };
    }
  } finally {
    childProcess.spawn = originalSpawn;
    fsPromises.lstat = originalLstat;
    fsPromises.mkdir = originalMkdir;
    if (originalArch === undefined) Reflect.deleteProperty(process, "arch");
    else Object.defineProperty(process, "arch", originalArch);
    if (priorMode === undefined) delete process.env.COPI_NATIVE_TEST_MODE;
    else process.env.COPI_NATIVE_TEST_MODE = priorMode;
    syncBuiltinESMExports();
  }
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = Reflect.get(error, "code");
  if (typeof code === "string") return code;
  if (error instanceof AggregateError) {
    for (const child of error.errors) {
      const nested = errorCode(child);
      if (nested) return nested;
    }
  }
  return error.cause === undefined ? null : errorCode(error.cause);
}


const requiredMatrix: readonly { id: string; api: "low" | "high"; existingSources: boolean; kind: "instruction" | "skill" }[] = [
  { id: "low-new-sources-root", api: "low", existingSources: false, kind: "instruction" },
  { id: "low-new-file-item-parent", api: "low", existingSources: true, kind: "instruction" },
  { id: "low-new-tree-target", api: "low", existingSources: true, kind: "skill" },
  { id: "high-missing-library-file-import", api: "high", existingSources: false, kind: "instruction" },
  { id: "high-existing-sources-tree-import", api: "high", existingSources: true, kind: "skill" },
];
const simulations: readonly Simulation[] = ["unsupported-arch", "unsupported-fs", "helper-missing", "fs-unknown"];
const expectedCodes: Record<Simulation, string> = {
  "unsupported-arch": "unsupported-platform", "unsupported-fs": "unsupported-volume",
  "helper-missing": "helper-unavailable", "fs-unknown": "filesystem-error",
};

async function createFailureMock(t: test.TestContext, label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `copi-r4-ff-r3-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mockPath = path.join(root, "native-helper.sh");
  const script = `#!/bin/sh\nif [ "$1" = "--protocol-version" ]; then /bin/cat >/dev/null; fi\ncase "$COPI_NATIVE_TEST_MODE" in\n  unsupported-volume) printf '%s\\n' '{"protocolVersion":1,"ok":false,"error":{"code":"unsupported-volume","errno":45}}'; exit 1 ;;\n  filesystem-error) printf '%s\\n' '{"protocolVersion":1,"ok":false,"error":{"code":"filesystem-error","errno":5}}'; exit 1 ;;\n  *) printf '%s\\n' '{"protocolVersion":1,"ok":true}'; exit 0 ;;\nesac\n`;
  await writeFile(mockPath, script, { mode: 0o700 });
  await chmod(mockPath, 0o700);
  return mockPath;
}

test("R4-FF-T native-required path × failure simulation preserves complete HOME/library inventory", async (t) => {
  const mockHelper = await createFailureMock(t, "native-mock");

  for (const entry of requiredMatrix) for (const simulation of simulations) {
    await t.test(`${entry.id}/${simulation}`, async (subtest) => {
      const box = await createBox(subtest, entry.existingSources);
      const candidate = entry.api === "high" ? await createHighLevelCandidate(box.home, entry.kind) : undefined;
      const homeBefore = await inventory(box.home);
      const libraryBefore = await inventory(box.library);
      const result = await withSimulation(simulation, mockHelper, () => entry.api === "low"
        ? nativeRequiredLowLevel(box.library, entry.kind, path.join(box.home, "deleted-origin", "payload"))
        : highLevelImport(box.library, candidate!));
      const homeAfter = await inventory(box.home);
      const libraryAfter = await inventory(box.library);
      const row = {
        case: entry.id, api: entry.api,
        simulation, errorCode: errorCode(result.error), capabilitySpawnCalls: result.capabilitySpawnCalls,
        placementSpawnCalls: result.placementSpawnCalls, homeBefore, homeAfter, libraryBefore, libraryAfter,
        transactionLockAbsent: !(await lstat(path.join(box.library, ".copi-transaction")).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))),
        recoveryLockAbsent: !(await lstat(path.join(box.library, ".copi-transaction-recovery")).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))),
      };
      assert.equal(errorCode(result.error), expectedCodes[simulation]);
      assert.equal(result.capabilitySpawnCalls, simulation === "unsupported-fs" || simulation === "fs-unknown" ? 1 : 0);
      assert.equal(result.placementSpawnCalls, 0, "a failed preflight must stop before real placement");
      assert.deepEqual(homeAfter, homeBefore, "all HOME nodes/stat fields/bytes must remain identical");
      assert.deepEqual(libraryAfter, libraryBefore, "all library nodes/stat fields/bytes must remain identical");
      assert.equal(row.transactionLockAbsent, true, "no transaction lock may be created");
      assert.equal(row.recoveryLockAbsent, true, "no recovery lock may be created");
    });
  }
});

async function createExistingFileFixture(t: test.TestContext, home: string): Promise<{ library: string; item: SavedItem; oldBytes: Buffer; newBytes: Buffer }> {
  const library = path.join(home, ".copi");
  await mkdir(path.join(library, "sources"), { recursive: true, mode: 0o700 });
  const oldBytes = Buffer.from("before replacement\n");
  const newBytes = Buffer.from("after replacement\n");
  const item = makeItem("instruction", "Existing replacement", "/deleted/origin/item.md", [{ path: "item.md", mode: 0o644, bytes: oldBytes }]);
  const target = path.join(library, ...item.content.path.split("/"));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, oldBytes, { mode: 0o600 });
  const catalog: Catalog = { version: 2, items: [item], groups: [] };
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  return { library, item, oldBytes, newBytes };
}

async function nonNativeMetadataWrite(library: string): Promise<void> {
  const catalog = await loadCatalog(library);
  assert.equal(catalog.version, 2);
  catalog.groups.push({ id: "r4-r3-metadata", name: "Metadata probe", itemIds: [] });
  await saveCatalog(library, catalog);
}

async function nonNativeExistingReplacement(library: string, item: SavedItem, newBytes: Buffer): Promise<void> {
  const kernel = new StorageTransactions();
  await kernel.run(library, false, async (session) => {
    assert.ok(session);
    const revision = await session.capture();
    const previous = JSON.parse(Buffer.from(revision.catalog!, "base64").toString("utf8")) as Catalog;
    const next = structuredClone(previous);
    const replacementItem = next.items.find((entry) => entry.id === item.id)!;
    replacementItem.files[0]!.sha256 = sha256(newBytes);
    const files = [{ path: "item.md", mode: 0o644, bytes: newBytes }];
    await session.commit(revision, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), [{ itemId: item.id, files }]);
  }, { requiresNativePlacement: false });
}

async function nonNativeAdoptOnlyMigration(library: string): Promise<void> {
  const sourceBytes = Buffer.from("existing adopt-only source\n");
  const sourceRoot = path.join(library, "sources", "current");
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(sourceRoot, "AGENTS.md");
  await writeFile(sourcePath, sourceBytes, { mode: 0o640 });
  const item = {
    id: "123e4567-e89b-42d3-a456-426614174000", kind: "instruction", source: "synthetic origin", scope: "project",
    sourcePath, destination: { kind: "project", path: "AGENTS.md" }, name: "Existing adopted item",
    savedAt: "2026-10-09T00:00:00.000Z",
    files: [{ path: "AGENTS.md", mode: 0o640, sha256: sha256(sourceBytes) }],
  };
  const legacy = { version: 1, items: [item], groups: [] };
  await writeFile(path.join(library, "catalog.json"), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  const snapshot = path.join(library, "items", item.id, "files", "AGENTS.md");
  await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
  await writeFile(snapshot, sourceBytes, { mode: 0o640 });
  const plan = await prepareMigration(library);
  const view = readMigration(plan);
  assert.equal(view.status, "ready", JSON.stringify(view.conflicts));
  await commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  const result = await loadCatalog(library);
  assert.equal(result.version, 2);
  assert.deepEqual((await readFile(sourcePath)), sourceBytes);
}

test("native-unneeded metadata/replacement/adopt-only mutations are not blocked by the four native failure conditions", async (t) => {
  const mockHelper = await createFailureMock(t, "nonnative-mock");
  const operations = ["metadata", "existing-replacement", "adopt-only-migration"] as const;
  for (const operation of operations) for (const simulation of simulations) {
    await t.test(`${operation}/${simulation}`, async (subtest) => {
      const box = await createBox(subtest, false);
      let result: { value?: unknown; error?: unknown; capabilitySpawnCalls: number; placementSpawnCalls: number; transactionLockCreateCalls: number };
      if (operation === "metadata") {
        await mkdir(box.library, { recursive: true, mode: 0o700 });
        await writeFile(path.join(box.library, "catalog.json"), `${JSON.stringify({ version: 2, items: [], groups: [] }, null, 2)}\n`, { mode: 0o600 });
        result = await withSimulation(simulation, mockHelper, () => nonNativeMetadataWrite(box.library));
        const catalog = await loadCatalog(box.library);
        assert.equal(catalog.version, 2);
        assert.deepEqual(catalog.groups.map((group) => group.name), ["Metadata probe"]);
      } else if (operation === "existing-replacement") {
        const fixture = await createExistingFileFixture(subtest, box.home);
        result = await withSimulation(simulation, mockHelper, () => nonNativeExistingReplacement(fixture.library, fixture.item, fixture.newBytes));
        assert.deepEqual(await readFile(path.join(fixture.library, ...fixture.item.content.path.split("/"))), fixture.newBytes);
      } else {
        await mkdir(box.library, { recursive: true, mode: 0o700 });
        result = await withSimulation(simulation, mockHelper, () => nonNativeAdoptOnlyMigration(box.library));
        const catalog = await loadCatalog(box.library);
        assert.equal(catalog.version, 2);
        assert.ok(await lstat(path.join(box.library, ".migration-backups")));
      }
      assert.equal(result.error, undefined, `native-unneeded ${operation} must not be gated: ${String(result.error)}`);
      assert.equal(result.capabilitySpawnCalls, 0, "native-unneeded operations must not probe the native helper");
      assert.equal(result.placementSpawnCalls, 0, "native-unneeded operations must not call native placement");
    });
  }
});

function withoutTemporaryLockRootTimes(value: Inventory, rootPath: string): Inventory {
  return {
    exists: value.exists,
    entries: value.entries.map((entry) => entry.path === rootPath
      ? { ...entry, mtimeNs: "<temporary-lock-root-mtime>", ctimeNs: "<temporary-lock-root-ctime>" }
      : entry),
  };
}

async function exerciseRuntimeOption(
  library: string,
  item: SavedItem,
  files: readonly { path: string; mode: number; bytes: Buffer }[],
  option: "omitted" | "false",
  checkpoints: string[],
  onCallback: () => void,
): Promise<void> {
  const kernel = new StorageTransactions({ checkpoint: (point) => { checkpoints.push(point); } });
  const operation = async (session: StorageSession | undefined): Promise<void> => {
    onCallback();
    assert.ok(session);
    const revision = await session.capture();
    const previous = JSON.parse(Buffer.from(revision.catalog!, "base64").toString("utf8")) as Catalog;
    const next = structuredClone(previous);
    next.items.push(item);
    await session.commit(revision, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), [{ itemId: item.id, files }]);
  };
  if (option === "omitted") {
    // Deliberately model a JavaScript/runtime caller; the TypeScript API now requires this argument.
    const runWithoutOptions = kernel.run as unknown as (
      libraryDir: string,
      create: boolean,
      operation: (session: StorageSession | undefined) => Promise<void>,
    ) => Promise<void>;
    await runWithoutOptions.call(kernel, library, true, operation);
  } else {
    await kernel.run(library, true, operation, { requiresNativePlacement: false });
  }
}

test("omitted and false runtime declarations reject new-item placement before payload/stage/journal writes", async (t) => {
  const mockHelper = await createFailureMock(t, "runtime-option-mock");
  for (const option of ["omitted", "false"] as const) for (const simulation of simulations) {
    await t.test(`${option}/${simulation}`, async (subtest) => {
      const box = await createBox(subtest, false);
      await mkdir(box.library, { recursive: true, mode: 0o700 });
      await writeFile(path.join(box.library, "catalog.json"), `${JSON.stringify({ version: 2, items: [], groups: [] }, null, 2)}\n`, { mode: 0o600 });
      const sourceFile = path.join(box.home, `runtime-option-origin-${option}.md`);
      const bytes = Buffer.from(`runtime option ${option} probe\n`);
      const files = [{ path: `Runtime ${option}.md`, mode: 0o644, bytes }];
      const item = makeItem("instruction", `Runtime ${option} ${simulation}`, sourceFile, files);
      const homeBefore = await inventory(box.home);
      const libraryBefore = await inventory(box.library);
      let callbackCalls = 0;
      const checkpoints: string[] = [];
      const result = await withSimulation(simulation, mockHelper, () =>
        exerciseRuntimeOption(box.library, item, files, option, checkpoints, () => { callbackCalls += 1; }), box.library);
      const libraryAfter = await inventory(box.library);
      const homeAfter = await inventory(box.home);
      const transactionLockPath = path.join(box.library, ".copi-transaction");
      const recoveryLockPath = path.join(box.library, ".copi-transaction-recovery");
      const transactionLockAbsent = await lstat(transactionLockPath).then(() => false).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? true : Promise.reject(error));
      const recoveryLockAbsent = await lstat(recoveryLockPath).then(() => false).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? true : Promise.reject(error));
      const reacquiredLease = await acquireRootLease(box.library, 0);
      await reacquiredLease.close();
      assert.equal(errorCode(result.error), expectedCodes[simulation]);
      assert.equal(callbackCalls, 1, "the runtime adapter reaches the low-level commit boundary");
      assert.deepEqual(checkpoints, [], "preflight must reject before any payload, stage, or journal checkpoint");
      assert.equal(result.capabilitySpawnCalls, simulation === "unsupported-fs" || simulation === "fs-unknown" ? 1 : 0);
      assert.equal(result.placementSpawnCalls, 0, "failed preflight must not attempt native placement");
      assert.equal(result.transactionLockCreateCalls, 1, "the direct adapter temporarily creates its transaction lock");
      assert.equal(transactionLockAbsent, true, "temporary transaction lock must be cleaned before run() returns");
      assert.equal(recoveryLockAbsent, true, "no recovery claim may remain");
      assert.deepEqual(withoutTemporaryLockRootTimes(libraryAfter, "."), withoutTemporaryLockRootTimes(libraryBefore, "."), "payload, catalog, stage, journal, and all non-root metadata remain unchanged");
      assert.deepEqual(withoutTemporaryLockRootTimes(homeAfter, ".copi"), withoutTemporaryLockRootTimes(homeBefore, ".copi"), "only the documented library-root timestamps may reflect temporary lock creation/removal");
    });
  }
});
