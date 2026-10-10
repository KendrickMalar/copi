import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { prepareMigration, readMigration } from "../src/migration.ts";
import { scanMigrationInventory } from "../src/migration-inventory.ts";
import { createLegacyLibrary, makeLegacyItem, treeSnapshot, writeBytes, writeLegacyCatalog, writeLegacySnapshot } from "./helpers/legacy-library.ts";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const migrationUrl = new URL("../src/migration.js", import.meta.url).href;

type EditKind = "A-same-inode" | "A-editor-replacement" | "B-skill-addition" | "C-skill-deletion";
type Window = "backup-generation-open" | "stage-built-before-old-catalog-link" | "journal-install-before-link" | "journal-install-after-link";
const editKinds: readonly EditKind[] = ["A-same-inode", "A-editor-replacement", "B-skill-addition", "C-skill-deletion"];
const windows: readonly Window[] = [
  "backup-generation-open",
  "stage-built-before-old-catalog-link",
  "journal-install-before-link",
  "journal-install-after-link",
];

interface Fixture {
  root: string;
  dispose: () => Promise<void>;
  sourcePath: string;
  skillRoot?: string;
  removablePath?: string;
}

async function fixture(kind: EditKind): Promise<Fixture> {
  const box = await createLegacyLibrary();
  if (kind === "B-skill-addition" || kind === "C-skill-deletion") {
    const skillRoot = path.join(box.root, "sources/skill");
    const skillBytes = Buffer.from("# R4 window edit skill\noriginal body\n");
    const removableBytes = Buffer.from("baseline included helper\n");
    const sourcePath = await writeBytes(box.root, "sources/skill/SKILL.md", skillBytes, 0o640);
    const removablePath = await writeBytes(box.root, "sources/skill/remove-me.md", removableBytes, 0o600);
    const item = makeLegacyItem({
      kind: "skill",
      sourcePath: skillRoot,
      files: [
        { path: "SKILL.md", mode: 0o640, sha256: sha256(skillBytes) },
        { path: "remove-me.md", mode: 0o600, sha256: sha256(removableBytes) },
      ],
    });
    await writeLegacyCatalog(box.root, [item]);
    await writeLegacySnapshot(box.root, skillBytes, `items/${item.id}/files/SKILL.md`, 0o640);
    await writeLegacySnapshot(box.root, removableBytes, `items/${item.id}/files/remove-me.md`, 0o600);
    return { ...box, sourcePath, skillRoot, removablePath };
  }
  const sourcePath = await writeBytes(box.root, "sources/current/AGENTS.md", Buffer.from("original adopted source\n"), 0o640);
  await writeLegacyCatalog(box.root, [makeLegacyItem({ sourcePath })]);
  await writeLegacySnapshot(box.root);
  return { ...box, sourcePath };
}

