import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { renameExclusiveReviewedSource } from "../src/native-placement.ts";
import {
  buildMockNativeHelper,
  createLibraryFixture,
  fixtureIdentity,
  importPlacementModule,
  type ManifestOverrides,
  type PackageFixture,
  type PlacementInput,
  type PlacementModule,
  withTestEnvironment,
  writeManifest,
} from "./helpers/native-placement.ts";

const testEntryPath = fileURLToPath(import.meta.url);
const sourceTestEntry = testEntryPath.endsWith(".ts");
const compiledTestEntry = testEntryPath.endsWith(".js");
if (!sourceTestEntry && !compiledTestEntry) throw new Error(`Unsupported native-placement test entry: ${testEntryPath}`);
const projectRoot = path.resolve(path.dirname(testEntryPath), sourceTestEntry ? ".." : "../..");
const packageModuleExtension = sourceTestEntry ? ".ts" : ".js";
const packageSourceModule = sourceTestEntry
  ? path.join(projectRoot, "src", "native-placement.ts")
  : path.join(projectRoot, "dist", "src", "native-placement.js");
const nativeDirectory = path.join(projectRoot, "dist", "native");
const helperPath = path.join(nativeDirectory, "rename-exclusive-arm64");
const manifestPath = `${helperPath}.manifest.json`;
const childProcess = createRequire(import.meta.url)("node:child_process") as { spawn: typeof spawn };

function assertPlacementError(error: unknown, code: string, errno?: number): void {
  assert.ok(error instanceof Error);
  assert.equal(Reflect.get(error, "code"), code);
  if (errno !== undefined) assert.equal(Reflect.get(error, "errno"), errno);
}

async function rejectsWithCode(promise: Promise<unknown>, code: string, errno?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assertPlacementError(error, code, errno);
    return true;
  });
}

async function assertUnchanged(input: PlacementInput): Promise<void> {
  const stageIdentity = await fixtureIdentity(input.stagePath);
  assert.deepEqual(stageIdentity, input.expectedStage);
  await assert.rejects(lstat(input.targetPath), { code: "ENOENT" });
}

async function withProcessValue<K extends "arch" | "platform", T>(
  key: K,
  value: string,
  operation: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, key);
  Object.defineProperty(process, key, { configurable: true, value });
  try {
    return await operation();
  } finally {
    if (original === undefined) Reflect.deleteProperty(process, key);
    else Object.defineProperty(process, key, original);
  }
}

function unsupportedInput(input: PlacementInput, updates: Partial<PlacementInput>): PlacementInput {
  return { ...input, ...updates };
}

async function createPackageFixture(
  t: TestContext,
  helperBytes?: Buffer,
  manifestOverrides: ManifestOverrides = {},
): Promise<PackageFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-r1b-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, "src", `native-placement${packageModuleExtension}`);
  const nativeDir = path.join(root, "dist", "native");
  const helperPath = path.join(nativeDir, "rename-exclusive-arm64");
  const manifestPath = `${helperPath}.manifest.json`;
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(nativeDir, { recursive: true });
  await copyFile(packageSourceModule, modulePath);
  if (helperBytes !== undefined) await writeFile(helperPath, helperBytes, { mode: 0o755 });
  await writeManifest(manifestPath, helperBytes ?? Buffer.alloc(0), manifestOverrides);
  return { root, modulePath, helperPath, manifestPath };
}

async function readReleaseHelper(): Promise<Buffer> {
  return readFile(helperPath);
}

test("uses the packaged release helper to place a reviewed source and preserve its inode and bytes", async (t) => {
  const fixture = await createLibraryFixture(t);
  const before = await fixtureIdentity(fixture.stagePath);

  await renameExclusiveReviewedSource(fixture);

  assert.deepEqual(await fixtureIdentity(fixture.targetPath), before);
  assert.deepEqual(await readFile(fixture.targetPath), fixture.stageBytes);
  await assert.rejects(lstat(fixture.stagePath), { code: "ENOENT" });
});

