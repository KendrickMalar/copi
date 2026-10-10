import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = "/usr/bin/clang";
const xcrun = "/usr/bin/xcrun";
const deploymentTarget = "10.12";
const protocolVersion = 1;
const artifactName = "rename-exclusive-arm64";
const maxOutputBytes = 64 * 1024;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    maxBuffer: maxOutputBytes,
  });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function failUnsupportedHost() {
  throw new Error(`Unsupported native build host ${process.platform}/${process.arch}; release helper builds require darwin/arm64`);
}

async function assertReplaceableGeneratedFile(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular generated artifact: ${filePath}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") failUnsupportedHost();

  const sdkPath = run(xcrun, ["--sdk", "macosx", "--show-sdk-path"]);
  const sdkVersion = run(xcrun, ["--sdk", "macosx", "--show-sdk-version"]);
  if (!path.isAbsolute(sdkPath)) throw new Error(`xcrun returned a non-absolute SDK path: ${sdkPath}`);
  const compilerVersion = run(compiler, ["--version"]).split("\n", 1)[0];
  const nativeDir = path.join(projectRoot, "dist", "native");
  const outputPath = path.join(nativeDir, artifactName);
  const manifestPath = `${outputPath}.manifest.json`;
  await assertReplaceableGeneratedFile(outputPath);
  await assertReplaceableGeneratedFile(manifestPath);
  await mkdir(nativeDir, { recursive: true });

  const temporaryDir = await mkdtemp(path.join(nativeDir, ".rename-exclusive-build-"));
  try {
    const temporaryBinary = path.join(temporaryDir, artifactName);
    run(compiler, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      "arm64",
      "-isysroot",
      sdkPath,
      `-mmacosx-version-min=${deploymentTarget}`,
      path.join(projectRoot, "native", "rename-exclusive.c"),
      "-o",
      temporaryBinary,
    ]);
    await chmod(temporaryBinary, 0o755);
    const binaryBytes = await readFile(temporaryBinary);
    const manifest = {
      artifact: artifactName,
      sha256: createHash("sha256").update(binaryBytes).digest("hex"),
      architecture: "arm64",
      platform: "darwin",
      protocolVersion,
      deploymentTarget,
      compiler,
      compilerVersion,
      sdkPath,
      sdkVersion,
    };
    const temporaryManifest = path.join(temporaryDir, `${artifactName}.manifest.json`);
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    await rename(temporaryBinary, outputPath);
    await rename(temporaryManifest, manifestPath);
    console.log(`Built dist/native/${artifactName} (${manifest.sha256}) for darwin/arm64`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
