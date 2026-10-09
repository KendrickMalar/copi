import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageTransactions, prepareStorageReview, readStorageReview, type StorageCheckpoint } from "../src/storage-transaction.ts";
import { fixtureModuleUrl, fixtureNodeArgs } from "./helpers/storage-transaction.ts";
import type { Catalog, SavedItem } from "../src/types.ts";

const coderId = "123e4567-e89b-42d3-a456-426614174000";
const testerId = "123e4567-e89b-42d3-a456-426614174001";
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function item(id: string, name: string, filename: string): SavedItem {
  return {
    id,
    kind: "subagent",
    source: "fixture",
    scope: "project",
    sourcePath: `/deleted/origin/${filename}`,
    destination: { kind: "project", path: `agents/${filename}` },
    name,
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: filename, mode: 0o644, sha256: digest(`old ${filename}\n`) }],
    content: { kind: "file", path: `sources/agents/${filename}` },
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-v2-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, ".copi");
  const agents = path.join(libraryDir, "sources", "agents");
  await mkdir(agents, { recursive: true, mode: 0o700 });
  const coderPath = path.join(agents, "coder.md");
  const testerPath = path.join(agents, "tester.md");
  const notePath = path.join(agents, "note.md");
  await Promise.all([
    writeFile(coderPath, "old coder\n", { mode: 0o600 }),
    writeFile(testerPath, "neighbor tester\n", { mode: 0o600 }),
    writeFile(notePath, "unregistered note\n", { mode: 0o600 }),
  ]);
  const catalog: Catalog = { version: 2, items: [item(coderId, "Coder", "coder.md"), item(testerId, "Tester", "tester.md")], groups: [] };
  const catalogPath = path.join(libraryDir, "catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  const next = structuredClone(catalog);
  const newBytes = Buffer.from("edited coder\n");
  next.items[0]!.files[0]!.sha256 = digest(newBytes);
  const replacements = [{ itemId: coderId, files: [{ path: "coder.md", mode: 0o644, bytes: newBytes }] }];
  return { root, libraryDir, agents, coderPath, testerPath, notePath, catalogPath, catalog, next, newBytes, replacements };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function atomicReplace(target: string, bytes: Buffer): Promise<{ dev: number; ino: number }> {
  const temporary = `${target}.editor-${randomUUID()}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  const stat = await lstat(target);
  return { dev: stat.dev, ino: stat.ino };
}

async function commit(box: Fixture, checkpoint?: (point: StorageCheckpoint, root: string) => void | Promise<void>) {
  const kernel = new StorageTransactions(checkpoint === undefined ? {} : { checkpoint });
  return kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`), box.replacements);
  }, { requiresNativePlacement: false });
}

function child(box: Fixture, checkpoint: string, orphanName?: string): ChildProcessWithoutNullStreams {
  const moduleUrl = fixtureModuleUrl(import.meta.url, "../src/storage-transaction");
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`).toString("base64");
  const orphanBytes = Buffer.from("unknown cleanup bytes\\n").toString("base64");
  const orphanWrite = orphanName
    ? `await writeFile(${JSON.stringify(path.join(box.libraryDir, ".copi-transaction", orphanName))},Buffer.from(${JSON.stringify(orphanBytes)},'base64'));`
    : "";
  const code = `import {writeFile} from 'node:fs/promises'; import {StorageTransactions} from ${JSON.stringify(moduleUrl)};
const kernel=new StorageTransactions({checkpoint:async(point)=>{if(point===${JSON.stringify(checkpoint)}) { ${orphanWrite} console.log('PAUSED'); setInterval(()=>{},1000); await new Promise(()=>{}); }}});
await kernel.run(${JSON.stringify(box.libraryDir)},false,async(session)=>session.commit(await session.capture(),Buffer.from(${JSON.stringify(catalogBytes)},'base64'),[{itemId:${JSON.stringify(coderId)},files:[{path:'coder.md',mode:420,bytes:Buffer.from('edited coder\\n')}]}]),{requiresNativePlacement:false});`;
  return spawn(process.execPath, fixtureNodeArgs(import.meta.url, code), { env: process.env });
}

async function stopAt(childProcess: ChildProcessWithoutNullStreams, marker = "PAUSED"): Promise<void> {
  let output = "";
  let errors = "";
  const diagnostics = () => [output && `stdout: ${output}`, errors && `stderr: ${errors}`].filter(Boolean).join("\n");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not reach ${marker}: ${diagnostics()}`)), 10_000);
    childProcess.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) { clearTimeout(timeout); resolve(); }
    });
    childProcess.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    childProcess.once("error", (error) => { clearTimeout(timeout); reject(error); });
    childProcess.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!output.includes(marker)) reject(new Error(`child exited before ${marker} (${code}/${signal}): ${diagnostics()}`));
    });
  });
  childProcess.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    childProcess.once("close", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`expected SIGKILL, got ${signal}`)));
  });
}