test("the release helper rejects three occupied target kinds without changing source or target", async (t) => {
  const cases = ["regular-file", "directory", "symbolic-link"] as const;
  for (const targetKind of cases) {
    await t.test(targetKind, async (subtest) => {
      const fixture = await createLibraryFixture(subtest);
      if (targetKind === "regular-file") await writeFile(fixture.targetPath, "external file\n", { mode: 0o600 });
      else if (targetKind === "directory") await mkdir(fixture.targetPath);
      else {
        const linkTarget = path.join(fixture.libraryDir, "external-target");
        await writeFile(linkTarget, "external symlink target\n");
        await symlink(linkTarget, fixture.targetPath);
      }
      const beforeStage = await fixtureIdentity(fixture.stagePath);
      const beforeTarget = await lstat(fixture.targetPath, { bigint: true });
      const beforeTargetBytes = targetKind === "regular-file" ? await readFile(fixture.targetPath) : undefined;

      await rejectsWithCode(renameExclusiveReviewedSource(fixture), "destination-exists", 17);

      assert.deepEqual(await fixtureIdentity(fixture.stagePath), beforeStage);
      const afterTarget = await lstat(fixture.targetPath, { bigint: true });
      assert.equal(afterTarget.dev.toString(), beforeTarget.dev.toString());
      assert.equal(afterTarget.ino.toString(), beforeTarget.ino.toString());
      if (beforeTargetBytes !== undefined) assert.deepEqual(await readFile(fixture.targetPath), beforeTargetBytes);
      if (targetKind === "symbolic-link") assert.equal(await readlink(fixture.targetPath), path.join(fixture.libraryDir, "external-target"));
    });
  }
});

test("rejects non-canonical, unsafe, root-escaping, and overlapping input paths before mutation", async (t) => {
  const fixture = await createLibraryFixture(t);
  const invalidPaths = [
    { stagePath: "relative/stage" },
    { targetPath: path.join(fixture.libraryDir, "..", "outside") },
    { stagePath: path.dirname(fixture.libraryDir) },
    { targetPath: `${fixture.targetPath}/../other` },
    { targetPath: `${fixture.stagePath}/child` },
    { targetPath: `${fixture.libraryDir}//sources/new-source` },
  ];
  for (const update of invalidPaths) {
    await rejectsWithCode(
      renameExclusiveReviewedSource(unsupportedInput(fixture, update)),
      "unsafe-path",
    );
  }
  await assertUnchanged(fixture);
});

test("rejects symlinked library, stage, and parent paths without following them", async (t) => {
  const libraryFixture = await createLibraryFixture(t);
  const realLibrary = `${libraryFixture.libraryDir}-real`;
  await rename(libraryFixture.libraryDir, realLibrary);
  await symlink(realLibrary, libraryFixture.libraryDir);
  await rejectsWithCode(renameExclusiveReviewedSource(libraryFixture), "unsafe-path");
  assert.deepEqual(await fixtureIdentity(path.join(realLibrary, ".copi-stage", "reviewed-source")), libraryFixture.expectedStage);
  await t.test("stage symlink", async (subtest) => {
    const fixture = await createLibraryFixture(subtest);
    const original = `${fixture.stagePath}-real`;
    await rename(fixture.stagePath, original);
    await symlink(original, fixture.stagePath);
    await rejectsWithCode(renameExclusiveReviewedSource(fixture), "unsafe-path");
    assert.equal(await readFile(original, "utf8"), fixture.stageBytes.toString("utf8"));
    await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
  });
  await t.test("target parent symlink", async (subtest) => {
    const fixture = await createLibraryFixture(subtest);
    const realParent = `${fixture.targetParent}-real`;
    await rename(fixture.targetParent, realParent);
    await symlink(realParent, fixture.targetParent);
    await rejectsWithCode(renameExclusiveReviewedSource(fixture), "unsafe-path");
    assert.deepEqual(await fixtureIdentity(fixture.stagePath), fixture.expectedStage);
    await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
  });
});

test("requires canonical unsigned uint64 decimal identities and checks stage and parent inode", async (t) => {
  const fixture = await createLibraryFixture(t);
  for (const invalid of ["", "00", "01", "+1", "-1", " 1", "18446744073709551616"]) {
    await rejectsWithCode(
      renameExclusiveReviewedSource({
        ...fixture,
        expectedStage: { ...fixture.expectedStage, ino: invalid },
      }),
      "invalid-input",
    );
  }
  const wrongStageDev = fixture.expectedStage.dev === "0" ? "1" : "0";
  await rejectsWithCode(
    renameExclusiveReviewedSource({
      ...fixture,
      expectedStage: { ...fixture.expectedStage, dev: wrongStageDev },
    }),
    "stage-identity-mismatch",
  );
  const wrongParentIno = fixture.expectedParent.ino === "0" ? "1" : "0";
  await rejectsWithCode(
    renameExclusiveReviewedSource({
      ...fixture,
      expectedParent: { ...fixture.expectedParent, ino: wrongParentIno },
    }),
    "parent-identity-mismatch",
  );
  await assertUnchanged(fixture);
});

