import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("captures only Copi-managed root nodes while retaining inode, mode, file hashes, and empty-directory commitments", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-"));
  try {
    await mkdir(path.join(root, "items", "empty"), { recursive: true, mode: 0o751 });
    await mkdir(path.join(root, "sources"), { mode: 0o700 });
    await writeFile(path.join(root, "catalog.json"), "catalog bytes", { mode: 0o640 });
    await writeFile(path.join(root, "items", "loose.txt"), "loose bytes", { mode: 0o600 });
    await mkdir(path.join(root, ".migration-backups"));
    await mkdir(path.join(root, ".copi-transaction"));
    await writeFile(path.join(root, ".copi-transaction", "owner.json"), "managed lock", { mode: 0o600 });
    await mkdir(path.join(root, ".copi-transaction-recovery"));
    await writeFile(path.join(root, ".copi-transaction-recovery", "owner.json"), "managed recovery", { mode: 0o600 });
    await writeFile(path.join(root, ".copi-migration-resolution.json"), "managed record", { mode: 0o600 });
    await writeFile(path.join(root, ".copi-migration-resolution.generation.tmp"), "managed temp", { mode: 0o600 });
    await mkdir(path.join(root, "docs"));
    await symlink("missing-target", path.join(root, "docs", "unrelated-link"));
    await writeFile(path.join(root, "README.md"), "unmanaged root document");
    const before = await lstat(root, { bigint: true });
    const inventory = await scanMigrationInventory(root);
    const after = await lstat(root, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    const nodes = inventory.nodes;
    assert.deepEqual(nodes.map((node) => node.path), [
      ".", ".copi-migration-resolution.generation.tmp", ".copi-migration-resolution.json",
      ".copi-transaction", ".copi-transaction-recovery", ".copi-transaction-recovery/owner.json",
      ".copi-transaction/owner.json", ".migration-backups", "catalog.json", "items", "items/empty", "items/loose.txt", "sources",
    ]);
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

test("unmanaged root additions and timestamp changes do not alter the projected inventory", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-unmanaged-"));
  try {
    await writeFile(path.join(root, "catalog.json"), "catalog bytes", { mode: 0o600 });
    const before = await scanMigrationInventory(root);
    await mkdir(path.join(root, ".pi", "loops"), { recursive: true });
    await writeFile(path.join(root, ".pi", "loops", "session.log"), "external activity");
    await writeFile(path.join(root, "notes.md"), "unmanaged root file");
    assert.deepEqual(await scanMigrationInventory(root), before);
    await rm(path.join(root, "notes.md"));
    assert.deepEqual(await scanMigrationInventory(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("blocks special filesystem nodes inside managed directories", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-special-"));
  const socketPath = path.join(root, "items", "special.sock");
  const server = createServer();
  try {
    await mkdir(path.join(root, "items"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(scanMigrationInventory(root), /special filesystem node/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks symlinks inside managed directories and does not omit unsafe nodes", async () => {
  const { scanMigrationInventory } = await import("../src/migration-inventory.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inventory-link-"));
  try {
    await mkdir(path.join(root, "items"));
    await symlink("elsewhere", path.join(root, "items", "link"));
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
