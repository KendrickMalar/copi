import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, open, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const protocolVersion = 1;
const helperName = "rename-exclusive-arm64";
const maxRecordBytes = 64 * 1024;
const maxHelperBytes = 16 * 1024 * 1024;
const maxManifestBytes = 64 * 1024;
const helperTimeoutMs = 30_000;
const uint64Maximum = 18_446_744_073_709_551_615n;
const arm64CpuType = 0x0100000c;
const machO64Magic = 0xfeedfacf;
const machOExecuteFileType = 2;
const lcMain = 0x80000028;
const lcUnixThread = 0x5;

type NativeErrorCode =
  | "invalid-request"
  | "unsupported-protocol"
  | "unsafe-path"
  | "destination-exists"
  | "unsupported-volume"
  | "parent-identity-mismatch"
  | "stage-identity-mismatch"
  | "filesystem-error"
  | "post-placement-identity-mismatch";

type PlacementErrorCode =
  | "invalid-input"
  | "unsupported-platform"
  | "unsafe-path"
  | "stage-identity-mismatch"
  | "parent-identity-mismatch"
  | "filesystem-error"
  | "helper-unavailable"
  | "helper-invalid"
  | "helper-spawn-failed"
  | "helper-timeout"
  | "helper-output-limit"
  | "helper-protocol-invalid"
  | "helper-signal"
  | NativeErrorCode;

export interface RenameExclusiveReviewedSourceInput {
  libraryDir: string;
  stagePath: string;
  targetPath: string;
  expectedStage: { dev: string; ino: string };
  expectedParent: { dev: string; ino: string };
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface ValidatedInput extends RenameExclusiveReviewedSourceInput {
  stageIdentity: FileIdentity;
  parentIdentity: FileIdentity;
  requestBytes: Buffer;
}

interface HelperPaths {
  packageRoot: string;
  helperPath: string;
  manifestPath: string;
}

interface CheckedPackageFile {
  bytes: Buffer;
  mode: number;
}

interface NativeSuccess {
  protocolVersion: 1;
  ok: true;
}

interface NativeFailure {
  protocolVersion: 1;
  ok: false;
  error: { code: NativeErrorCode; errno: number };
}

class NativePlacementError extends Error {
  readonly code: PlacementErrorCode;
  readonly errno: number | undefined;

  constructor(code: PlacementErrorCode, message: string, errno?: number) {
    super(message);
    this.name = "NativePlacementError";
    this.code = code;
    this.errno = errno;
  }
}

const knownErrnos = new Set(Object.values(osConstants.errno).filter(Number.isInteger));

function placementError(code: PlacementErrorCode, errno?: number): NativePlacementError {
  const message = code === "filesystem-error" || code === "post-placement-identity-mismatch"
    ? "Native source placement failed in the filesystem."
    : code === "invalid-input"
      ? "Native source-placement input is invalid."
      : code === "unsupported-platform"
        ? "Native source placement requires macOS arm64."
        : code === "unsafe-path"
          ? "Native source-placement paths are unsafe."
          : code === "stage-identity-mismatch"
            ? "The reviewed stage identity no longer matches."
            : code === "parent-identity-mismatch"
              ? "The reviewed target parent identity no longer matches."
              : code === "helper-unavailable"
                ? "The required packaged native source-placement helper is unavailable."
                : code === "helper-invalid"
                  ? "The packaged native source-placement helper is invalid."
                  : code === "helper-spawn-failed"
                    ? "The native source-placement helper could not be started."
                    : code === "helper-timeout"
                      ? "The native source-placement helper timed out."
                      : code === "helper-output-limit"
                        ? "The native source-placement helper exceeded the output limit."
                        : code === "helper-protocol-invalid"
                          ? "The native source-placement helper returned an invalid protocol response."
                          : code === "helper-signal"
                            ? "The native source-placement helper terminated by signal."
                            : code === "destination-exists"
                              ? "The source placement destination already exists."
                              : code === "unsupported-volume"
                                ? "The volume does not support exclusive native source placement."
                                : "The native source-placement request was rejected.";
  return new NativePlacementError(code, message, errno);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasRequiredKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(record, key));
}

function asNativePlacementError(error: unknown, fallback: PlacementErrorCode): NativePlacementError {
  if (error instanceof NativePlacementError) return error;
  return placementError(fallback, systemErrno(error));
}

function systemErrno(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const numericErrno = error.errno;
  if (typeof numericErrno === "number" && Number.isInteger(numericErrno)) return Math.abs(numericErrno);
  const code = error.code;
  if (typeof code === "string") {
    const errno = osConstants.errno[code as keyof typeof osConstants.errno];
    if (typeof errno === "number") return errno;
  }
  return undefined;
}