async function maybeTree(target: string): Promise<string | null> {
  try { return await treeSnapshot(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function state(root: string) {
  return {
    catalog: await maybeTree(path.join(root, "catalog.json")),
    items: await maybeTree(path.join(root, "items")),
    sources: await scanMigrationInventory(path.join(root, "sources")),
    backup: await maybeTree(path.join(root, ".migration-backups")),
    transaction: await maybeTree(path.join(root, ".copi-transaction")),
    recovery: await maybeTree(path.join(root, ".copi-transaction-recovery")),
    resolution: await maybeTree(path.join(root, ".copi-migration-resolution.json")),
  };
}

function payloadPath(box: Fixture, kind: EditKind): string {
  if (kind === "B-skill-addition") return path.join(box.skillRoot!, "new-helper.md");
  if (kind === "C-skill-deletion") return box.removablePath!;
  return box.sourcePath;
}

function childScript(window: Window): string {
  return `
    const { writeSync } = await import("node:fs");
    const { default: fs } = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const path = (await import("node:path")).default;
    const api = await import(${JSON.stringify(migrationUrl)});
    const root = process.argv[1];
    const kind = process.argv[2];
    const window = process.argv[3];
    const editedBytes = Buffer.from("ordinary R4 window edit " + window + "/" + kind + "\\n");
    const applyExternalEdit = async () => {
      if (kind === "A-same-inode") {
        await fs.writeFile(path.join(root, "sources/current/AGENTS.md"), editedBytes);
      } else if (kind === "A-editor-replacement") {
        const target = path.join(root, "sources/current/AGENTS.md");
        const current = await fs.lstat(target);
        const temporary = target + ".editor-replacement-" + process.pid;
        await fs.writeFile(temporary, editedBytes, { mode: current.mode & 0o777 });
        await fs.chmod(temporary, current.mode & 0o777);
        await fs.rename(temporary, target);
      } else if (kind === "B-skill-addition") {
        const target = path.join(root, "sources/skill/new-helper.md");
        await fs.writeFile(target, editedBytes, { flag: "wx", mode: 0o751 });
        await fs.chmod(target, 0o751);
      } else if (kind === "C-skill-deletion") {
        await fs.unlink(path.join(root, "sources/skill/remove-me.md"));
      } else {
        throw new Error("unknown external edit kind: " + kind);
      }
      writeSync(1, "S8_EXTERNAL_EDIT_COMPLETE:" + kind + "\\n");
    };
    const plan = await api.prepareMigration(root);
    const view = api.readMigration(plan);
    if (view.status !== "ready") throw new Error("prepare blocked: " + JSON.stringify(view.conflicts));
    writeSync(1, "S8_PREPARED:ready\\n");
    let reached = false;
    if (window === "backup-generation-open") {
      const originalOpen = fs.open.bind(fs);
      fs.open = async (target, ...args) => {
        const handle = await originalOpen(target, ...args);
        const destination = String(target);
        if (!reached && destination.includes("/.migration-backups/") && destination.includes("/files/")) {
          reached = true;
          writeSync(1, "S8_WINDOW_REACHED:backup-generation-open-before-first-payload-write\\n");
          await applyExternalEdit();
          process.kill(process.pid, "SIGKILL");
        }
        return handle;
      };
    } else {
      const originalLink = fs.link.bind(fs);
      fs.link = async (source, target) => {
        const destination = String(target);
        const stageBuilt = window === "stage-built-before-old-catalog-link" && destination.endsWith("/.copi-transaction/old-catalog");
        const journal = destination.endsWith("/.copi-transaction/journal.json");
        const journalBefore = window === "journal-install-before-link" && journal;
        const journalAfter = window === "journal-install-after-link" && journal;
        if (!reached && (stageBuilt || journalBefore || journalAfter)) {
          reached = true;
          if (journalAfter) await originalLink(source, target);
          writeSync(1, "S8_WINDOW_REACHED:" + window + "\\n");
          await applyExternalEdit();
          process.kill(process.pid, "SIGKILL");
        }
        return originalLink(source, target);
      };
    }
    syncBuiltinESMExports();
    await api.commitMigration(plan, { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths: [...view.sensitivePaths] });
    writeSync(1, "S8_UNEXPECTED:commit-returned\\n");
    process.exitCode = 70;
  `;
}

function runWindow(box: Fixture, window: Window, kind: EditKind): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "-e", childScript(window), box.root, kind, window], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

// Set COPI_TEST_TRACE=1 to print each matrix cell for diagnosis.
function logCell(value: Record<string, unknown>): void {
  if (process.env.COPI_TEST_TRACE) console.log(`R4-FINAL-S8-WINDOW ${JSON.stringify(value)}`);
}

test("S8: ordinary edits during backup generation and stage/journal install windows are preserved", async (t) => {
  for (const window of windows) for (const kind of editKinds) await t.test(`${window}/${kind}`, async () => {
    const box = await fixture(kind);
    const target = payloadPath(box, kind);
    try {
      const original = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const child = runWindow(box, window, kind);
      assert.equal(child.signal, "SIGKILL", `${child.stdout}\n${child.stderr}`);
      assert.match(String(child.stdout), /S8_PREPARED:ready/);
      assert.match(String(child.stdout), new RegExp(`S8_WINDOW_REACHED:${window}`));
      assert.match(String(child.stdout), new RegExp(`S8_EXTERNAL_EDIT_COMPLETE:${kind}`));
      assert.doesNotMatch(String(child.stdout), /S8_UNEXPECTED/);

      const expectedBytes = Buffer.from(`ordinary R4 window edit ${window}/${kind}\n`);
      if (kind === "A-same-inode") {
        const edited = await lstat(target);
        assert.equal(edited.ino, original!.ino, "in-place edit must preserve the registered file inode");
      } else if (kind === "A-editor-replacement") {
        const edited = await lstat(target);
        assert.notEqual(edited.ino, original!.ino, "editor save must replace the registered file inode");
      } else if (kind === "B-skill-addition") {
        assert.equal((await lstat(target)).mode & 0o777, 0o751, "ordinary new skill file mode must be retained");
      } else {
        await assert.rejects(lstat(target), { code: "ENOENT" }, "ordinary skill file deletion must take effect");
      }

      const atCrash = await state(box.root);
      if (kind === "A-same-inode" || kind === "A-editor-replacement" || kind === "B-skill-addition") {
        const bytes = await (await import("node:fs/promises")).readFile(target);
        assert.deepEqual(bytes, expectedBytes, "the injected ordinary edit must be present before recovery");
      }
      const recovered = await loadCatalog(box.root).then(
        (catalog) => ({ outcome: "returned" as const, version: catalog.version }),
        (error: unknown) => ({ outcome: "safe-stop" as const, message: error instanceof Error ? error.message : String(error) }),
      );
      if (window === "backup-generation-open") {
        assert.deepEqual(recovered, { outcome: "returned", version: 1 }, "backup interruption must leave the legacy catalog readable");
      } else {
        assert.equal(recovered.outcome, "safe-stop", "incomplete stage/journal installation must not be auto-repaired");
      }
      const afterRecovery = await state(box.root);
      assert.deepEqual(afterRecovery.sources, atCrash.sources, "recovery must preserve every source node identity, mode and bytes");
      assert.deepEqual(afterRecovery.catalog, atCrash.catalog, "pre-switch crash must preserve the original catalog inode and bytes");
      assert.deepEqual(afterRecovery.items, atCrash.items, "legacy items remain unchanged");
      assert.deepEqual(afterRecovery.backup, atCrash.backup, "partial or complete backup custody must remain unchanged");
      if (window !== "backup-generation-open") {
        assert.deepEqual(afterRecovery.transaction, atCrash.transaction, "incomplete journal/stage artifacts must remain byte/inode/metadata-identical");
      }

      const retry = await prepareMigration(box.root);
      const retryView = readMigration(retry);
      assert.equal(retryView.status, "blocked", "partial backup or incomplete transaction must prevent retry");
      const afterRetry = await state(box.root);
      assert.deepEqual(afterRetry, afterRecovery, "blocked retry preview must be read-only");
      logCell({
        checkpoint: window,
        edit: kind,
        childExit: { code: child.status, signal: child.signal },
        reached: String(child.stdout).match(/S8_WINDOW_REACHED:[^\r\n]+/)?.[0],
        externalEdit: String(child.stdout).match(/S8_EXTERNAL_EDIT_COMPLETE:[^\r\n]+/)?.[0],
        sourcesAtCrash: atCrash.sources,
        sourcesAfterRecovery: afterRecovery.sources,
        catalogAtCrash: atCrash.catalog,
        backupAtCrash: atCrash.backup,
        artifactsAtCrash: { transaction: atCrash.transaction, recovery: atCrash.recovery, resolution: atCrash.resolution },
        recovery: recovered,
        retry: { status: retryView.status, conflicts: [...retryView.conflicts], preservedPaths: [...retryView.preservedPaths] },
      });
    } finally { await box.dispose(); }
  });
});