test("rejects oversized protocol input before starting the helper", async (t) => {
  const fixture = await createLibraryFixture(t);
  await rejectsWithCode(
    renameExclusiveReviewedSource({ ...fixture, targetPath: `${fixture.targetPath}${"x".repeat(64 * 1024)}` }),
    "invalid-input",
  );
  await assertUnchanged(fixture);
});

test("serializes exact decimal inode identities into one protocol-v1 stdin record", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const packageFixture = await createPackageFixture(t, mockBytes);
  const isolated = await importPlacementModule(packageFixture.modulePath);
  const fixture = await createLibraryFixture(t);
  const env = {
    COPI_NATIVE_TEST_MODE: "assert-identities",
    COPI_EXPECT_STAGE_DEV: fixture.expectedStage.dev,
    COPI_EXPECT_STAGE_INO: fixture.expectedStage.ino,
    COPI_EXPECT_PARENT_DEV: fixture.expectedParent.dev,
    COPI_EXPECT_PARENT_INO: fixture.expectedParent.ino,
  };
  await withTestEnvironment(env, () => isolated.renameExclusiveReviewedSource(fixture));
  await assertUnchanged(fixture);
});

test("read-only native preflight checks the nearest existing ancestor without creating a missing library", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-native-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, "missing", "nested", ".copi");
  const native = await importPlacementModule(packageSourceModule);
  const before = await lstat(root, { bigint: true });
  await native.preflightNativeSourcePlacement(libraryDir);
  const after = await lstat(root, { bigint: true });
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs },
    { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs },
  );
  await assert.rejects(lstat(path.join(root, "missing")), { code: "ENOENT" });
});

test("native preflight fails closed for unsupported or unknown volumes and missing helpers", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const unsupportedPackage = await createPackageFixture(t, mockBytes);
  const unsupportedModule = await importPlacementModule(unsupportedPackage.modulePath);
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-native-preflight-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, "missing", "nested", ".copi");
  await withTestEnvironment({ COPI_NATIVE_TEST_MODE: "assert-volume-path", COPI_EXPECT_VOLUME_PATH: await realpath(root) }, () => unsupportedModule.preflightNativeSourcePlacement(libraryDir));
  await assert.rejects(lstat(path.join(root, "missing")), { code: "ENOENT" });
  for (const entry of [
    { mode: "unsupported-volume", code: "unsupported-volume", errno: 45 },
    { mode: "filesystem-error", code: "filesystem-error", errno: 5 },
  ]) {
    await t.test(entry.mode, async () => {
      const before = await lstat(root, { bigint: true });
      await rejectsWithCode(
        withTestEnvironment({ COPI_NATIVE_TEST_MODE: entry.mode }, () => unsupportedModule.preflightNativeSourcePlacement(libraryDir)),
        entry.code,
        entry.errno,
      );
      const after = await lstat(root, { bigint: true });
      assert.deepEqual(
        { dev: after.dev, ino: after.ino, mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs },
        { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs },
      );
      await assert.rejects(lstat(path.join(root, "missing")), { code: "ENOENT" });
    });
  }

  const missingPackage = await createPackageFixture(t);
  const missingModule = await importPlacementModule(missingPackage.modulePath);
  await rejectsWithCode(missingModule.preflightNativeSourcePlacement(libraryDir), "helper-unavailable");
  await assert.rejects(lstat(path.join(root, "missing")), { code: "ENOENT" });
});

test("rejects non-darwin and non-arm64 writes before helper execution", async (t) => {
  const fixture = await createLibraryFixture(t);
  await withProcessValue("arch", "x64", async () => {
    await rejectsWithCode(renameExclusiveReviewedSource(fixture), "unsupported-platform");
  });
  await withProcessValue("platform", "linux", async () => {
    await rejectsWithCode(renameExclusiveReviewedSource(fixture), "unsupported-platform");
  });
  await assertUnchanged(fixture);
});