async function crashedFixture(t: test.TestContext, checkpoint: string, orphanName?: string) {
  const box = await fixture(t);
  const writer = child(box, checkpoint, orphanName);
  await stopAt(writer);
  return box;
}

async function recover(box: Fixture): Promise<void> {
  await new StorageTransactions({ waitMilliseconds: 100 }).run(box.libraryDir, false, async () => {}, { requiresNativePlacement: false });
}

test("registered v2 file replacement swaps only its sources file and preserves neighbor/unregistered inode identities", async (t) => {
  const box = await fixture(t);
  const testerBefore = await lstat(box.testerPath);
  const noteBefore = await lstat(box.notePath);
  const directoryBefore = await lstat(box.agents);
  await commit(box);
  assert.equal(await readFile(box.coderPath, "utf8"), "edited coder\n");
  assert.equal((await lstat(box.coderPath)).mode & 0o777, 0o600);
  for (const [file, prior, bytes] of [[box.testerPath, testerBefore, "neighbor tester\n"], [box.notePath, noteBefore, "unregistered note\n"]] as const) {
    const after = await lstat(file);
    assert.equal(await readFile(file, "utf8"), bytes);
    assert.equal(`${after.dev}:${after.ino}`, `${prior.dev}:${prior.ino}`);
  }
  const directoryAfter = await lstat(box.agents);
  assert.equal(`${directoryAfter.dev}:${directoryAfter.ino}`, `${directoryBefore.dev}:${directoryBefore.ino}`);
  assert.deepEqual((await readdir(box.agents)).sort(), ["coder.md", "note.md", "tester.md"]);
});

