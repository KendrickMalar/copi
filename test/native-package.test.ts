import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = path.join(projectRoot, "dist", "native");
const releaseHelper = path.join(nativeDir, "rename-exclusive-arm64");
const manifestPath = path.join(nativeDir, "rename-exclusive-arm64.manifest.json");
const testHookArgument = "--test-insert-empty-directory-collision";
const outputLimit = 64 * 1024;

type BuildManifest = {
  artifact: string;
  sha256: string;
  architecture: string;
  platform: string;
  protocolVersion: number;
  deploymentTarget: string;
  compiler: string;
  compilerVersion: string;
  sdkPath: string;
  sdkVersion: string;
};

type NativeRequest = {
  protocolVersion: 1;
  operation: "renameExclusiveReviewedSource";
  libraryDir: string;
  stagePath: string;
  targetPath: string;
  expectedStage: { dev: string; ino: string };
  expectedParent: { dev: string; ino: string };
};

let buildResult: SpawnSyncReturns<string> | undefined;
let testHelperDirectory: string | undefined;

function buildNative(): SpawnSyncReturns<string> {
  buildResult ??= spawnSync(process.execPath, ["scripts/build-native.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: outputLimit,
  });
  return buildResult;
}

async function assertBuildSucceeded(): Promise<BuildManifest> {
  const result = buildNative();
  assert.equal(result.status, 0, `native build failed: ${result.stderr || result.stdout}`);
  return JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifest;
}

function requestFor(
  libraryDir: string,
  stagePath: string,
  targetPath: string,
  expectedStage: { dev: string; ino: string },
  expectedParent: { dev: string; ino: string },
): NativeRequest {
  return {
    protocolVersion: 1,
    operation: "renameExclusiveReviewedSource",
    libraryDir,
    stagePath,
    targetPath,
    expectedStage,
    expectedParent,
  };
}

function runHelper(
  helperPath: string,
  request: NativeRequest,
  extraArguments: readonly string[] = [],
): SpawnSyncReturns<string> {
  return spawnSync(helperPath, ["--protocol-version", "1", ...extraArguments], {
    cwd: projectRoot,
    encoding: "utf8",
    input: `${JSON.stringify(request)}\n`,
    shell: false,
    timeout: 30_000,
    maxBuffer: outputLimit,
  });
}

function outputRecord(result: SpawnSyncReturns<string>): Record<string, unknown> {
  assert.equal(result.signal, null, `helper terminated by ${result.signal}: ${result.stderr}`);
  assert.ok(result.stdout.length <= outputLimit, "helper stdout exceeded the protocol record limit");
  assert.ok(result.stderr.length <= outputLimit, "helper stderr exceeded the protocol record limit");
  assert.match(result.stdout, /^\{[^\r\n]*\}\n$/, "helper must emit exactly one JSON line");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function makeFixture(t: test.TestContext, existingTarget = false, stageParentName = "stage") {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "copi-r1a-native-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const libraryDir = path.join(fixtureRoot, "library");
  const stageParent = path.join(libraryDir, stageParentName);
  const targetParent = path.join(libraryDir, "sources");
  const stagePath = path.join(stageParent, "staged-source");
  const targetPath = path.join(targetParent, "new-source");
  await mkdir(stageParent, { recursive: true });
  await mkdir(targetParent, { recursive: true });
  await mkdir(stagePath);
  await writeFile(path.join(stagePath, "payload.txt"), "reviewed native payload\n");
  if (existingTarget) await mkdir(targetPath);
  const stageInfo = await stat(stagePath, { bigint: true });
  const parentInfo = await stat(targetParent, { bigint: true });
  const request = requestFor(
    libraryDir,
    stagePath,
    targetPath,
    { dev: stageInfo.dev.toString(), ino: stageInfo.ino.toString() },
    { dev: parentInfo.dev.toString(), ino: parentInfo.ino.toString() },
  );
  return { libraryDir, stagePath, targetPath, targetParent, request };
}

async function compileTestHelper(manifest: BuildManifest): Promise<string> {
  if (testHelperDirectory !== undefined) return path.join(testHelperDirectory, "rename-exclusive-test-helper");
  testHelperDirectory = await mkdtemp(path.join(os.tmpdir(), "copi-r1a-native-build-"));
  const output = path.join(testHelperDirectory, "rename-exclusive-test-helper");
  const source = path.join(projectRoot, "native", "rename-exclusive.c");
  const result = spawnSync("/usr/bin/clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-arch",
    "arm64",
    "-isysroot",
    manifest.sdkPath,
    "-mmacosx-version-min=10.12",
    "-DCOPI_NATIVE_TEST_HOOKS=1",
    source,
    "-o",
    output,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: outputLimit,
  });
  assert.equal(result.status, 0, `test-only native build failed: ${result.stderr || result.stdout}`);
  return output;
}

