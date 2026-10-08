import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("captures every root node, inode, mode, file hash, and empty-directory commitment read-only", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-"));
  try {
    await mkdir(path.join(root, "items", "empty"), { recursive: true, mode: 0o751 });
    await mkdir(path.join(root, "sources"), { mode: 0o700 });
    await writeFile(path.join(root, "catalog.json"), "catalog bytes", { mode: 0o640 });
    await writeFile(path.join(root, "items", "loose.txt"), "loose bytes", { mode: 0o600 });
    const before = await lstat(root, { bigint: true });
    const inventory = await scanMigrationInventory(root);
    const after = await lstat(root, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    const nodes = inventory.nodes;
    assert.deepEqual(nodes.map((node) => node.path), [".", "catalog.json", "items", "items/empty", "items/loose.txt", "sources"]);
    const file = nodes.find((node) => node.path === "items/loose.txt");
    assert.equal(file?.bytesHash, digest("loose bytes"));
    assert.equal(file?.mode, 0o600);
    assert.equal(nodes.find((node) => node.path === "items/empty")?.kind, "directory");
    assert.equal(inventory.hash, digest(Buffer.concat([
      Buffer.from("copi-inventory-v1\0"),
      Buffer.from(canonicalJson(nodes)),
    ])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects only the owned backup UUID while retaining existing siblings and their commitment", async () => {
  const { scanMigrationInventory, projectMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-projection-"));
  const existingBackupDir = ".migration-backups/123e4567-e89b-42d3-a456-426614174000";
  const ownedBackupDir = ".migration-backups/123e4567-e89b-42d3-a456-426614174001";
  try {
    await writeFile(path.join(root, "catalog.json"), "catalog bytes", { mode: 0o600 });
    await writeFile(path.join(root, "notes.txt"), "preserve me", { mode: 0o600 });
    await mkdir(path.join(root, ...existingBackupDir.split("/")), { recursive: true });
    await writeFile(path.join(root, ...existingBackupDir.split("/"), "manifest.json"), "existing sibling", { mode: 0o600 });
    const before = await scanMigrationInventory(root);
    assert.ok(before.nodes.some((node) => node.path === existingBackupDir));
    assert.ok(before.nodes.some((node) => node.path === `${existingBackupDir}/manifest.json`));

    await mkdir(path.join(root, ".copi-transaction"));
    await writeFile(path.join(root, ".copi-transaction", "owner.json"), "owned lock");
    await mkdir(path.join(root, ...ownedBackupDir.split("/")), { recursive: true });
    await writeFile(path.join(root, ...ownedBackupDir.split("/"), "manifest.json"), "owned backup", { mode: 0o600 });
    const withArtifacts = await scanMigrationInventory(root);
    const hidden = [".copi-transaction", ".copi-transaction-recovery", ownedBackupDir];
    const expected = projectMigrationInventory(before, hidden, ["catalog.json"]);
    const actual = projectMigrationInventory(withArtifacts, hidden, ["catalog.json"]);
    assert.deepEqual(actual, expected);
    assert.ok(actual.nodes.some((node) => node.path === `${existingBackupDir}/manifest.json`));

    const unknownSiblingDir = ".migration-backups/123e4567-e89b-42d3-a456-426614174002";
    await mkdir(path.join(root, ...unknownSiblingDir.split("/")), { recursive: true });
    await writeFile(path.join(root, ...unknownSiblingDir.split("/"), "loose.txt"), "must remain visible", { mode: 0o600 });
    const changedSibling = projectMigrationInventory(await scanMigrationInventory(root), hidden, ["catalog.json"]);
    assert.notDeepEqual(changedSibling, expected);

    await writeFile(path.join(root, "notes.txt"), "changed content", { mode: 0o600 });
    const changedPayload = projectMigrationInventory(await scanMigrationInventory(root), hidden, ["catalog.json"]);
    assert.notDeepEqual(changedPayload, expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("can scan the projected payload without treating owned hardlinked catalog stages as unsafe aliases", async () => {
  const { scanMigrationInventory, projectMigrationInventory } = await import("../src/migration-inventory.ts");
  const { link } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-hardlink-projection-"));
  try {
    await writeFile(path.join(root, "catalog.json"), "catalog bytes", { mode: 0o600 });
    const baseline = await scanMigrationInventory(root);
    await mkdir(path.join(root, ".copi-transaction"));
    await link(path.join(root, "catalog.json"), path.join(root, ".copi-transaction", "old-catalog"));
    const current = await scanMigrationInventory(root, { excludedPrefixes: [".copi-transaction"] });
    assert.deepEqual(
      projectMigrationInventory(current, [], ["catalog.json"]),
      projectMigrationInventory(baseline, [], ["catalog.json"]),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("blocks inventory capture on symlinks and does not omit unsafe nodes", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-link-"));
  try {
    await symlink("elsewhere", path.join(root, "link"));
    await assert.rejects(scanMigrationInventory(root), /symbolic link|symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  assert.notEqual(result, undefined);
  return result!;
}