test("v2 rollback restores the original file inode and leaves adjacent sources untouched", async (t) => {
  const box = await fixture(t);
  const coderBefore = await lstat(box.coderPath);
  const testerBefore = await lstat(box.testerPath);
  await assert.rejects(commit(box, (point) => { if (point === "before-catalog") throw new Error("cancel before catalog"); }), /cancel before catalog/);
  const coderAfter = await lstat(box.coderPath);
  const testerAfter = await lstat(box.testerPath);
  assert.deepEqual(await readFile(box.coderPath, "utf8"), "old coder\n");
  assert.deepEqual(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
  assert.equal(`${coderAfter.dev}:${coderAfter.ino}`, `${coderBefore.dev}:${coderBefore.ino}`);
  assert.equal(`${testerAfter.dev}:${testerAfter.ino}`, `${testerBefore.dev}:${testerBefore.ino}`);
  assert.deepEqual((await readdir(box.libraryDir)).sort(), ["catalog.json", "sources"]);
});

test("file transactions can commit twice after a direct edit and leave no lock residue", async (t) => {
  const box = await fixture(t);
  await commit(box);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
  const manual = Buffer.from("directly edited after first commit\n");
  await writeFile(box.coderPath, manual);
  const reviewed = Buffer.from("second reviewed version\n");
  box.next.items[0]!.files[0]!.sha256 = digest(reviewed);
  box.replacements[0]!.files[0]!.bytes = reviewed;
  await commit(box);
  assert.deepEqual(await readFile(box.coderPath), reviewed);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("SIGKILL during source-file rollback recovery can be recovered again", async (t) => {
  const box = await fixture(t);
  const moduleUrl = fixtureModuleUrl(import.meta.url, "../src/storage-transaction");
  const catalogBytes = Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`).toString("base64");
  const code = `import {StorageTransactions} from ${JSON.stringify(moduleUrl)};
const kernel=new StorageTransactions({checkpoint:async(point)=>{if(point==='before-catalog')throw new Error('start rollback');if(point==='rollback-restored'){console.log('ROLLBACK_PAUSED');setInterval(()=>{},1000);await new Promise(()=>{});}}});
await kernel.run(${JSON.stringify(box.libraryDir)},false,async(session)=>session.commit(await session.capture(),Buffer.from(${JSON.stringify(catalogBytes)},'base64'),[{itemId:${JSON.stringify(coderId)},files:[{path:'coder.md',mode:420,bytes:Buffer.from('edited coder\\n')}]}]),{requiresNativePlacement:false});`;
  const writer = spawn(process.execPath, fixtureNodeArgs(import.meta.url, code), { env: process.env });
  await stopAt(writer, "ROLLBACK_PAUSED");
  await recover(box);
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.catalog);
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("v2 journal recovery rolls an interrupted file swap back without changing neighbors", async (t) => {
  const box = await crashedFixture(t, "new-renamed");
  await recover(box);
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");
  assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
  assert.equal(await readFile(box.notePath, "utf8"), "unregistered note\n");
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("v2 journal recovery accepts a catalog-swapped commit and finalizes the sources file", async (t) => {
  const box = await crashedFixture(t, "catalog-renamed");
  await recover(box);
  assert.equal(await readFile(box.coderPath, "utf8"), "edited coder\n");
  assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
  await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
});

test("v2 commit keeps direct pre-capture edits as the old source revision and installs reviewed current bytes", async (t) => {
  const box = await fixture(t);
  await writeFile(box.coderPath, "manual before review\n");
  const before = structuredClone(box.next);
  const bytes = Buffer.from("approved after manual edit\n");
  before.items[0]!.files[0]!.sha256 = digest(bytes);
  const replacements = [{ itemId: coderId, files: [{ path: "coder.md", mode: 0o644, bytes }] }];
  const kernel = new StorageTransactions();
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), Buffer.from(`${JSON.stringify(before, null, 2)}\n`), replacements);
  }, { requiresNativePlacement: false });
  assert.equal(await readFile(box.coderPath, "utf8"), "approved after manual edit\n");
});

test("v2 commit rejects stale same-inode and atomic edits made after capture", async (t) => {
  for (const edit of ["same-inode", "atomic-replace"] as const) {
    await t.test(edit, async (st) => {
      const box = await fixture(st);
      const external = Buffer.from(`external after capture ${edit}\n`);
      let externalIdentity: { dev: number; ino: number } | undefined;
      const kernel = new StorageTransactions();
      await kernel.run(box.libraryDir, false, async (session) => {
        assert.ok(session);
        const revision = await session.capture();
        if (edit === "same-inode") await writeFile(box.coderPath, external);
        else externalIdentity = await atomicReplace(box.coderPath, external);
        await assert.rejects(session.commit(revision, Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`), box.replacements), /changed|revision/i);
      }, { requiresNativePlacement: false });
      assert.deepEqual(await readFile(box.coderPath), external);
      if (externalIdentity) {
        const stat = await lstat(box.coderPath);
        assert.equal(`${stat.dev}:${stat.ino}`, `${externalIdentity.dev}:${externalIdentity.ino}`);
      }
      assert.deepEqual(await readFile(box.catalogPath), Buffer.from(`${JSON.stringify(box.catalog, null, 2)}\n`));
      await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
    });
  }
});