function parseIdentity(value: unknown): FileIdentity | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["dev", "ino"])) return undefined;
  const parseValue = (part: unknown): bigint | undefined => {
    if (typeof part !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(part)) return undefined;
    try {
      const parsed = BigInt(part);
      return parsed <= uint64Maximum ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const dev = parseValue(value.dev);
  const ino = parseValue(value.ino);
  if (dev === undefined || ino === undefined) return undefined;
  return { dev, ino };
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value) || value.includes("\0") || value.includes("\\")) {
    return false;
  }
  if (path.resolve(value) !== value || Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  return true;
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithin(root: string, candidate: string): boolean {
  return root === candidate || strictlyContains(root, candidate);
}

function inputRequestBytes(input: RenameExclusiveReviewedSourceInput): Buffer {
  const request = {
    protocolVersion,
    operation: "renameExclusiveReviewedSource",
    libraryDir: input.libraryDir,
    stagePath: input.stagePath,
    targetPath: input.targetPath,
    expectedStage: input.expectedStage,
    expectedParent: input.expectedParent,
  };
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (bytes.length > maxRecordBytes) throw placementError("invalid-input");
  return bytes;
}

function validateInput(value: unknown): ValidatedInput {
  if (!isRecord(value) || !hasRequiredKeys(value, ["libraryDir", "stagePath", "targetPath", "expectedStage", "expectedParent"])) {
    throw placementError("invalid-input");
  }
  if (!isCanonicalAbsolutePath(value.libraryDir) || value.libraryDir === path.parse(value.libraryDir).root ||
      !isCanonicalAbsolutePath(value.stagePath) || !isCanonicalAbsolutePath(value.targetPath)) {
    throw placementError("unsafe-path");
  }
  const stageIdentity = parseIdentity(value.expectedStage);
  const parentIdentity = parseIdentity(value.expectedParent);
  if (stageIdentity === undefined || parentIdentity === undefined) throw placementError("invalid-input");
  if (!strictlyContains(value.libraryDir, value.stagePath) || !strictlyContains(value.libraryDir, value.targetPath) ||
      !isWithin(value.libraryDir, path.dirname(value.stagePath)) || !isWithin(value.libraryDir, path.dirname(value.targetPath)) ||
      value.stagePath === value.targetPath || strictlyContains(value.stagePath, value.targetPath) ||
      strictlyContains(value.targetPath, value.stagePath)) {
    throw placementError("unsafe-path");
  }
  const validated: RenameExclusiveReviewedSourceInput = {
    libraryDir: value.libraryDir,
    stagePath: value.stagePath,
    targetPath: value.targetPath,
    expectedStage: { dev: stageIdentity.dev.toString(), ino: stageIdentity.ino.toString() },
    expectedParent: { dev: parentIdentity.dev.toString(), ino: parentIdentity.ino.toString() },
  };
  return {
    ...validated,
    stageIdentity,
    parentIdentity,
    requestBytes: inputRequestBytes(validated),
  };
}

async function pathInfoWithoutSymlinks(pathname: string): Promise<BigIntStats> {
  const root = path.parse(pathname).root;
  let current = root;
  let info = await lstat(current, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw placementError("unsafe-path");
  const components = pathname.slice(root.length).split(path.sep).filter((component) => component.length > 0);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw placementError("unsafe-path");
    if (index < components.length - 1 && !info.isDirectory()) throw placementError("unsafe-path");
  }
  return info;
}

async function assertLibraryAndFilesystem(input: ValidatedInput): Promise<void> {
  let rootInfo: BigIntStats;
  let stageInfo: BigIntStats;
  let stageParentInfo: BigIntStats;
  let targetParentInfo: BigIntStats;
  try {
    rootInfo = await pathInfoWithoutSymlinks(input.libraryDir);
    stageInfo = await pathInfoWithoutSymlinks(input.stagePath);
    stageParentInfo = await pathInfoWithoutSymlinks(path.dirname(input.stagePath));
    targetParentInfo = await pathInfoWithoutSymlinks(path.dirname(input.targetPath));
  } catch (error) {
    if (error instanceof NativePlacementError) throw error;
    const errno = systemErrno(error);
    const code = errno === osConstants.errno.ENOENT
      ? (error instanceof Error && error.message.includes(input.stagePath) ? "stage-identity-mismatch" : "unsafe-path")
      : "unsafe-path";
    throw placementError(code, errno);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw placementError("unsafe-path");
  if (await realpath(input.libraryDir).catch(() => "") !== input.libraryDir) throw placementError("unsafe-path");
  if (!stageInfo.isFile() && !stageInfo.isDirectory()) throw placementError("stage-identity-mismatch");
  if (!stageParentInfo.isDirectory() || !targetParentInfo.isDirectory()) throw placementError("unsafe-path");
  if (stageInfo.dev !== input.stageIdentity.dev || stageInfo.ino !== input.stageIdentity.ino) {
    throw placementError("stage-identity-mismatch", osConstants.errno.ESTALE);
  }
  if (targetParentInfo.dev !== input.parentIdentity.dev || targetParentInfo.ino !== input.parentIdentity.ino) {
    throw placementError("parent-identity-mismatch", osConstants.errno.ESTALE);
  }
  if (rootInfo.dev !== stageInfo.dev || rootInfo.dev !== stageParentInfo.dev || rootInfo.dev !== targetParentInfo.dev) {
    throw placementError("filesystem-error", osConstants.errno.EXDEV);
  }
}

function packagePaths(): HelperPaths {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(import.meta.url);
  } catch {
    throw placementError("helper-invalid");
  }
  const moduleDirectory = path.dirname(modulePath);
  if (path.basename(moduleDirectory) !== "src") throw placementError("helper-invalid");
  const parentDirectory = path.dirname(moduleDirectory);
  const packageRoot = path.basename(parentDirectory) === "dist" ? path.dirname(parentDirectory) : parentDirectory;
  return {
    packageRoot,
    helperPath: path.join(packageRoot, "dist", "native", helperName),
    manifestPath: path.join(packageRoot, "dist", "native", `${helperName}.manifest.json`),
  };
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readCheckedPackageFile(filePath: string, maxBytes: number): Promise<CheckedPackageFile> {
  const before = await pathInfoWithoutSymlinks(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw placementError("helper-invalid");
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > BigInt(maxBytes)) {
      throw placementError("helper-invalid");
    }
    const bytes = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat({ bigint: true }), pathInfoWithoutSymlinks(filePath)]);
    if (!sameFileIdentity(opened, afterHandle) || !sameFileIdentity(opened, afterPath) || !afterPath.isFile()) {
      throw placementError("helper-invalid");
    }
    return { bytes, mode: Number(opened.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

function hasArm64ExecutableMachO(bytes: Buffer): boolean {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== machO64Magic || bytes.readInt32LE(4) !== arm64CpuType ||
      bytes.readUInt32LE(12) !== machOExecuteFileType) return false;
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandEnd = 32 + commandBytes;
  if (commandCount === 0 || commandCount > 65_536 || commandEnd > bytes.length) return false;
  let offset = 32;
  let hasExecutableEntry = false;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandEnd) return false;
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 4 !== 0 || offset + size > commandEnd) return false;
    if (command === lcMain || command === lcUnixThread) hasExecutableEntry = true;
    offset += size;
  }
  return offset === commandEnd && hasExecutableEntry;
}