test("release builder emits a hashed arm64 helper and npm pack includes both artifacts", async () => {
  const manifest = await assertBuildSucceeded();
  const helperInfo = await lstat(releaseHelper);
  assert.ok(helperInfo.isFile());
  assert.equal(helperInfo.isSymbolicLink(), false);
  assert.notEqual(Number(helperInfo.mode & 0o111), 0, "release helper must be executable");
  assert.deepEqual(manifest, {
    artifact: "rename-exclusive-arm64",
    sha256: createHash("sha256").update(await readFile(releaseHelper)).digest("hex"),
    architecture: "arm64",
    platform: "darwin",
    protocolVersion: 1,
    deploymentTarget: "10.12",
    compiler: "/usr/bin/clang",
    compilerVersion: manifest.compilerVersion,
    sdkPath: manifest.sdkPath,
    sdkVersion: manifest.sdkVersion,
  });
  assert.match(manifest.compilerVersion, /^Apple clang version /);
  assert.ok(path.isAbsolute(manifest.sdkPath));
  const architecture = spawnSync("/usr/bin/lipo", ["-archs", releaseHelper], {
    encoding: "utf8",
    shell: false,
    maxBuffer: outputLimit,
  });
  assert.equal(architecture.status, 0, architecture.stderr);
  assert.equal(architecture.stdout.trim(), "arm64");

  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: outputLimit,
  });
  assert.equal(pack.status, 0, `npm pack dry-run failed: ${pack.stderr || pack.stdout}`);
  const packResult = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
  const packedFiles = new Set(packResult[0]?.files.map(({ path: filePath }) => filePath));
  assert.ok(packedFiles.has("dist/native/rename-exclusive-arm64"));
  assert.ok(packedFiles.has("dist/native/rename-exclusive-arm64.manifest.json"));

  const releaseStrings = spawnSync("/usr/bin/strings", [releaseHelper], {
    encoding: "utf8",
    shell: false,
    maxBuffer: outputLimit,
  });
  assert.equal(releaseStrings.status, 0, releaseStrings.stderr);
  assert.equal(releaseStrings.stdout.includes(testHookArgument), false, "release artifact must not contain test-only hooks");
});

test("protocol v1 renames the reviewed staged source and preserves its inode and bytes", async (t) => {
  const manifest = await assertBuildSucceeded();
  const fixture = await makeFixture(t);
  const before = await stat(fixture.stagePath, { bigint: true });
  const result = runHelper(releaseHelper, fixture.request);
  const record = outputRecord(result);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(record, { protocolVersion: 1, ok: true });
  const after = await stat(fixture.targetPath, { bigint: true });
  assert.equal(after.dev.toString(), before.dev.toString());
  assert.equal(after.ino.toString(), before.ino.toString());
  assert.equal(await readFile(path.join(fixture.targetPath, "payload.txt"), "utf8"), "reviewed native payload\n");
  await assert.rejects(lstat(fixture.stagePath), { code: "ENOENT" });
  assert.ok(manifest.sdkVersion.length > 0);
});

test("protocol v1 accepts JSON-escaped path components while preserving the staged source", async (t) => {
  await assertBuildSucceeded();
  const fixture = await makeFixture(t, false, "stage\nfolder");
  const result = runHelper(releaseHelper, fixture.request);
  const record = outputRecord(result);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(record, { protocolVersion: 1, ok: true });
  assert.equal(await readFile(path.join(fixture.targetPath, "payload.txt"), "utf8"), "reviewed native payload\n");
  await assert.rejects(lstat(fixture.stagePath), { code: "ENOENT" });
});