test("v2 commit rejects and preserves same-inode external edits at before-swap, old-renamed, and before-catalog", async (t) => {
  for (const checkpoint of ["before-swap", "old-renamed", "before-catalog"] as const) {
    await t.test(checkpoint, async (st) => {
      const box = await fixture(st);
      const external = `external ${checkpoint}\n`;
      await assert.rejects(commit(box, async (point, root) => {
        if (point !== checkpoint) return;
        const target = checkpoint === "old-renamed"
          ? path.join(root, ".copi-transaction", "old-0")
          : box.coderPath;
        await writeFile(target, external);
        throw new Error(`inject ${checkpoint}`);
      }), /could not safely recover|inject|changed|external/i);
      const possible = [box.coderPath, path.join(box.libraryDir, ".copi-transaction", "old-0"), path.join(box.libraryDir, ".copi-transaction", "displaced-0")];
      const preserved = await Promise.all(possible.map((file) => readFile(file, "utf8").catch(() => "")));
      assert.ok(preserved.includes(external), `external same-inode bytes were lost at ${checkpoint}`);
      assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
    });
  }
});

test("v2 commit preserves atomic editor replacements at each live file swap boundary", async (t) => {
  for (const checkpoint of ["before-swap", "old-renamed", "before-catalog"] as const) {
    await t.test(checkpoint, async (st) => {
      const box = await fixture(st);
      const external = Buffer.from(`atomic external ${checkpoint}\n`);
      const original = await lstat(box.coderPath);
      let externalIdentity: { dev: number; ino: number } | undefined;
      await assert.rejects(commit(box, async (point) => {
        if (point !== checkpoint) return;
        if (checkpoint === "old-renamed") {
          // An editor saving by rename creates a new live path while the prior inode is held.
          externalIdentity = await atomicReplace(box.coderPath, external);
        } else externalIdentity = await atomicReplace(box.coderPath, external);
        throw new Error(`atomic editor save at ${checkpoint}`);
      }), /atomic editor save|changed|external|recover/i);
      const current = await lstat(box.coderPath);
      assert.equal(`${current.dev}:${current.ino}`, `${externalIdentity!.dev}:${externalIdentity!.ino}`);
      assert.deepEqual(await readFile(box.coderPath), external);
      if (checkpoint !== "before-swap") {
        const held = await lstat(path.join(box.libraryDir, ".copi-transaction", "old-0"));
        assert.equal(`${held.dev}:${held.ino}`, `${original.dev}:${original.ino}`);
      }
      assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
      assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.catalog);
    });
  }
});

test("v2 commit preserves a normal edit made at finalized and retains its journal", async (t) => {
  for (const edit of ["same-inode", "atomic-replace"] as const) {
    await t.test(edit, async (st) => {
      const box = await fixture(st);
      const external = Buffer.from(`external finalized ${edit}\n`);
      let externalIdentity: { dev: number; ino: number } | undefined;
      await assert.rejects(commit(box, async (point) => {
        if (point !== "finalized") return;
        if (edit === "same-inode") await writeFile(box.coderPath, external);
        else externalIdentity = await atomicReplace(box.coderPath, external);
      }), /changed|finalized|external|cleanup|recovery/i);
      assert.deepEqual(await readFile(box.coderPath), external);
      if (externalIdentity) {
        const stat = await lstat(box.coderPath);
        assert.equal(`${stat.dev}:${stat.ino}`, `${externalIdentity.dev}:${externalIdentity.ino}`);
      }
      assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.next);
      assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
    });
  }
});

