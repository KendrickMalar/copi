import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "node:test";

export interface PlacementInput {
  libraryDir: string;
  stagePath: string;
  targetPath: string;
  expectedStage: { dev: string; ino: string };
  expectedParent: { dev: string; ino: string };
}

export interface PlacementModule {
  preflightNativeSourcePlacement(libraryDir: string): Promise<void>;
  renameExclusiveReviewedSource(input: PlacementInput): Promise<void>;
}

export interface LibraryFixture extends PlacementInput {
  stageParent: string;
  targetParent: string;
  stageBytes: Buffer;
}

export interface PackageFixture {
  root: string;
  modulePath: string;
  helperPath: string;
  manifestPath: string;
}

export interface ManifestOverrides {
  artifact?: unknown;
  sha256?: unknown;
  architecture?: unknown;
  platform?: unknown;
  protocolVersion?: unknown;
}

const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const sourceModule = path.join(projectRoot, "src", "native-placement.ts");
const releaseHelper = path.join(projectRoot, "dist", "native", "rename-exclusive-arm64");

export async function createLibraryFixture(t: TestContext): Promise<LibraryFixture> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "copi-r1b-library-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const libraryDir = path.join(fixtureRoot, "library");
  const stageParent = path.join(libraryDir, ".copi-stage");
  const targetParent = path.join(libraryDir, "sources");
  const stagePath = path.join(stageParent, "reviewed-source");
  const targetPath = path.join(targetParent, "new-source");
  const stageBytes = Buffer.from("reviewed native payload\n", "utf8");
  await mkdir(stageParent, { recursive: true });
  await mkdir(targetParent, { recursive: true });
  await writeFile(stagePath, stageBytes, { mode: 0o600 });
  const stageInfo = await stat(stagePath, { bigint: true });
  const parentInfo = await stat(targetParent, { bigint: true });
  return {
    libraryDir,
    stagePath,
    targetPath,
    expectedStage: { dev: stageInfo.dev.toString(), ino: stageInfo.ino.toString() },
    expectedParent: { dev: parentInfo.dev.toString(), ino: parentInfo.ino.toString() },
    stageParent,
    targetParent,
    stageBytes,
  };
}

export async function createPackageFixture(
  t: TestContext,
  helperBytes?: Buffer,
  manifestOverrides: ManifestOverrides = {},
): Promise<PackageFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-r1b-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, "src", "native-placement.ts");
  const nativeDir = path.join(root, "dist", "native");
  const helperPath = path.join(nativeDir, "rename-exclusive-arm64");
  const manifestPath = `${helperPath}.manifest.json`;
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(nativeDir, { recursive: true });
  await copyFile(sourceModule, modulePath);
  if (helperBytes !== undefined) await writeFile(helperPath, helperBytes, { mode: 0o755 });
  const bytesForManifest = helperBytes ?? Buffer.alloc(0);
  await writeManifest(manifestPath, bytesForManifest, manifestOverrides);
  return { root, modulePath, helperPath, manifestPath };
}