test("protocol v1 rejects a competing empty destination without altering either inode", async (t) => {
  const manifest = await assertBuildSucceeded();
  const testHelper = await compileTestHelper(manifest);
  const fixture = await makeFixture(t);
  await mkdir(fixture.targetPath);
  const beforeStage = await stat(fixture.stagePath, { bigint: true });
  const beforeTarget = await stat(fixture.targetPath, { bigint: true });
  const result = runHelper(testHelper, fixture.request, [testHookArgument]);
  const record = outputRecord(result);
  assert.notEqual(result.status, 0);
  assert.deepEqual(record, {
    protocolVersion: 1,
    ok: false,
    error: { code: "destination-exists", errno: 17 },
  });
  const afterStage = await stat(fixture.stagePath, { bigint: true });
  const afterTarget = await stat(fixture.targetPath, { bigint: true });
  assert.equal(afterStage.dev.toString(), beforeStage.dev.toString());
  assert.equal(afterStage.ino.toString(), beforeStage.ino.toString());
  assert.equal(afterTarget.dev.toString(), beforeTarget.dev.toString());
  assert.equal(afterTarget.ino.toString(), beforeTarget.ino.toString());
  assert.deepEqual(await readdir(fixture.targetPath), []);
});

test("malformed or unsupported protocol input fails before changing staged data", async (t) => {
  await assertBuildSucceeded();
  const fixture = await makeFixture(t);
  const before = await stat(fixture.stagePath, { bigint: true });
  const malformed = spawnSync(releaseHelper, ["--protocol-version", "1"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: "{not-json}\n",
    shell: false,
    timeout: 30_000,
    maxBuffer: outputLimit,
  });
  const malformedRecord = outputRecord(malformed);
  assert.notEqual(malformed.status, 0);
  assert.deepEqual(malformedRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "invalid-request", errno: 22 },
  });

  const unsupported = spawnSync(releaseHelper, ["--protocol-version", "2"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: `${JSON.stringify(fixture.request)}\n`,
    shell: false,
    timeout: 30_000,
    maxBuffer: outputLimit,
  });
  const unsupportedRecord = outputRecord(unsupported);
  assert.notEqual(unsupported.status, 0);
  assert.deepEqual(unsupportedRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "unsupported-protocol", errno: 22 },
  });

  const releaseHookAttempt = runHelper(releaseHelper, fixture.request, [testHookArgument]);
  const releaseHookRecord = outputRecord(releaseHookAttempt);
  assert.notEqual(releaseHookAttempt.status, 0);
  assert.deepEqual(releaseHookRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "invalid-request", errno: 22 },
  });

  const oversized = spawnSync(releaseHelper, ["--protocol-version", "1"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: `${" ".repeat(outputLimit)}\n`,
    shell: false,
    timeout: 30_000,
    maxBuffer: outputLimit,
  });
  const oversizedRecord = outputRecord(oversized);
  assert.notEqual(oversized.status, 0);
  assert.deepEqual(oversizedRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "invalid-request", errno: 22 },
  });

  const after = await stat(fixture.stagePath, { bigint: true });
  assert.equal(after.dev.toString(), before.dev.toString());
  assert.equal(after.ino.toString(), before.ino.toString());
  await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
});

test("unsafe root escape and symlinked parent are refused before native placement", async (t) => {
  await assertBuildSucceeded();
  const fixture = await makeFixture(t);
  const before = await stat(fixture.stagePath, { bigint: true });
  const escapeRequest = { ...fixture.request, targetPath: path.join(path.dirname(fixture.libraryDir), "outside") };
  const escape = runHelper(releaseHelper, escapeRequest);
  const escapeRecord = outputRecord(escape);
  assert.notEqual(escape.status, 0);
  assert.deepEqual(escapeRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "unsafe-path", errno: 22 },
  });

  const realTargetParent = path.join(fixture.libraryDir, "real-sources");
  await mkdir(realTargetParent);
  const aliasParent = path.join(fixture.libraryDir, "linked-sources");
  await symlink(realTargetParent, aliasParent);
  const linkedTarget = path.join(aliasParent, "new-source");
  const realTargetParentInfo = await stat(realTargetParent, { bigint: true });
  const symlinkRequest = {
    ...fixture.request,
    targetPath: linkedTarget,
    expectedParent: { dev: realTargetParentInfo.dev.toString(), ino: realTargetParentInfo.ino.toString() },
  };
  const symlinkResult = runHelper(releaseHelper, symlinkRequest);
  const symlinkRecord = outputRecord(symlinkResult);
  assert.notEqual(symlinkResult.status, 0);
  assert.deepEqual(symlinkRecord, {
    protocolVersion: 1,
    ok: false,
    error: { code: "unsafe-path", errno: 20 },
  });
  const after = await stat(fixture.stagePath, { bigint: true });
  assert.equal(after.dev.toString(), before.dev.toString());
  assert.equal(after.ino.toString(), before.ino.toString());
  await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
});

test.after(async () => {
  if (testHelperDirectory !== undefined) await rm(testHelperDirectory, { recursive: true, force: true });
});