test("finalized cleanup preserves direct and atomic edits to the held original inode", async (t) => {
  for (const edit of ["same-inode", "atomic-replace"] as const) {
    await t.test(edit, async (st) => {
      const box = await fixture(st);
      const held = path.join(box.libraryDir, ".copi-transaction", "old-0");
      const original = await lstat(box.coderPath);
      const external = Buffer.from(`external held artifact ${edit}\n`);
      let externalIdentity: { dev: number; ino: number } | undefined;
      await assert.rejects(commit(box, async (point) => {
        if (point !== "finalized") return;
        if (edit === "same-inode") await writeFile(held, external);
        else externalIdentity = await atomicReplace(held, external);
      }), /changed|cleanup|external|recovery/i);
      const retained = await lstat(held);
      if (externalIdentity) assert.equal(`${retained.dev}:${retained.ino}`, `${externalIdentity.dev}:${externalIdentity.ino}`);
      else assert.equal(`${retained.dev}:${retained.ino}`, `${original.dev}:${original.ino}`);
      assert.deepEqual(await readFile(held), external);
      assert.equal(await readFile(box.coderPath, "utf8"), "edited coder\n");
      assert.ok(await lstat(path.join(box.libraryDir, ".copi-transaction", "journal.json")));
    });
  }
});

test("v2 commit fails closed if an adjacent unregistered source changes during the swap", async (t) => {
  const box = await fixture(t);
  await assert.rejects(commit(box, async (point) => {
    if (point === "new-renamed") { await writeFile(box.notePath, "external neighbor edit\n"); throw new Error("neighbor changed"); }
  }), /could not safely recover|neighbor changed|sources|changed/i);
  assert.equal(await readFile(box.notePath, "utf8"), "external neighbor edit\n");
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");
});

test("v2 journal target tampering with a recomputed digest is rejected against both catalogs", async (t) => {
  const box = await crashedFixture(t, "journal");
  const lock = path.join(box.libraryDir, ".copi-transaction");
  const journalPath = path.join(lock, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { operations: Array<Record<string, unknown>> };
  journal.operations[0]!.target = "sources/agents/tester.md";
  const raw = Buffer.from(JSON.stringify(journal));
  await writeFile(journalPath, raw);
  await writeFile(path.join(lock, "journal.digest"), digest(raw));
  await assert.rejects(recover(box), /target|catalog|operation|journal/i);
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");
  assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
  assert.ok(await lstat(lock));
});

test("v2 journal rejects unknown versions and raw digest tampering without changing source bytes", async (t) => {
  const box = await crashedFixture(t, "journal");
  const lock = path.join(box.libraryDir, ".copi-transaction");
  const journalPath = path.join(lock, "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { version: number };
  journal.version = 77;
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(path.join(lock, "journal.digest"), digest(await readFile(journalPath)));
  await assert.rejects(recover(box), /version|journal/i);
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");

  const other = await crashedFixture(t, "journal");
  const otherLock = path.join(other.libraryDir, ".copi-transaction");
  await writeFile(path.join(otherLock, "journal.json"), "{}");
  await assert.rejects(recover(other), /digest|journal/i);
  assert.equal(await readFile(other.coderPath, "utf8"), "old coder\n");
});

test("v2 recovery refuses a symlink stage and preserves the outside inode", async (t) => {
  const box = await crashedFixture(t, "journal");
  const lock = path.join(box.libraryDir, ".copi-transaction");
  const stage = path.join(lock, "next-0");
  const outside = path.join(box.root, "outside.md");
  await writeFile(outside, "outside bytes\n");
  await rm(stage);
  await symlink(outside, stage);
  await assert.rejects(recover(box), /symbolic|unsafe|stage|file/i);
  assert.equal(await readFile(outside, "utf8"), "outside bytes\n");
  assert.ok((await lstat(stage)).isSymbolicLink());
  assert.ok(await lstat(lock));
});

test("v2 recovery refuses unknown lock artifacts and preserves their bytes before cleanup", async (t) => {
  for (const checkpoint of ["journal", "catalog-renamed"] as const) {
    for (const entry of ["next-99", "old-99", "displaced-99", "orphan.bin"] as const) {
      await t.test(`${checkpoint}/${entry}`, async (st) => {
        const box = await crashedFixture(st, checkpoint);
        const lock = path.join(box.libraryDir, ".copi-transaction");
        const artifact = path.join(lock, entry);
        const artifactBytes = Buffer.from(`unrecognized ${entry} bytes\n`);
        await writeFile(artifact, artifactBytes, { mode: 0o600 });

        await assert.rejects(recover(box), /unknown/i);

        assert.deepEqual(await readFile(artifact), artifactBytes);
        assert.ok((await lstat(lock)).isDirectory());
        assert.ok((await lstat(path.join(lock, "journal.json"))).isFile());
        assert.equal(await readFile(box.coderPath, "utf8"), checkpoint === "journal" ? "old coder\n" : "edited coder\n");
        assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
        assert.equal(await readFile(box.notePath, "utf8"), "unregistered note\n");
        assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), checkpoint === "journal" ? box.catalog : box.next);
      });
    }
  }
});

