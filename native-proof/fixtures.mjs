import { lstat, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const proofDir = dirname(fileURLToPath(import.meta.url));
export const scratchDir = join(proofDir, "tmp");
export const payloadName = "payload.txt";

export async function makePlacementFixture(kind) {
  await mkdir(scratchDir, { recursive: true });
  const root = await mkdtemp(join(scratchDir, `${kind}-`));
  const sourcePath = join(root, "stage");
  await mkdir(sourcePath, { mode: 0o700 });
  const sourceBytes = Buffer.from(`staged payload for ${kind}\n`);
  await writeFile(join(sourcePath, payloadName), sourceBytes, { mode: 0o600 });

  const targetParentPath = kind === "absent-sources-root" ? root : join(root, "sources");
  if (kind !== "absent-sources-root") await mkdir(targetParentPath, { mode: 0o700 });
  const targetName = kind === "absent-sources-root" ? "sources" : "item";
  const targetPath = join(targetParentPath, targetName);
  const sourceStat = await stat(sourcePath, { bigint: true });
  const sourceParentStat = await stat(root, { bigint: true });
  const targetParentStat = await stat(targetParentPath, { bigint: true });
  const rootStat = await stat(root, { bigint: true });

  return {
    kind,
    root,
    sourcePath,
    sourceParentPath: root,
    targetParentPath,
    targetParentRelative: targetParentPath === root ? "." : "sources",
    sourceParentRelative: ".",
    sourceName: "stage",
    targetName,
    targetPath,
    sourceBytes,
    sourceIdentity: { dev: sourceStat.dev.toString(), ino: sourceStat.ino.toString() },
    sourceParentIdentity: { dev: sourceParentStat.dev.toString(), ino: sourceParentStat.ino.toString() },
    targetParentIdentity: { dev: targetParentStat.dev.toString(), ino: targetParentStat.ino.toString() },
    rootIdentity: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
  };
}

export async function directorySnapshot(path) {
  const info = await lstat(path, { bigint: true });
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: Number(info.mode & 0o777n),
    isDirectory: info.isDirectory(),
    children: (await readdir(path)).sort(),
  };
}

export async function stagedPayload(path) {
  return readFile(join(path, payloadName));
}