async function loadPackagedHelper(): Promise<HelperPaths> {
  const paths = packagePaths();
  let artifact: CheckedPackageFile;
  try {
    artifact = await readCheckedPackageFile(paths.helperPath, maxHelperBytes);
  } catch (error) {
    if (systemErrno(error) === osConstants.errno.ENOENT) throw placementError("helper-unavailable");
    throw placementError("helper-invalid");
  }
  if ((artifact.mode & 0o111) === 0 || !hasArm64ExecutableMachO(artifact.bytes)) throw placementError("helper-invalid");
  try {
    await access(paths.helperPath, fsConstants.X_OK);
  } catch {
    throw placementError("helper-invalid");
  }

  let manifestFile: CheckedPackageFile;
  try {
    manifestFile = await readCheckedPackageFile(paths.manifestPath, maxManifestBytes);
  } catch {
    throw placementError("helper-invalid");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString("utf8")) as unknown;
  } catch {
    throw placementError("helper-invalid");
  }
  if (!isRecord(manifest) || manifest.artifact !== helperName || manifest.architecture !== "arm64" ||
      manifest.platform !== "darwin" || manifest.protocolVersion !== protocolVersion ||
      typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw placementError("helper-invalid");
  }
  const digest = createHash("sha256").update(artifact.bytes).digest("hex");
  if (digest !== manifest.sha256) throw placementError("helper-invalid");
  return paths;
}