test("normal finalized cleanup refuses and preserves unknown lock artifacts", async (t) => {
  const box = await fixture(t);
  const orphanPath = path.join(box.libraryDir, ".copi-transaction", "next-99");
  const orphanBytes = Buffer.from("unknown cleanup bytes\\n");

  await assert.rejects(commit(box, async (point, root) => {
    if (point === "finalized") await writeFile(path.join(root, ".copi-transaction", "next-99"), orphanBytes, { mode: 0o600 });
  }), /unknown|artifact|cleanup|recover/i);

  assert.deepEqual(await readFile(orphanPath), orphanBytes);
  assert.equal(await readFile(box.coderPath, "utf8"), "edited coder\n");
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.next);
  assert.ok((await lstat(path.join(box.libraryDir, ".copi-transaction"))).isDirectory());
});

test("recovery after a crash with a removed journal preserves unknown finalized artifacts", async (t) => {
  const box = await crashedFixture(t, "finalized", "next-99");
  const orphanPath = path.join(box.libraryDir, ".copi-transaction", "next-99");
  const orphanBytes = Buffer.from("unknown cleanup bytes\\n");

  await assert.rejects(recover(box), /unknown|artifact|cleanup/i);

  assert.deepEqual(await readFile(orphanPath), orphanBytes);
  assert.equal(await readFile(box.coderPath, "utf8"), "edited coder\n");
  assert.deepEqual(JSON.parse(await readFile(box.catalogPath, "utf8")), box.next);
  assert.ok((await lstat(path.join(box.libraryDir, ".copi-transaction"))).isDirectory());
});

