import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMigration, readMigration } from "../src/migration.ts";
import {
  createLegacyLibrary,
  legacyFileBytes,
  legacyFileDigest,
  legacyItemId,
  makeLegacyItem,
  treeSnapshot,
  uniqueMissingPath,
  writeBytes,
  writeLegacyCatalog,
  writeLegacySnapshot,
} from "./helpers/legacy-library.ts";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function withLibrary(run: (root: string) => Promise<void>): Promise<void> {
  const fixture = await createLegacyLibrary();
  try { await run(fixture.root); } finally { await fixture.dispose(); }
}

test("previews an existing safe sources payload first and preserves its current inode and bytes", async () => {
  await withLibrary(async (root) => {
    const currentBytes = Buffer.from("current source differs from the legacy snapshot\n");
    const sourcePath = await writeBytes(root, "sources/current/AGENTS.md", currentBytes, 0o755);
    await writeLegacyCatalog(root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(root);
    const before = await lstat(sourcePath, { bigint: true });
    const beforeTree = await treeSnapshot(root);

    const prepared = await prepareMigration(root);
    const view = readMigration(prepared);

    assert.equal(view.status, "ready");
    assert.deepEqual(view.items.map(({ id, target, selection }) => ({ id, target, selection })), [
      { id: legacyItemId, target: "sources/current/AGENTS.md", selection: "sources" },
    ]);
    assert.deepEqual(await readFile(sourcePath), currentBytes);
    const after = await lstat(sourcePath, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777n, 0o755n);
    assert.equal(await treeSnapshot(root), beforeTree);
    assert.ok(view.maskedDiffs.some((entry) => entry.path.endsWith("AGENTS.md")));
  });
});

test("keeps a preview ready while unrelated sibling entries change in a canonical ancestor", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-siblings-"));
  const root = path.join(parent, "library");
  await mkdir(root);
  try {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    await Promise.all(Array.from({ length: 240 }, (_, index) =>
      writeBytes(root, `sources/unregistered-${index}.txt`, Buffer.from(`unregistered ${index}\n`))));

    let running = true;
    let cycles = 0;
    let resolveFirstCycle: (() => void) | undefined;
    const firstCycle = new Promise<void>((resolve) => { resolveFirstCycle = resolve; });
    const churn = (async () => {
      while (running) {
        const sibling = path.join(parent, `unrelated-${cycles}`);
        await mkdir(sibling);
        await rm(sibling, { recursive: true });
        cycles += 1;
        resolveFirstCycle?.();
      }
    })();

    try {
      await firstCycle;
      const view = readMigration(await prepareMigration(root));
      running = false;
      await churn;
      assert.ok(cycles > 1, "the parent directory changed while the preview was running");
      assert.equal(view.status, "ready", view.conflicts.join("; "));
    } finally {
      running = false;
      await churn;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("blocks a preview when library-owned source nodes change during the scan", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-source-changes-"));
  const root = path.join(parent, "library");
  await mkdir(root);
  const sources = path.join(root, "sources");
  try {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    await Promise.all(Array.from({ length: 240 }, (_, index) =>
      writeBytes(root, `sources/unregistered-${index}.txt`, Buffer.from(`unregistered ${index}\n`))));

    let running = true;
    let cycles = 0;
    let resolveFirstCycle: (() => void) | undefined;
    const firstCycle = new Promise<void>((resolve) => { resolveFirstCycle = resolve; });
    const churn = (async () => {
      while (running) {
        const sibling = path.join(sources, `transient-${cycles}`);
        await mkdir(sibling);
        await rm(sibling, { recursive: true });
        cycles += 1;
        resolveFirstCycle?.();
      }
    })();

    try {
      await firstCycle;
      const view = readMigration(await prepareMigration(root));
      running = false;
      await churn;
      assert.ok(cycles > 1, "the sources directory changed while the preview was running");
      assert.equal(view.status, "blocked");
    } finally {
      running = false;
      await churn;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a canonical library path that traverses a symlinked ancestor", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-ancestor-link-"));
  const realParent = path.join(parent, "real");
  const linkedParent = path.join(parent, "linked");
  const root = path.join(linkedParent, "library");
  try {
    await mkdir(realParent);
    await symlink(realParent, linkedParent, "dir");
    await mkdir(root);
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.some((conflict) => conflict.includes("canonical real directory")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("blocks a preview if an ancestor directory mode changes during the scan", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-ancestor-mode-"));
  const root = path.join(parent, "library");
  await mkdir(root);
  try {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    await Promise.all(Array.from({ length: 240 }, (_, index) =>
      writeBytes(root, `sources/unregistered-${index}.txt`, Buffer.from(`unregistered ${index}\n`))));

    const preview = prepareMigration(root);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await chmod(parent, 0o750);
    const view = readMigration(await preview);

    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.some((conflict) => conflict.includes("ancestor changed")));
  } finally {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  }
});

test("blocks a preview when the library root directory is replaced during the scan", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-root-replaced-"));
  const root = path.join(parent, "library");
  const displaced = path.join(parent, "displaced-library");
  await mkdir(root);
  try {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    await Promise.all(Array.from({ length: 240 }, (_, index) =>
      writeBytes(root, `sources/unregistered-${index}.txt`, Buffer.from(`unregistered ${index}\n`))));

    const preview = prepareMigration(root);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await rename(root, displaced);
    await cp(displaced, root, { recursive: true, preserveTimestamps: true });
    const view = readMigration(await preview);

    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.length > 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("prefers current sources while retaining mismatched legacy snapshots as separate backup inputs", async () => {
  await withLibrary(async (root) => {
    const currentBytes = Buffer.from("explicitly adopted current source bytes\\n");
    const sourcePath = await writeBytes(root, "sources/current/AGENTS.md", currentBytes, 0o755);
    await writeLegacyCatalog(root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(root, Buffer.from("damaged legacy snapshot bytes\\n"));
    const before = await treeSnapshot(root);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "ready");
    assert.equal(view.items[0]?.selection, "sources");
    assert.ok(view.maskedDiffs.some((entry) => entry.summary.includes("differs")));
    assert.equal(await treeSnapshot(root), before);
  });
});

test("shows a masked text patch from the registered snapshot to the adopted current source", async () => {
  await withLibrary(async (root) => {
    const beforeBytes = Buffer.from('const apiKey = "SYNTHETIC_OLD_SECRET_VALUE_123456";\nconst stable = true;\n');
    const currentBytes = Buffer.from('const apiKey = "SYNTHETIC_NEW_SECRET_VALUE_654321";\nconst stable = true;\nconst added = true;\n');
    const sourcePath = await writeBytes(root, "sources/current/AGENTS.md", currentBytes, 0o755);
    const item = makeLegacyItem({
      sourcePath,
      files: [{ path: "AGENTS.md", mode: 0o640, sha256: digest(beforeBytes) }],
    });
    await writeLegacyCatalog(root, [item]);
    await writeLegacySnapshot(root, beforeBytes);
    const before = await treeSnapshot(root);

    const view = readMigration(await prepareMigration(root));
    const diff = view.maskedDiffs.find((entry) => entry.path.endsWith("AGENTS.md"))?.summary ?? "";

    assert.equal(view.status, "ready");
    assert.match(diff, /^-const apiKey = "\[REDACTED\]";$/m);
    assert.match(diff, /^\+const apiKey = "\[REDACTED\]";$/m);
    assert.match(diff, /\+const added = true;/);
    assert.match(diff, /\[REDACTED\]/);
    assert.equal(diff.includes("SYNTHETIC_OLD_SECRET_VALUE_123456"), false);
    assert.equal(diff.includes("SYNTHETIC_NEW_SECRET_VALUE_654321"), false);
    assert.equal(await treeSnapshot(root), before);
  });
});

test("previews items-only content after checking declared path and SHA-256, preserving descriptor mode", async () => {
  await withLibrary(async (root) => {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const before = await treeSnapshot(root);

    const prepared = await prepareMigration(root);
    const view = readMigration(prepared);

    assert.equal(view.status, "ready");
    assert.equal(view.items[0]?.selection, "items");
    assert.equal(view.items[0]?.target, `sources/${legacyItemId}/AGENTS.md`);
    assert.ok(view.warnings.some((warning) => warning.code === "origin-not-read"));
    assert.equal(await treeSnapshot(root), before);
  });
});

test("adopts an identical existing target but blocks a different target without replacement", async () => {
  await withLibrary(async (root) => {
    const target = await writeBytes(root, `sources/${legacyItemId}/AGENTS.md`, legacyFileBytes, 0o755);
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const before = await lstat(target, { bigint: true });
    const view = readMigration(await prepareMigration(root));
    assert.equal(view.status, "ready");
    assert.equal(view.items[0]?.selection, "sources");
    const after = await lstat(target, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
  });

  await withLibrary(async (root) => {
    const target = await writeBytes(root, `sources/${legacyItemId}/AGENTS.md`, Buffer.from("different target bytes\\n"), 0o644);
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const before = await treeSnapshot(root);
    const view = readMigration(await prepareMigration(root));
    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.some((conflict) => conflict.includes("differs")));
    assert.equal(await treeSnapshot(root), before);
    assert.deepEqual(await readFile(target), Buffer.from("different target bytes\\n"));
  });
});

test("plans four UUID-keyed additions without changing descriptor modes or fetching origins", async () => {
  await withLibrary(async (root) => {
    const ids = [
      legacyItemId,
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
      "123e4567-e89b-42d3-a456-426614174003",
    ];
    const skillBytes = Buffer.from("# Synthetic skill\n");
    const items = ids.map((id, index) => makeLegacyItem({
      id,
      kind: "skill",
      name: `Skill ${index + 1}`,
      sourcePath: `/synthetic/missing/${id}`,
      files: [{ path: "SKILL.md", mode: 0o755, sha256: digest(skillBytes) }],
    }));
    await writeLegacyCatalog(root, items);
    for (const id of ids) await writeBytes(root, `items/${id}/files/SKILL.md`, skillBytes, 0o600);
    const before = await treeSnapshot(root);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "ready");
    assert.deepEqual(view.items.map(({ id, target, selection }) => ({ id, target, selection })), ids.map((id) => ({
      id, target: `sources/${id}`, selection: "items",
    })));
    for (const id of ids) assert.equal((await lstat(path.join(root, "items", id, "files/SKILL.md"))).mode & 0o777, 0o600);
    assert.equal(await treeSnapshot(root), before);
  });
});

test("returns only safe summaries for binary and secret-bearing payloads", async () => {
  await withLibrary(async (root) => {
    const secretText = Buffer.from('const apiKey = "SYNTHETIC_SECRET_VALUE_123456";\n');
    const item = makeLegacyItem({ files: [{ path: "AGENTS.md", mode: 0o640, sha256: digest(secretText) }] });
    await writeLegacyCatalog(root, [item]);
    await writeLegacySnapshot(root, secretText);
    const prepared = await prepareMigration(root);
    const view = readMigration(prepared);
    assert.equal(view.status, "ready");
    assert.ok(view.sensitivePaths.some((entry) => entry.includes("AGENTS.md")));
    assert.ok(view.maskedDiffs.some((entry) => entry.summary.toLowerCase().includes("text")));
    assert.equal(JSON.stringify(view).includes("SYNTHETIC_SECRET_VALUE_123456"), false);

    const binary = Buffer.from([0, 1, 2, 255, 0, 65]);
    await writeBytes(root, `items/${legacyItemId}/files/binary.bin`, binary, 0o600);
    const nextItem = makeLegacyItem({ files: [{ path: "binary.bin", mode: 0o600, sha256: digest(binary) }] });
    await writeLegacyCatalog(root, [nextItem]);
    const binaryView = readMigration(await prepareMigration(root));
    assert.equal(binaryView.status, "ready");
    assert.ok(binaryView.maskedDiffs.some((entry) => entry.summary.toLowerCase().includes("binary")));
    assert.equal(JSON.stringify(binaryView).includes(binary.toString("base64")), false);
    assert.equal(JSON.stringify(binaryView).includes(binary.toString("hex")), false);
  });
});

test("retains unknown PM and unregistered source paths without exposing their contents or adopting them", async () => {
  await withLibrary(async (root) => {
    const pmSecret = Buffer.from('{"apiKey":"SYNTHETIC_PM_PRIVATE_VALUE"}\n');
    const looseSource = Buffer.from("SYNTHETIC_UNREGISTERED_SOURCE_BODY\n");
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    await writeBytes(root, "items/pm-diff/private.json", pmSecret, 0o600);
    await writeBytes(root, "sources/unregistered/extra.md", looseSource, 0o644);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "ready");
    assert.ok(view.preservedPaths.includes("items/pm-diff/private.json"));
    assert.ok(view.preservedPaths.includes("sources/unregistered/extra.md"));
    assert.equal(view.items.some((item) => item.target.includes("unregistered")), false);
    const rendered = JSON.stringify(view);
    assert.equal(rendered.includes("SYNTHETIC_PM_PRIVATE_VALUE"), false);
    assert.equal(rendered.includes("SYNTHETIC_UNREGISTERED_SOURCE_BODY"), false);
  });
});

test("missing libraries and valid v2 catalogs are already-v2 no-ops without writes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-preview-absent-"));
  try {
    const missing = uniqueMissingPath(parent);
    const parentBefore = await treeSnapshot(parent);
    assert.equal(readMigration(await prepareMigration(missing)).status, "already-v2");
    assert.equal(await treeSnapshot(parent), parentBefore);
  } finally { await rm(parent, { recursive: true, force: true }); }

  await withLibrary(async (root) => {
    const catalog = {
      version: 2,
      items: [{ ...makeLegacyItem(), content: { kind: "file", path: `sources/${legacyItemId}/AGENTS.md` } }],
      groups: [],
    };
    await writeBytes(root, "catalog.json", Buffer.from(`${JSON.stringify(catalog)}\n`), 0o600);
    const before = await treeSnapshot(root);
    const view = readMigration(await prepareMigration(root));
    assert.equal(view.status, "already-v2");
    assert.equal(view.items.length, 0);
    assert.equal(view.preservedPaths.length, 0);
    assert.equal(await treeSnapshot(root), before);
  });
});

test("pending transaction and recovery locks block preview without attempting recovery or cleanup", async () => {
  await withLibrary(async (root) => {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const ownerActive = Buffer.from('{"pid":123,"host":"synthetic","token":"active"}\n');
    await writeBytes(root, ".copi-transaction/owner.json", ownerActive, 0o600);
    await writeBytes(root, ".copi-transaction/journal.json", Buffer.from('{"version":4,"mode":"legacy-migration"}\n'), 0o600);
    await writeBytes(root, ".copi-transaction-recovery/claim.json", Buffer.from("claimed\n"), 0o600);
    const before = await treeSnapshot(root);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.some((conflict) => conflict.includes(".copi-transaction")));
    assert.ok(view.conflicts.some((conflict) => conflict.includes(".copi-transaction-recovery")));
    assert.equal(await treeSnapshot(root), before);
  });
});

test("rejects cloned, forged, and foreign handles while returned view mutation stays detached", async () => {
  await withLibrary(async (root) => {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const prepared = await prepareMigration(root);
    const first = readMigration(prepared);
    (first.items as unknown as Array<{ name: string }>)[0]!.name = "tampered view";
    (first.preservedPaths as string[]).push("forged/path");
    const second = readMigration(prepared);
    assert.equal(second.items[0]?.name, "Legacy instruction");
    assert.equal(second.preservedPaths.includes("forged/path"), false);

    assert.throws(() => readMigration(structuredClone(prepared)), /prepared|invalid|token/i);
    assert.throws(() => readMigration({ reviewId: prepared.reviewId } as never), /prepared|invalid|token/i);
    const other = await prepareMigration(root);
    assert.throws(() => readMigration({ ...other, reviewId: prepared.reviewId } as never), /prepared|invalid|token/i);
  });
});

test("blocks overlapping selected sources targets instead of guessing which item owns them", async () => {
  await withLibrary(async (root) => {
    const sharedSource = await writeBytes(root, "sources/shared/AGENTS.md", legacyFileBytes, 0o640);
    const first = makeLegacyItem({ sourcePath: sharedSource });
    const second = makeLegacyItem({ id: "123e4567-e89b-42d3-a456-426614174001", sourcePath: sharedSource, name: "Duplicate target" });
    await writeLegacyCatalog(root, [first, second]);
    await writeLegacySnapshot(root);
    await writeLegacySnapshot(root, legacyFileBytes, `items/${second.id}/files/AGENTS.md`);
    const before = await treeSnapshot(root);

    const view = readMigration(await prepareMigration(root));

    assert.equal(view.status, "blocked");
    assert.ok(view.conflicts.length > 0);
    assert.equal(await treeSnapshot(root), before);
  });
});

test("blocks unsafe symlinks, unverified item snapshots, and unknown catalog versions without touching inputs", async () => {
  await withLibrary(async (root) => {
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const outside = path.join(path.dirname(root), `copi-preview-outside-${path.basename(root)}`);
    await writeBytes(path.dirname(root), path.basename(outside), Buffer.from("outside\n"), 0o600);
    const outsideBefore = await treeSnapshot(outside);
    await symlink(outside, path.join(root, "sources"));
    const linkedBefore = await treeSnapshot(root);
    const linked = readMigration(await prepareMigration(root));
    assert.equal(linked.status, "blocked");
    assert.equal(await treeSnapshot(root), linkedBefore);
    assert.equal(await treeSnapshot(outside), outsideBefore);
    await rm(path.join(root, "sources"));
    await rm(outside);

    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root, Buffer.from("tampered snapshot\n"));
    const itemBefore = await treeSnapshot(root);
    const invalidSnapshot = readMigration(await prepareMigration(root));
    assert.equal(invalidSnapshot.status, "blocked");
    assert.ok(invalidSnapshot.conflicts.length > 0);
    assert.equal(await treeSnapshot(root), itemBefore);

    await writeBytes(root, "catalog.json", Buffer.from('{"version":99,"items":[],"groups":[]}\n'), 0o600);
    const unknownBefore = await treeSnapshot(root);
    const unsupported = readMigration(await prepareMigration(root));
    assert.equal(unsupported.status, "blocked");
    assert.ok(unsupported.conflicts.length > 0);
    assert.equal(await treeSnapshot(root), unknownBefore);
  });
});
