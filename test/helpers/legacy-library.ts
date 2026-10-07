import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LegacyCatalog, LegacySavedItem } from "../../src/types.ts";

export const legacyItemId = "123e4567-e89b-42d3-a456-426614174000";
export const legacyFileBytes = Buffer.from("legacy snapshot body\n");
export const legacyFileDigest = createHash("sha256").update(legacyFileBytes).digest("hex");

export function makeLegacyItem(overrides: Partial<LegacySavedItem> = {}): LegacySavedItem {
  return {
    id: legacyItemId,
    kind: "instruction",
    source: "synthetic-origin",
    scope: "project",
    sourcePath: "/synthetic/unavailable/origin.md",
    destination: { kind: "project", path: "AGENTS.md" },
    name: "Legacy instruction",
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "AGENTS.md", mode: 0o640, sha256: legacyFileDigest }],
    ...overrides,
  };
}

export async function createLegacyLibrary(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-legacy-preview-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

export async function writeBytes(root: string, relative: string, bytes: Buffer, mode = 0o600): Promise<string> {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode });
  await chmod(target, mode);
  return target;
}

export async function writeLegacyCatalog(root: string, items: readonly LegacySavedItem[] = [makeLegacyItem()]): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, items: [...items], groups: [] } satisfies LegacyCatalog, null, 2)}\n`);
  await writeBytes(root, "catalog.json", bytes, 0o600);
  return bytes;
}

export async function writeLegacySnapshot(root: string, bytes = legacyFileBytes, relative = `items/${legacyItemId}/files/AGENTS.md`, mode = 0o640): Promise<string> {
  return writeBytes(root, relative, bytes, mode);
}

export async function treeSnapshot(root: string): Promise<string> {
  const rows: string[] = [];
  const visit = async (target: string, relative: string): Promise<void> => {
    const stat = await lstat(target, { bigint: true });
    const prefix = `${relative || "."}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rows.push(`D:${prefix}`);
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      const bytes = await readFile(target);
      rows.push(`F:${prefix}:${createHash("sha256").update(bytes).digest("hex")}`);
    } else {
      rows.push(`S:${prefix}`);
    }
  };
  await visit(root, "");
  return rows.join("\n");
}

export function uniqueMissingPath(parent: string): string {
  return path.join(parent, `missing-${randomUUID()}`);
}
