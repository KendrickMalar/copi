import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitMigration,
  prepareMigration,
  readMigration,
  type PreparedMigration,
} from "../src/migration.ts";
import type { ChangeApproval } from "../src/resource-mutations.ts";
import {
  createLegacyLibrary,
  makeLegacyItem,
  treeSnapshot,
  uniqueMissingPath,
  writeBytes,
  writeLegacyCatalog,
  writeLegacySnapshot,
} from "./helpers/legacy-library.ts";

function approvalFor(plan: PreparedMigration): ChangeApproval {
  const view = readMigration(plan);
  return { reviewId: plan.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] };
}

async function withLegacyLibrary(run: (root: string) => Promise<void>): Promise<void> {
  const fixture = await createLegacyLibrary();
  try {
    await writeLegacyCatalog(fixture.root);
    await writeLegacySnapshot(fixture.root);
    await run(fixture.root);
  } finally {
    await fixture.dispose();
  }
}

async function writeV2Catalog(root: string): Promise<void> {
  const item = makeLegacyItem();
  await writeBytes(root, "catalog.json", Buffer.from(`${JSON.stringify({
    version: 2,
    items: [{ ...item, content: { kind: "file", path: `sources/${item.id}/AGENTS.md` } }],
    groups: [],
  })}\n`), 0o600);
}

const invalidApproval = (value: unknown): ChangeApproval => value as ChangeApproval;

test("valid approval for ready v1 is explicitly fail-closed and writes nothing", async () => {
  await withLegacyLibrary(async (root) => {
    const plan = await prepareMigration(root);
    assert.equal(readMigration(plan).status, "ready");
    const before = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /fail.closed|not implemented|kernel/i);

    assert.equal(await treeSnapshot(root), before);
  });
});

test("rejects cloned, forged, foreign, and copied-reviewId plans without writes", async () => {
  await withLegacyLibrary(async (root) => {
    const plan = await prepareMigration(root);
    const foreign = await prepareMigration(root);
    const fakePlans = [
      structuredClone(plan) as PreparedMigration,
      { reviewId: plan.reviewId } as PreparedMigration,
      { ...foreign, reviewId: plan.reviewId } as PreparedMigration,
    ];
    const before = await treeSnapshot(root);

    for (const fake of fakePlans) {
      await assert.rejects(commitMigration(fake, approvalFor(plan)), /prepared|invalid|token/i);
      assert.equal(await treeSnapshot(root), before);
    }
  });
});

test("snapshots own-data approvals and rejects proxies, accessors, extra keys, and sparse arrays", async () => {
  await withLegacyLibrary(async (root) => {
    const plan = await prepareMigration(root);
    const valid = approvalFor(plan);
    let getterCalls = 0;
    const accessor = Object.defineProperties({}, {
      reviewId: { enumerable: true, get: () => { getterCalls += 1; return plan.reviewId; } },
      confirmed: { enumerable: true, value: true },
      approvedSensitivePaths: { enumerable: true, value: [] },
    });
    let proxyTrapCalls = 0;
    const proxy = new Proxy(valid, {
      get: () => { proxyTrapCalls += 1; return undefined; },
      ownKeys: () => { proxyTrapCalls += 1; return Reflect.ownKeys(valid); },
    });
    const sparse: string[] = [];
    sparse.length = 1;
    const values = [
      { ...valid, extra: true },
      accessor,
      proxy,
      { ...valid, approvedSensitivePaths: new Proxy([], {}) },
      { ...valid, approvedSensitivePaths: sparse },
      { ...valid, approvedSensitivePaths: ["unexpected"] },
      { ...valid, confirmed: false },
      { ...valid, reviewId: "not-the-review" },
    ];
    const before = await treeSnapshot(root);

    for (const value of values) {
      await assert.rejects(commitMigration(plan, invalidApproval(value)), /approval|confirm|sensitive|review|fixed|own.data/i);
      assert.equal(await treeSnapshot(root), before);
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyTrapCalls, 0);
  });
});

test("requires exactly the fixed sensitive-path set and does not trust mutated read views", async () => {
  await withLegacyLibrary(async (root) => {
    const secretBytes = Buffer.from('const apiKey = "SYNTHETIC_MIGRATION_SECRET_482917";\n');
    await writeLegacyCatalog(root, [makeLegacyItem({
      files: [{ path: "AGENTS.md", mode: 0o640, sha256: createHash("sha256").update(secretBytes).digest("hex") }],
    })]);
    await writeLegacySnapshot(root, secretBytes);
    const plan = await prepareMigration(root);
    const view = readMigration(plan);
    const [secretPath] = view.sensitivePaths;
    assert.ok(secretPath);
    const baseApproval = approvalFor(plan);
    const before = await treeSnapshot(root);
    const invalidSets = [
      [],
      [secretPath, secretPath],
      [secretPath, "extra/path"],
    ];
    for (const approvedSensitivePaths of invalidSets) {
      await assert.rejects(commitMigration(plan, { ...baseApproval, approvedSensitivePaths }), /sensitive|approval/i);
      assert.equal(await treeSnapshot(root), before);
    }

    (view.sensitivePaths as string[]).push("forged/view/path");
    await assert.rejects(commitMigration(plan, {
      ...baseApproval,
      approvedSensitivePaths: [...view.sensitivePaths],
    }), /sensitive|approval/i);
    assert.equal(await treeSnapshot(root), before);

    await assert.rejects(commitMigration(plan, baseApproval), /fail.closed|not implemented|kernel/i);
    assert.equal(await treeSnapshot(root), before);
  });
});

