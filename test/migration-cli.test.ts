import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import {
  parseMigrationArgs,
  runMigrateCommand,
  type MigrationCommandApi,
  type MigrationCommandRuntime,
} from "../src/migrate.ts";
import { createLegacyLibrary, makeLegacyItem, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const secretPaths = ["credential.txt", "skill/private.env"];

async function interruptMigrationAtCatalogSwitch(root: string): Promise<void> {
  const migrationUrl = new URL("../src/migration.js", import.meta.url).href;
  const transactionUrl = new URL("../src/storage-transaction.js", import.meta.url).href;
  const script = `
    const transaction = await import(${JSON.stringify(transactionUrl)});
    Object.defineProperty(transaction.storageTransactions, "run", { configurable: true, value: (root, create, operation) =>
      new transaction.StorageTransactions({ checkpoint: (point) => { if (point === "catalog-renamed") process.kill(process.pid, "SIGKILL"); } })
        .run(root, create, operation) });
    const migration = await import(${JSON.stringify(migrationUrl)});
    const plan = await migration.prepareMigration(process.argv[1]);
    const view = migration.readMigration(plan);
    if (view.status !== "ready") throw new Error("migration fixture was not ready: " + JSON.stringify(view.conflicts));
    await migration.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

function readyViews() {
  return {
    migration: {
      reviewId: "migration-review",
      status: "ready",
      items: [{ id: "item-id", name: "Example", target: "sources/example.md", selection: "sources" }],
      conflicts: [],
      preservedPaths: ["notes.txt"],
      maskedDiffs: [
        { path: "item-id/guide.md", summary: "masked diff: sk_live_1234567890abcdef" },
        { path: "item-id/setup.md", summary: "second complete masked diff" },
      ],
      sensitivePaths: secretPaths,
      warnings: [],
    },
    resolution: {
      reviewId: "resolution-review",
      status: "ready",
      backupDir: ".migration-backups/verified",
      items: [{ id: "item-id", name: "Example", target: "sources/example.md", selection: "sources" }],
      conflicts: [],
      preservedPaths: ["notes.txt"],
      maskedDiffs: [
        { path: "item-id/guide.md", summary: "masked resolution diff: sk_live_1234567890abcdef" },
        { path: "item-id/setup.md", summary: "second complete resolution diff" },
      ],
      sensitivePaths: secretPaths,
      warnings: [],
    },
  };
}

function harness(options: {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  migrationStatus?: string;
  resolutionStatus?: string;
  migrationConflicts?: string[];
  resolutionConflicts?: string[];
  answers?: unknown[];
} = {}) {
  const views = readyViews();
  const calls = { prepareMigration: 0, readMigration: 0, commitMigration: 0,
    prepareResolution: 0, readResolution: 0, commitResolution: 0 };
  const approvals: Array<{ reviewId: string; confirmed: boolean; approvedSensitivePaths: readonly string[] }> = [];
  const prompts: Array<{ message: string; initialValue: false }> = [];
  const output: string[] = [];
  const answers = [...(options.answers ?? [true, true, true, true])];
  const api = {
    prepareMigration: async () => { calls.prepareMigration += 1; return { reviewId: "migration-review" }; },
    readMigration: () => { calls.readMigration += 1; return { ...views.migration, status: options.migrationStatus ?? views.migration.status, conflicts: options.migrationConflicts ?? views.migration.conflicts }; },
    commitMigration: async (_plan: unknown, approval: { reviewId: string; confirmed: boolean; approvedSensitivePaths: readonly string[] }) => {
      calls.commitMigration += 1; approvals.push(approval);
      return { catalogVersion: 2, backupDir: ".migration-backups/made", preservedPaths: ["notes.txt"] };
    },
    prepareMigrationResolution: async () => { calls.prepareResolution += 1; return { reviewId: "resolution-review" }; },
    readMigrationResolution: () => { calls.readResolution += 1; return { ...views.resolution, status: options.resolutionStatus ?? views.resolution.status, conflicts: options.resolutionConflicts ?? views.resolution.conflicts }; },
    commitMigrationResolution: async (_plan: unknown, approval: { reviewId: string; confirmed: boolean; approvedSensitivePaths: readonly string[] }) => {
      calls.commitResolution += 1; approvals.push(approval);
      return { catalogVersion: 2, backupDir: ".migration-backups/verified", preservedPaths: ["notes.txt"] };
    },
  } as unknown as MigrationCommandApi;
  const runtime: MigrationCommandRuntime = {
    api,
    stdinIsTTY: options.stdinIsTTY ?? true,
    stdoutIsTTY: options.stdoutIsTTY ?? true,
    confirm: async (message, initialValue) => {
      prompts.push({ message, initialValue });
      return answers.shift();
    },
    withLifecycle: async (operation) => operation(new AbortController().signal),
    write: (line) => output.push(line),
  };
  return { calls, approvals, prompts, output, runtime };
}

test("migrate flags accept only the four documented command shapes", () => {
  assert.deepEqual(parseMigrationArgs([]), { resolve: false, dryRun: false });
  assert.deepEqual(parseMigrationArgs(["--dry-run"]), { resolve: false, dryRun: true });
  assert.deepEqual(parseMigrationArgs(["--resolve"]), { resolve: true, dryRun: false });
  assert.deepEqual(parseMigrationArgs(["--resolve", "--dry-run"]), { resolve: true, dryRun: true });
  for (const args of [["--yes"], ["--unknown"], ["--resolve", "--resolve"], ["--dry-run", "--dry-run"], ["source"]]) {
    assert.throws(() => parseMigrationArgs(args), /Usage: copi migrate/);
  }
});

test("ordinary migration dry-run is read-only, non-interactive, and prints the full masked review", async () => {
  const h = harness({ stdinIsTTY: false, stdoutIsTTY: false });
  const result = await runMigrateCommand(["--dry-run"], "/synthetic/.copi", h.runtime);
  assert.equal(result, 0);
  assert.equal(h.calls.prepareMigration, 1);
  assert.equal(h.calls.readMigration, 1);
  assert.equal(h.calls.commitMigration, 0);
  assert.equal(h.prompts.length, 0);
  assert.match(h.output.join(""), /masked diff: \[REDACTED\]/);
  assert.match(h.output.join(""), /second complete masked diff/);
  assert.ok(!h.output.join("").includes("sk_live_1234567890abcdef"));
  assert.match(h.output.join(""), /sources\/example\.md/);
});

test("resolution dry-run is read-only and never falls through to ordinary migration", async () => {
  const h = harness({ stdinIsTTY: false, stdoutIsTTY: false });
  const result = await runMigrateCommand(["--resolve", "--dry-run"], "/synthetic/.copi", h.runtime);
  assert.equal(result, 0);
  assert.equal(h.calls.prepareResolution, 1);
  assert.equal(h.calls.readResolution, 1);
  assert.equal(h.calls.commitResolution, 0);
  assert.equal(h.calls.prepareMigration, 0);
  assert.equal(h.prompts.length, 0);
  assert.match(h.output.join(""), /masked resolution diff: \[REDACTED\]/);
  assert.match(h.output.join(""), /second complete resolution diff/);
  assert.ok(!h.output.join("").includes("sk_live_1234567890abcdef"));
});

test("both mutating migrate routes require both TTYs before preparing a plan", async () => {
  for (const args of [[], ["--resolve"]]) {
    for (const tty of [{ stdinIsTTY: false, stdoutIsTTY: true }, { stdinIsTTY: true, stdoutIsTTY: false }]) {
      const h = harness(tty);
      assert.equal(await runMigrateCommand(args, "/synthetic/.copi", h.runtime), 1);
      assert.equal(h.calls.prepareMigration + h.calls.prepareResolution, 0);
      assert.equal(h.calls.commitMigration + h.calls.commitResolution, 0);
      assert.match(h.output.join(""), /interactive TTY.*read-only/);
    }
  }
});

test("resolution presents every masked diff, then default-no whole, each secret, and final confirmations", async () => {
  const h = harness();
  assert.equal(await runMigrateCommand(["--resolve"], "/synthetic/.copi", h.runtime), 0);
  assert.deepEqual(h.prompts.map((prompt) => prompt.initialValue), [false, false, false, false]);
  assert.match(h.prompts[0]!.message, /masked diff/);
  assert.match(h.prompts[1]!.message, /credential\.txt/);
  assert.match(h.prompts[2]!.message, /skill\/private\.env/);
  assert.match(h.prompts[3]!.message, /catalog・sources・items は書き換えません/);
  assert.equal(h.calls.commitResolution, 1);
  assert.equal(h.calls.commitMigration, 0);
  assert.deepEqual(h.approvals, [{ reviewId: "resolution-review", confirmed: true, approvedSensitivePaths: secretPaths }]);
});

test("declining or cancelling any confirmation exits 1 without calling a commit", async () => {
  for (const answers of [[false], [true, false], [true, true, false], [Symbol("EOF")], [Symbol("Ctrl-C")]]) {
    const h = harness({ answers });
    assert.equal(await runMigrateCommand(["--resolve"], "/synthetic/.copi", h.runtime), 1);
    assert.equal(h.calls.commitResolution, 0);
  }
});

test("resolution blocked/not-needed never commits or falls through", async () => {
  const blocked = harness({ resolutionStatus: "blocked" });
  assert.equal(await runMigrateCommand(["--resolve", "--dry-run"], "/synthetic/.copi", blocked.runtime), 1);
  assert.match(blocked.output.join(""), /安全に解消できないため停止しました/);
  assert.equal(blocked.calls.prepareMigration, 0);

  const notNeeded = harness({ resolutionStatus: "not-needed" });
  assert.equal(await runMigrateCommand(["--resolve", "--dry-run"], "/synthetic/.copi", notNeeded.runtime), 0);
  assert.match(notNeeded.output.join(""), /解消が必要な移行残物はありません/);
  assert.equal(notNeeded.calls.prepareMigration, 0);
  assert.equal(notNeeded.calls.commitResolution, 0);

  const legacyV4 = harness({ resolutionStatus: "blocked", resolutionConflicts: ["baseline-insufficient: v4 journal"] });
  assert.equal(await runMigrateCommand(["--resolve", "--dry-run"], "/synthetic/.copi", legacyV4.runtime), 1);
  assert.match(legacyV4.output.join(""), /開始時 inventory が無いためこの解消手順では扱えません/);
  assert.match(legacyV4.output.join(""), /fresh review/);
});

test("ordinary migration lock guidance points to the read-only resolver preview", async () => {
  const h = harness({ migrationStatus: "blocked", migrationConflicts: [".copi-transaction exists"] });
  assert.equal(await runMigrateCommand(["--dry-run"], "/synthetic/.copi", h.runtime), 1);
  assert.match(h.output.join(""), /移行終了確認が未完了です/);
  assert.match(h.output.join(""), /copi migrate --resolve --dry-run/);
  assert.equal(h.calls.commitMigration, 0);
});

test("ordinary mutating migration uses the same whole, per-secret, final default-no sequence", async () => {
  const h = harness();
  assert.equal(await runMigrateCommand([], "/synthetic/.copi", h.runtime), 0);
  assert.deepEqual(h.prompts.map((prompt) => prompt.initialValue), [false, false, false, false]);
  assert.match(h.prompts[0]!.message, /masked diff/);
  assert.match(h.prompts[1]!.message, /credential\.txt/);
  assert.match(h.prompts[2]!.message, /skill\/private\.env/);
  assert.equal(h.calls.commitMigration, 1);
  assert.equal(h.calls.commitResolution, 0);
});

test("main dispatches migrate, rejects mixed help/unknown flags, and help documents resolution", async () => {
  const h = harness({ stdinIsTTY: false, stdoutIsTTY: false });
  const result = await main(["migrate", "--resolve", "--dry-run"], { HOME: "/synthetic/home" }, "/synthetic/project", h.runtime);
  assert.equal(result, 0);
  assert.equal(h.calls.prepareResolution, 1);
  assert.equal(h.calls.prepareMigration, 0);

  const nonTTY = harness({ stdinIsTTY: false, stdoutIsTTY: true });
  assert.equal(await main(["migrate"], { HOME: "/synthetic/home" }, "/synthetic/project", nonTTY.runtime), 1);
  assert.equal(nonTTY.calls.prepareMigration, 0);
  await assert.rejects(main(["migrate", "--yes", "--help"], { HOME: "/synthetic/home" }, "/synthetic/project", h.runtime), /Usage: copi migrate/);

  const help = spawnSync(process.execPath, [path.resolve("dist/src/cli.js"), "help"], {
    cwd: process.cwd(), env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /copi migrate \[--dry-run\]/);
  assert.match(help.stdout, /copi migrate --resolve/);
  assert.match(help.stdout, /never falls back to ordinary migration/);
  assert.match(help.stdout, /v4 journals lack[\s\S]*start inventory/);
});

test("resolution dry-run reaches the integrated API on a real interrupted synthetic migration without writes", async () => {
  const fixture = await createLegacyLibrary();
  try {
    const sourcePath = await writeBytes(fixture.root, "sources/current/AGENTS.md", Buffer.from("original source bytes\n"), 0o640);
    await writeLegacyCatalog(fixture.root, [makeLegacyItem({ sourcePath })]);
    await writeLegacySnapshot(fixture.root);
    await interruptMigrationAtCatalogSwitch(fixture.root);
    await writeFile(sourcePath, Buffer.from("ordinary user edit retained\n"));

    const before = await treeSnapshot(fixture.root);
    const output: string[] = [];
    const result = await runMigrateCommand(["--resolve", "--dry-run"], fixture.root, {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      write: (text) => output.push(text),
    });

    assert.equal(result, 0);
    assert.match(output.join(""), /Migration resolution: ready/);
    assert.match(output.join(""), /ordinary user edit retained/);
    assert.equal(output.join("").includes("Legacy migration:"), false);
    assert.equal(await treeSnapshot(fixture.root), before, "the real API dry-run must be strictly read-only");
  } finally { await fixture.dispose(); }
});

test("README documents the resolution operation limits and approval boundaries", async () => {
  const readme = await readFile(path.resolve("README.md"), "utf8");
  assert.match(readme, /Do not hand-edit or remove internal migration-management files/);
  assert.match(readme, /stage\/journal rehash is a known LIMIT/);
  assert.ok(readme.includes("`privateRevisionHash` is checked only against a same-process issued plan at commit"));
  assert.match(readme, /claim-absent\/record-present window/);
  assert.match(readme, /fresh review and new generation with fresh/);
  assert.match(readme, /per-sensitive-path, and final approvals/);
  assert.match(readme, /v4 journals do not have the start inventory/);
  assert.match(readme, /not general history or a restore feature/);
  assert.match(readme, /Migration \(M\) and items deletion \(D\) each require separate approval/);
  assert.match(readme, /items-only content and new `sources` additions are not supported/);
  assert.match(readme, /a `ready` preview is not proof that migration can be committed/);
  assert.match(readme, /macOS arm64.*filesystem capability/s);
  assert.match(readme, /read-only check for the supported platform, packaged helper, and filesystem capability/);
  assert.match(readme, /stops before the first filesystem write/);
  assert.match(readme, /nearest existing directory ancestor/);
  assert.match(readme, /no ordinary rename or copy fallback is used/);
  assert.match(readme, /do not move, rename, or replace the library root, `sources\/`, or a saved item's management directory/);
  assert.match(readme, /editor.*file replacement.*skill.*additions and removals/s);
  assert.match(readme, /`copi migrate --resolve --dry-run`.*`copi migrate --resolve`/s);
  assert.match(readme, /v4.*unknown.*incomplete.*held/s);
  assert.match(readme, /existing `.migration-backups\/`.*blocked.*not adopted automatically/s);
  assert.match(readme, /offline preservation check.*separate explicit approval/s);
  assert.match(readme, /never manually remove, move, or restore.*migration backup/i);
});