export async function writeManifest(
  manifestPath: string,
  helperBytes: Buffer,
  overrides: ManifestOverrides = {},
): Promise<void> {
  const manifest = {
    artifact: "rename-exclusive-arm64",
    sha256: createHash("sha256").update(helperBytes).digest("hex"),
    architecture: "arm64",
    platform: "darwin",
    protocolVersion: 1,
    ...overrides,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

export async function readReleaseHelper(): Promise<Buffer> {
  return readFile(releaseHelper);
}

export async function importPlacementModule(modulePath: string): Promise<PlacementModule> {
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("r1b", `${Date.now()}-${Math.random()}`);
  return await import(moduleUrl.href) as unknown as PlacementModule;
}

export async function buildMockNativeHelper(t: TestContext): Promise<Buffer> {
  const buildDir = await mkdtemp(path.join(os.tmpdir(), "copi-r1b-helper-build-"));
  t.after(() => rm(buildDir, { recursive: true, force: true }));
  const sourcePath = path.join(buildDir, "mock-helper.c");
  const outputPath = path.join(buildDir, "rename-exclusive-arm64");
  await writeFile(sourcePath, mockHelperSource, { mode: 0o600 });
  const result = spawnSync("/usr/bin/clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-arch",
    "arm64",
    "-mmacosx-version-min=10.12",
    sourcePath,
    "-o",
    outputPath,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Test-only native mock build failed (${result.status ?? result.signal}).`);
  }
  await chmod(outputPath, 0o755);
  return readFile(outputPath);
}

export async function withTestEnvironment<T>(
  values: Readonly<Record<string, string>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function fixtureIdentity(pathname: string): Promise<{ dev: string; ino: string }> {
  const info = await stat(pathname, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

const mockHelperSource = String.raw`
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_RECORD (64U * 1024U)

static unsigned char input[MAX_RECORD + 1];
static size_t input_length;

static int emit(const char *record, int status)
{
    (void)fputs(record, stdout);
    (void)fflush(stdout);
    return status;
}

static int read_one_record(void)
{
    unsigned int newline_count = 0;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, input + input_length, sizeof(input) - input_length);
        if (count == 0) break;
        if (count < 0) return 0;
        input_length += (size_t)count;
        if (input_length > MAX_RECORD) return 0;
    }
    if (input_length < 2 || input[input_length - 1] != '\n') return 0;
    for (size_t index = 0; index < input_length; index++) {
        if (input[index] == '\n') newline_count++;
    }
    input[input_length] = '\0';
    return newline_count == 1;
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "--check-exclusive-rename") == 0) {
        const char *mode = getenv("COPI_NATIVE_TEST_MODE");
        if (mode != NULL && strcmp(mode, "unsupported-volume") == 0) {
            return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"unsupported-volume\",\"errno\":45}}\n", 1);
        }
        if (mode != NULL && strcmp(mode, "filesystem-error") == 0) {
            return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"filesystem-error\",\"errno\":5}}\n", 1);
        }
        if (mode != NULL && strcmp(mode, "assert-volume-path") == 0) {
            const char *expected = getenv("COPI_EXPECT_VOLUME_PATH");
            return emit(expected != NULL && strcmp(expected, argv[2]) == 0
                ? "{\"protocolVersion\":1,\"ok\":true}\n"
                : "{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"unsupported-protocol\",\"errno\":22}}\n",
                expected != NULL && strcmp(expected, argv[2]) == 0 ? 0 : 1);
        }
        return emit("{\"protocolVersion\":1,\"ok\":true}\n", 0);
    }
    if (argc != 3 || strcmp(argv[1], "--protocol-version") != 0 || strcmp(argv[2], "1") != 0 || !read_one_record()) {
        return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"invalid-request\",\"errno\":22}}\n", 1);
    }
    const char *mode = getenv("COPI_NATIVE_TEST_MODE");
    if (mode == NULL) mode = "success";
    if (strcmp(mode, "hang") == 0) {
        for (;;) pause();
    }
    if (strcmp(mode, "signal") == 0) {
        (void)raise(SIGTERM);
        return 99;
    }
    if (strcmp(mode, "stdout-overflow") == 0 || strcmp(mode, "stderr-overflow") == 0) {
        int descriptor = strcmp(mode, "stdout-overflow") == 0 ? STDOUT_FILENO : STDERR_FILENO;
        unsigned char bytes[4096];
        memset(bytes, 'X', sizeof(bytes));
        for (size_t written = 0; written < MAX_RECORD + 1; written += sizeof(bytes)) {
            size_t remaining = MAX_RECORD + 1 - written;
            size_t count = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
            if (write(descriptor, bytes, count) < 0) return 98;
        }
        return 0;
    }
    if (strcmp(mode, "unsupported-volume") == 0) {
        return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"unsupported-volume\",\"errno\":45}}\n", 1);
    }
    if (strcmp(mode, "filesystem-exdev") == 0) {
        return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"filesystem-error\",\"errno\":18}}\n", 1);
    }
    if (strcmp(mode, "bad-json-secret") == 0) return emit("PRIVATE_RAW_NATIVE_OUTPUT\n", 0);
    if (strcmp(mode, "bad-protocol") == 0) return emit("{\"protocolVersion\":2,\"ok\":true}\n", 0);
    if (strcmp(mode, "two-records") == 0) return emit("{\"protocolVersion\":1,\"ok\":true}\n{\"protocolVersion\":1,\"ok\":true}\n", 0);
    if (strcmp(mode, "success-exit-nonzero") == 0) return emit("{\"protocolVersion\":1,\"ok\":true}\n", 1);
    if (strcmp(mode, "error-exit-zero") == 0) return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"destination-exists\",\"errno\":17}}\n", 0);
    if (strcmp(mode, "bad-error-code") == 0) return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"mystery\",\"errno\":17}}\n", 1);
    if (strcmp(mode, "bad-error-errno") == 0) return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"destination-exists\",\"errno\":18}}\n", 1);
    if (strcmp(mode, "stderr-secret") == 0) {
        (void)fputs("PRIVATE_NATIVE_STDERR_SECRET\n", stderr);
        return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"destination-exists\",\"errno\":17}}\n", 1);
    }
    if (strcmp(mode, "assert-identities") == 0) {
        char expected[256];
        const char *stageDev = getenv("COPI_EXPECT_STAGE_DEV");
        const char *stageIno = getenv("COPI_EXPECT_STAGE_INO");
        const char *parentDev = getenv("COPI_EXPECT_PARENT_DEV");
        const char *parentIno = getenv("COPI_EXPECT_PARENT_INO");
        if (stageDev == NULL || stageIno == NULL || parentDev == NULL || parentIno == NULL) return 97;
        (void)snprintf(expected, sizeof(expected), "\"expectedStage\":{\"dev\":\"%s\",\"ino\":\"%s\"}", stageDev, stageIno);
        if (strstr((const char *)input, expected) == NULL) {
            return emit("{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"unsupported-protocol\",\"errno\":22}}\n", 1);
        }
        (void)snprintf(expected, sizeof(expected), "\"expectedParent\":{\"dev\":\"%s\",\"ino\":\"%s\"}", parentDev, parentIno);
        return emit(strstr((const char *)input, expected) == NULL ? "{\"protocolVersion\":1,\"ok\":false,\"error\":{\"code\":\"unsupported-protocol\",\"errno\":22}}\n" : "{\"protocolVersion\":1,\"ok\":true}\n", strstr((const char *)input, expected) == NULL ? 1 : 0);
    }
    return emit("{\"protocolVersion\":1,\"ok\":true}\n", 0);
}
`;