test("rejects blocked plans, including pending transaction and recovery locks", async () => {
  await withLegacyLibrary(async (root) => {
    await writeBytes(root, ".copi-transaction/owner.json", Buffer.from("active\n"), 0o600);
    await writeBytes(root, ".copi-transaction-recovery/claim.json", Buffer.from("claimed\n"), 0o600);
    const plan = await prepareMigration(root);
    assert.equal(readMigration(plan).status, "blocked");
    const before = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /blocked|conflict|not ready/i);

    assert.equal(await treeSnapshot(root), before);
  });
});

test("returns an existing v2 library as a readonly no-op and rejects replay", async () => {
  const fixture = await createLegacyLibrary();
  try {
    await writeV2Catalog(fixture.root);
    const plan = await prepareMigration(fixture.root);
    assert.equal(readMigration(plan).status, "already-v2");
    const before = await treeSnapshot(fixture.root);

    assert.deepEqual(await commitMigration(plan, approvalFor(plan)), {
      catalogVersion: 2,
      backupDir: null,
      preservedPaths: [],
    });
    assert.equal(await treeSnapshot(fixture.root), before);
    await assert.rejects(commitMigration(plan, approvalFor(plan)), /already|used|replay/i);
    assert.equal(await treeSnapshot(fixture.root), before);
  } finally {
    await fixture.dispose();
  }
});

test("returns a still-missing library as a readonly no-op without creating it", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-migration-auth-missing-"));
  try {
    const missing = uniqueMissingPath(parent);
    const plan = await prepareMigration(missing);
    assert.equal(readMigration(plan).status, "already-v2");
    const before = await treeSnapshot(parent);

    assert.deepEqual(await commitMigration(plan, approvalFor(plan)), {
      catalogVersion: 2,
      backupDir: null,
      preservedPaths: [],
    });
    assert.equal(await treeSnapshot(parent), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a missing-library plan if a v1 library appears after preview", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-migration-auth-created-v1-"));
  try {
    const root = uniqueMissingPath(parent);
    const plan = await prepareMigration(root);
    await mkdir(root);
    await writeLegacyCatalog(root);
    await writeLegacySnapshot(root);
    const before = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|already.v2/i);

    assert.equal(await treeSnapshot(root), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a missing-library plan if a lock appears after preview", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-migration-auth-created-lock-"));
  try {
    const root = uniqueMissingPath(parent);
    const plan = await prepareMigration(root);
    await mkdir(root);
    await writeBytes(root, ".copi-transaction/owner.json", Buffer.from("active\n"), 0o600);
    const before = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|blocked|already.v2/i);

    assert.equal(await treeSnapshot(root), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a ready v1 plan when catalog or source data changes after preview", async () => {
  await withLegacyLibrary(async (root) => {
    const plan = await prepareMigration(root);
    await writeLegacyCatalog(root, [makeLegacyItem({ name: "changed after review" })]);
    const beforeCatalogReject = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|conflict|blocked/i);

    assert.equal(await treeSnapshot(root), beforeCatalogReject);
  });

  await withLegacyLibrary(async (root) => {
    const plan = await prepareMigration(root);
    await writeBytes(root, "items/123e4567-e89b-42d3-a456-426614174000/files/AGENTS.md", Buffer.from("changed snapshot\n"), 0o640);
    const beforeDataReject = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|conflict|blocked/i);

    assert.equal(await treeSnapshot(root), beforeDataReject);
  });
});

test("rejects an existing-v2 no-op when its catalog version or transaction-lock state changes", async () => {
  const fixture = await createLegacyLibrary();
  try {
    await writeV2Catalog(fixture.root);
    const staleCatalogPlan = await prepareMigration(fixture.root);
    await writeLegacyCatalog(fixture.root);
    const afterCatalogChange = await treeSnapshot(fixture.root);

    await assert.rejects(commitMigration(staleCatalogPlan, approvalFor(staleCatalogPlan)), /changed|revision|preview|already.v2/i);

    assert.equal(await treeSnapshot(fixture.root), afterCatalogChange);
    await writeV2Catalog(fixture.root);
    const staleLockPlan = await prepareMigration(fixture.root);
    await writeBytes(fixture.root, ".copi-transaction/owner.json", Buffer.from("active\n"), 0o600);
    const afterLockChange = await treeSnapshot(fixture.root);

    await assert.rejects(commitMigration(staleLockPlan, approvalFor(staleLockPlan)), /changed|revision|preview|blocked|already.v2/i);

    assert.equal(await treeSnapshot(fixture.root), afterLockChange);
  } finally {
    await fixture.dispose();
  }
});

test("rejects an existing-v2 no-op when catalog data changes but remains v2", async () => {
  const fixture = await createLegacyLibrary();
  try {
    await writeV2Catalog(fixture.root);
    const plan = await prepareMigration(fixture.root);
    await writeBytes(fixture.root, "catalog.json", Buffer.from(`${JSON.stringify({
      version: 2,
      items: [{ ...makeLegacyItem({ name: "changed v2 data" }), content: { kind: "file", path: `sources/${makeLegacyItem().id}/AGENTS.md` } }],
      groups: [],
    })}\\n`), 0o600);
    const before = await treeSnapshot(fixture.root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview/i);

    assert.equal(await treeSnapshot(fixture.root), before);
  } finally {
    await fixture.dispose();
  }
});

test("rejects an existing-v2 no-op if the canonical library root is replaced", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "copi-migration-auth-root-replaced-"));
  const root = path.join(parent, "library");
  const displaced = path.join(parent, "displaced-library");
  try {
    await mkdir(root);
    await writeV2Catalog(root);
    const plan = await prepareMigration(root);
    await rename(root, displaced);
    await cp(displaced, root, { recursive: true, preserveTimestamps: true });
    const before = await treeSnapshot(root);

    await assert.rejects(commitMigration(plan, approvalFor(plan)), /changed|revision|preview|root|already.v2/i);

    assert.equal(await treeSnapshot(root), before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