test("rejects missing or malformed packaged helpers before mutation", async (t) => {
  const releaseBytes = await readReleaseHelper();
  const fixture = await createLibraryFixture(t);
  const missingPackage = await createPackageFixture(t);
  const missingModule = await importPlacementModule(missingPackage.modulePath);
  await rejectsWithCode(missingModule.renameExclusiveReviewedSource(fixture), "helper-unavailable");

  const malformedManifest = await createPackageFixture(t, releaseBytes);
  await writeFile(malformedManifest.manifestPath, "{not-json\n", { mode: 0o600 });
  const malformedModule = await importPlacementModule(malformedManifest.modulePath);
  await rejectsWithCode(malformedModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  const invalidDeclarations: Array<{ label: string; overrides: ManifestOverrides }> = [
    { label: "artifact", overrides: { artifact: "other-helper" } },
    { label: "digest", overrides: { sha256: "0".repeat(64) } },
    { label: "architecture", overrides: { architecture: "x64" } },
    { label: "platform", overrides: { platform: "linux" } },
    { label: "protocol", overrides: { protocolVersion: 2 } },
  ];
  for (const { label, overrides } of invalidDeclarations) {
    await t.test(label, async (subtest) => {
      const packageFixture = await createPackageFixture(subtest, releaseBytes, overrides);
      const isolated = await importPlacementModule(packageFixture.modulePath);
      await rejectsWithCode(isolated.renameExclusiveReviewedSource(fixture), "helper-invalid");
    });
  }

  const nonMachOPackage = await createPackageFixture(t, Buffer.from("not a Mach-O helper", "utf8"));
  const nonMachOModule = await importPlacementModule(nonMachOPackage.modulePath);
  await rejectsWithCode(nonMachOModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  const nonExecutablePackage = await createPackageFixture(t, releaseBytes);
  await chmod(nonExecutablePackage.helperPath, 0o600);
  const nonExecutableModule = await importPlacementModule(nonExecutablePackage.modulePath);
  await rejectsWithCode(nonExecutableModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  await assertUnchanged(fixture);
});

test("rejects helper and manifest symlinks and symlinked package ancestors", async (t) => {
  const releaseBytes = await readReleaseHelper();
  const fixture = await createLibraryFixture(t);
  const helperSymlinkPackage = await createPackageFixture(t, releaseBytes);
  const externalHelper = path.join(helperSymlinkPackage.root, "external-helper");
  await rename(helperSymlinkPackage.helperPath, externalHelper);
  await symlink(externalHelper, helperSymlinkPackage.helperPath);
  const helperSymlinkModule = await importPlacementModule(helperSymlinkPackage.modulePath);
  await rejectsWithCode(helperSymlinkModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  const manifestSymlinkPackage = await createPackageFixture(t, releaseBytes);
  const externalManifest = path.join(manifestSymlinkPackage.root, "external-manifest.json");
  await rename(manifestSymlinkPackage.manifestPath, externalManifest);
  await symlink(externalManifest, manifestSymlinkPackage.manifestPath);
  const manifestSymlinkModule = await importPlacementModule(manifestSymlinkPackage.modulePath);
  await rejectsWithCode(manifestSymlinkModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  const ancestorSymlinkPackage = await createPackageFixture(t, releaseBytes);
  const realNativeDirectory = path.join(ancestorSymlinkPackage.root, "native-real");
  await rename(path.dirname(ancestorSymlinkPackage.helperPath), realNativeDirectory);
  await symlink(realNativeDirectory, path.dirname(ancestorSymlinkPackage.helperPath));
  const ancestorSymlinkModule = await importPlacementModule(ancestorSymlinkPackage.modulePath);
  await rejectsWithCode(ancestorSymlinkModule.renameExclusiveReviewedSource(fixture), "helper-invalid");

  await assertUnchanged(fixture);
});

test("reports native errno classifications without fallback or leaking helper output", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const packageFixture = await createPackageFixture(t, mockBytes);
  const isolated = await importPlacementModule(packageFixture.modulePath);
  const cases = [
    { mode: "unsupported-volume", code: "unsupported-volume", errno: 45 },
    { mode: "filesystem-exdev", code: "filesystem-error", errno: 18 },
    { mode: "stderr-secret", code: "destination-exists", errno: 17 },
  ];
  for (const entry of cases) {
    await t.test(entry.mode, async (subtest) => {
      const fixture = await createLibraryFixture(subtest);
      let caught: unknown;
      try {
        await withTestEnvironment({ COPI_NATIVE_TEST_MODE: entry.mode }, () => isolated.renameExclusiveReviewedSource(fixture));
      } catch (error) {
        caught = error;
      }
      assertPlacementError(caught, entry.code, entry.errno);
      assert.ok(caught instanceof Error);
      assert.equal(caught.message.includes("PRIVATE_NATIVE_STDERR_SECRET"), false);
      assert.deepEqual(await fixtureIdentity(fixture.stagePath), fixture.expectedStage);
      await assert.rejects(lstat(fixture.targetPath), { code: "ENOENT" });
    });
  }
});

test("rejects process signal, timeout, output overflow, malformed JSON, and exit/protocol mismatches", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const packageFixture = await createPackageFixture(t, mockBytes);
  const isolated = await importPlacementModule(packageFixture.modulePath);
  const cases = [
    { mode: "signal", code: "helper-signal" },
    { mode: "stdout-overflow", code: "helper-output-limit" },
    { mode: "stderr-overflow", code: "helper-output-limit" },
    { mode: "bad-json-secret", code: "helper-protocol-invalid" },
    { mode: "bad-protocol", code: "helper-protocol-invalid" },
    { mode: "two-records", code: "helper-protocol-invalid" },
    { mode: "success-exit-nonzero", code: "helper-protocol-invalid" },
    { mode: "error-exit-zero", code: "helper-protocol-invalid" },
    { mode: "bad-error-code", code: "helper-protocol-invalid" },
    { mode: "bad-error-errno", code: "helper-protocol-invalid" },
  ];
  for (const entry of cases) {
    await t.test(entry.mode, async (subtest) => {
      const fixture = await createLibraryFixture(subtest);
      let caught: unknown;
      try {
        await withTestEnvironment({ COPI_NATIVE_TEST_MODE: entry.mode }, () => isolated.renameExclusiveReviewedSource(fixture));
      } catch (error) {
        caught = error;
      }
      assertPlacementError(caught, entry.code);
      assert.ok(caught instanceof Error);
      assert.equal(caught.message.includes("PRIVATE_RAW_NATIVE_OUTPUT"), false);
      assert.equal(caught.message.includes("PRIVATE_NATIVE_STDERR_SECRET"), false);
      await assertUnchanged(fixture);
    });
  }

  await t.test("30-second bounded timer is shortened only by test control", async (subtest) => {
    const fixture = await createLibraryFixture(subtest);
    const originalSetTimeout = globalThis.setTimeout;
    let observedDelay: number | undefined;
    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
      if (delay === 30_000) observedDelay = delay;
      return originalSetTimeout(callback, delay === 30_000 ? 15 : delay);
    }) as typeof setTimeout;
    try {
      await rejectsWithCode(
        withTestEnvironment({ COPI_NATIVE_TEST_MODE: "hang" }, () => isolated.renameExclusiveReviewedSource(fixture)),
        "helper-timeout",
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    assert.equal(observedDelay, 30_000);
    await assertUnchanged(fixture);
  });
});

test("turns synchronous child spawn errors into stable errors without exposing raw details", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const packageFixture = await createPackageFixture(t, mockBytes);
  const isolated = await importPlacementModule(packageFixture.modulePath);
  const fixture = await createLibraryFixture(t);
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => {
    throw Object.assign(new Error("PRIVATE_SPAWN_PATH_SECRET"), { code: "ENOENT" });
  }) as typeof spawn;
  syncBuiltinESMExports();
  try {
    let caught: unknown;
    try {
      await isolated.renameExclusiveReviewedSource(fixture);
    } catch (error) {
      caught = error;
    }
    assertPlacementError(caught, "helper-spawn-failed");
    assert.ok(caught instanceof Error);
    assert.equal(caught.message.includes("PRIVATE_SPAWN_PATH_SECRET"), false);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  await assertUnchanged(fixture);
});

test("rejects protocol errors with oversized raw stdout without exposing the record", async (t) => {
  const mockBytes = await buildMockNativeHelper(t);
  const packageFixture = await createPackageFixture(t, mockBytes);
  const isolated = await importPlacementModule(packageFixture.modulePath);
  const fixture = await createLibraryFixture(t);
  await rejectsWithCode(
    withTestEnvironment({ COPI_NATIVE_TEST_MODE: "bad-json-secret" }, () => isolated.renameExclusiveReviewedSource(fixture)),
    "helper-protocol-invalid",
  );
  await assertUnchanged(fixture);
});