function nativeErrnoMatches(code: NativeErrorCode, errno: number): boolean {
  const errnos = osConstants.errno;
  if (!Number.isInteger(errno) || errno <= 0 || !knownErrnos.has(errno)) return false;
  switch (code) {
    case "destination-exists":
      return errno === errnos.EEXIST;
    case "unsupported-volume":
      return errno === errnos.ENOTSUP || errno === errnos.EOPNOTSUPP;
    case "invalid-request":
    case "unsupported-protocol":
      return errno === errnos.EINVAL;
    case "unsafe-path":
      return errno === errnos.EINVAL || errno === errnos.ENOTDIR || errno === errnos.ELOOP;
    case "parent-identity-mismatch":
      return errno === errnos.ESTALE;
    case "stage-identity-mismatch":
      return errno === errnos.ENOENT || errno === errnos.ESTALE;
    case "filesystem-error":
    case "post-placement-identity-mismatch":
      return true;
  }
}

function parseNativeRecord(bytes: Buffer): NativeSuccess | NativeFailure {
  if (bytes.length === 0 || bytes.length > maxRecordBytes || bytes[bytes.length - 1] !== 0x0a ||
      bytes.includes(0x0d) || bytes.indexOf(0x0a) !== bytes.length - 1) {
    throw placementError("helper-protocol-invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.subarray(0, bytes.length - 1).toString("utf8")) as unknown;
  } catch {
    throw placementError("helper-protocol-invalid");
  }
  if (!isRecord(decoded) || decoded.protocolVersion !== protocolVersion || typeof decoded.ok !== "boolean") {
    throw placementError("helper-protocol-invalid");
  }
  if (decoded.ok) {
    if (!hasExactKeys(decoded, ["protocolVersion", "ok"])) throw placementError("helper-protocol-invalid");
    return { protocolVersion: 1, ok: true };
  }
  if (!hasExactKeys(decoded, ["protocolVersion", "ok", "error"]) || !isRecord(decoded.error) ||
      !hasExactKeys(decoded.error, ["code", "errno"]) || typeof decoded.error.code !== "string" ||
      typeof decoded.error.errno !== "number" || !Number.isInteger(decoded.error.errno) ||
      !nativeErrnoMatches(decoded.error.code as NativeErrorCode, decoded.error.errno)) {
    throw placementError("helper-protocol-invalid");
  }
  const code = decoded.error.code as NativeErrorCode;
  return { protocolVersion: 1, ok: false, error: { code, errno: decoded.error.errno } };
}

function terminate(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child === undefined) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The caller already has a stable failure to report; child runtime text is intentionally discarded.
  }
}

function runNativeHelper(paths: HelperPaths, requestBytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const startedAt = Date.now();
    let timer: NodeJS.Timeout;

    const clearDeadline = (): void => clearTimeout(timer);
    const rejectOnce = (error: NativePlacementError, killChild: boolean): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      if (killChild) terminate(child);
      reject(error);
    };
    const deadline = (): void => rejectOnce(placementError("helper-timeout"), true);

    timer = setTimeout(deadline, helperTimeoutMs);
    try {
      child = spawn(paths.helperPath, ["--protocol-version", "1"], {
        cwd: paths.packageRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectOnce(placementError("helper-spawn-failed"), false);
      return;
    }

    child.on("error", () => rejectOnce(placementError("helper-spawn-failed"), false));
    child.stdin.on("error", () => rejectOnce(placementError("helper-protocol-invalid"), true));
    child.stdout.on("error", () => rejectOnce(placementError("helper-protocol-invalid"), true));
    child.stderr.on("error", () => rejectOnce(placementError("helper-protocol-invalid"), true));
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxRecordBytes) {
        rejectOnce(placementError("helper-output-limit"), true);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxRecordBytes) rejectOnce(placementError("helper-output-limit"), true);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      clearDeadline();
      if (Date.now() - startedAt >= helperTimeoutMs) {
        rejectOnce(placementError("helper-timeout"), false);
        return;
      }
      if (signal !== null) {
        rejectOnce(placementError("helper-signal"), false);
        return;
      }
      let response: NativeSuccess | NativeFailure;
      try {
        response = parseNativeRecord(Buffer.concat(stdout, stdoutBytes));
      } catch (error) {
        rejectOnce(asNativePlacementError(error, "helper-protocol-invalid"), false);
        return;
      }
      if (response.ok) {
        if (exitCode !== 0) rejectOnce(placementError("helper-protocol-invalid"), false);
        else {
          settled = true;
          resolve();
        }
        return;
      }
      if (exitCode !== 1) {
        rejectOnce(placementError("helper-protocol-invalid"), false);
        return;
      }
      rejectOnce(placementError(response.error.code, response.error.errno), false);
    });
    child.stdin.end(requestBytes);
  });
}

export async function renameExclusiveReviewedSource(input: RenameExclusiveReviewedSourceInput): Promise<void> {
  const validated = validateInput(input);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw placementError("unsupported-platform");
  await assertLibraryAndFilesystem(validated);
  const paths = await loadPackagedHelper();
  await runNativeHelper(paths, validated.requestBytes);
}