test("v1 legacy journal recovery still restores its original snapshot and catalog", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "copi-v1-recovery-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const libraryDir = path.join(temporaryRoot, ".copi");
  await mkdir(libraryDir, { mode: 0o700 });
  const canonicalLibrary = await realpath(libraryDir);
  const lock = path.join(canonicalLibrary, ".copi-transaction");
  const itemDirectory = path.join(canonicalLibrary, "items", coderId);
  const oldBytes = Buffer.from("legacy old snapshot\n");
  const newBytes = Buffer.from("legacy new snapshot\n");
  const oldItem = {
    id: coderId,
    kind: "subagent" as const,
    source: "fixture",
    scope: "project" as const,
    sourcePath: "/deleted/origin/coder.md",
    destination: { kind: "project" as const, path: "agents/coder.md" },
    name: "Coder",
    savedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "coder.md", mode: 0o600, sha256: digest(oldBytes) }],
  };
  const nextItem = structuredClone(oldItem);
  nextItem.files[0]!.sha256 = digest(newBytes);
  const oldCatalog = { version: 1 as const, items: [oldItem], groups: [] };
  const nextCatalog = { version: 1 as const, items: [nextItem], groups: [] };
  const oldCatalogBytes = Buffer.from(JSON.stringify(oldCatalog));
  const nextCatalogBytes = Buffer.from(JSON.stringify(nextCatalog));
  const snapshotTree = (bytes: Buffer) => digest(JSON.stringify([
    { path: ".", kind: "directory", value: "", mode: 0o700 },
    { path: "files", kind: "directory", value: "", mode: 0o700 },
    { path: "files/coder.md", kind: "file", value: digest(bytes), mode: 0o600 },
  ]));

  await mkdir(path.join(itemDirectory, "files"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(itemDirectory, "files", "coder.md"), newBytes, { mode: 0o600 });
  await writeFile(path.join(canonicalLibrary, "catalog.json"), oldCatalogBytes, { mode: 0o600 });
  await mkdir(lock, { mode: 0o700 });
  await mkdir(path.join(lock, "old-0", "files"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, "old-0", "files", "coder.md"), oldBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "old-catalog"), oldCatalogBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "next-catalog"), nextCatalogBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ version: 1, pid: 99_999_999, host: os.hostname(), token: coderId }), { mode: 0o600 });
  const journal = {
    version: 1 as const,
    root: canonicalLibrary,
    token: coderId,
    oldCatalog: digest(oldCatalogBytes),
    newCatalog: digest(nextCatalogBytes),
    operations: [{ itemId: coderId, oldTree: snapshotTree(oldBytes), newTree: snapshotTree(newBytes) }],
  };
  const journalBytes = Buffer.from(JSON.stringify(journal));
  await writeFile(path.join(lock, "journal.json"), journalBytes, { mode: 0o600 });
  await writeFile(path.join(lock, "journal.digest"), digest(journalBytes), { mode: 0o600 });

  await new StorageTransactions({ waitMilliseconds: 100 }).run(canonicalLibrary, false, async () => {}, { requiresNativePlacement: false });

  assert.deepEqual(await readFile(path.join(itemDirectory, "files", "coder.md")), oldBytes);
  assert.deepEqual(await readFile(path.join(canonicalLibrary, "catalog.json")), oldCatalogBytes);
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});

test("v2 staged file is private and secret approval remains opaque and per-file", async (t) => {
  const box = await fixture(t);
  const secret = Buffer.from("apiKey=sk_live_storage_v2_secret123456\n");
  const next = structuredClone(box.catalog);
  next.items[0]!.files[0]!.sha256 = digest(secret);
  const replacements = [{ itemId: coderId, files: [{ path: "coder.md", mode: 0o644, bytes: secret }] }];
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const review = prepareStorageReview(bytes, replacements);
  const approvedSensitivePaths = [`${coderId}/coder.md`];
  assert.deepEqual(readStorageReview(review).sensitivePaths, approvedSensitivePaths);
  let mode: number | undefined;
  const kernel = new StorageTransactions({ checkpoint: async (point, root) => {
    if (point === "stage-write") mode = (await lstat(path.join(root, ".copi-transaction", "next-0"))).mode & 0o777;
  } });
  await assert.rejects(kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), bytes, replacements);
  }, { requiresNativePlacement: false }), /approval|inspection/i);
  await kernel.run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), bytes, replacements, { review, approval: { reviewId: review.reviewId, confirmed: true, approvedSensitivePaths } });
  }, { requiresNativePlacement: false });
  assert.equal(mode, 0o600);
  assert.equal(await readFile(box.coderPath, "utf8"), secret.toString());
});

test("v2 transaction rejects replacement paths that do not name the registered content file", async (t) => {
  const box = await fixture(t);
  const bad = [{ itemId: coderId, files: [{ path: "tester.md", mode: 0o644, bytes: box.newBytes }] }];
  await assert.rejects(new StorageTransactions().run(box.libraryDir, false, async (session) => {
    assert.ok(session);
    await session.commit(await session.capture(), Buffer.from(`${JSON.stringify(box.next, null, 2)}\n`), bad);
  }, { requiresNativePlacement: false }), /target|content|file|path/i);
  assert.equal(await readFile(box.coderPath, "utf8"), "old coder\n");
  assert.equal(await readFile(box.testerPath, "utf8"), "neighbor tester\n");
});
