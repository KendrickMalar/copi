import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string, timeoutMilliseconds = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${output} ${errorOutput}`)), timeoutMilliseconds);
    child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before expected output (${code ?? signal}): ${output} ${errorOutput}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMilliseconds = 3_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for child exit.")), timeoutMilliseconds);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

test("StorageTransactions.run acquires the root lease before issuing a mutation session", async () => {
  const { acquireRootLease } = await import("../src/storage-root-lease.ts");
  const { StorageTransactions } = await import("../src/storage-transaction.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-root-lease-gate-"));
  const lease = await acquireRootLease(root);
  let callbackCalled = false;
  try {
    await assert.rejects(
      new StorageTransactions({ waitMilliseconds: 0 }).run(root, false, async () => { callbackCalled = true; }),
      /lease|leased/i,
    );
    assert.equal(callbackCalled, false);
  } finally {
    await lease.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("StorageTransactions.run waits for a cooperating root lease and proceeds after release", async () => {
  const { StorageTransactions } = await import("../src/storage-transaction.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-root-lease-wait-"));
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondCalled = false;
  try {
    const first = new StorageTransactions({ waitMilliseconds: 1_000 }).run(root, false, async () => {
      enteredFirst();
      await firstGate;
    });
    await firstEntered;
    const second = new StorageTransactions({ waitMilliseconds: 1_000 }).run(root, false, async () => {
      secondCalled = true;
    }).then(() => true, () => false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(secondCalled, false, "a competing writer must not enter while the first root lease is held");
    releaseFirst();
    await first;
    assert.equal(await second, true, "the waiting writer should proceed after the OS lease is released");
    assert.equal(secondCalled, true);
  } finally {
    releaseFirst();
    await rm(root, { recursive: true, force: true });
  }
});

test("root O_EXLOCK lease excludes another process and releases after SIGKILL", async () => {
  assert.equal(process.platform, "darwin", "O_EXLOCK is the approved macOS root-lease primitive");
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-root-lease-"));
  const sourceExtension = import.meta.url.includes("/dist/test/") ? ".js" : ".ts";
  const scriptUrl = new URL(`../src/storage-root-lease${sourceExtension}`, import.meta.url).href;
  const childScript = `
    const { acquireRootLease } = await import(${JSON.stringify(scriptUrl)});
    const lease = await acquireRootLease(process.env.COPI_TEST_ROOT);
    process.stdout.write("LEASED\\n");
    if (process.env.COPI_HOLD_LEASE === "1") setInterval(() => {}, 1000);
    else { await lease.close(); process.stdout.write("RELEASED\\n"); }
  `;
  const childEnv = { ...process.env, COPI_TEST_ROOT: root };
  let holder: ChildProcessWithoutNullStreams | undefined;
  try {
    const spawnedHolder = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childScript], {
      env: { ...childEnv, COPI_HOLD_LEASE: "1" },
      stdio: "pipe",
    });
    holder = spawnedHolder;
    await waitForOutput(spawnedHolder, "LEASED");

    const contender = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childScript], {
      env: { ...childEnv, COPI_HOLD_LEASE: "0" },
      stdio: "pipe",
    });
    let contenderStderr = "";
    contender.stderr.on("data", (chunk: Buffer) => { contenderStderr += chunk.toString("utf8"); });
    const contenderExit = await waitForExit(contender);
    assert.notEqual(contenderExit, 0, "a concurrent process must not acquire the held root lease");
    assert.match(contenderStderr, /EAGAIN|resource temporarily unavailable|exclusive lease/i);

    spawnedHolder.kill("SIGKILL");
    assert.equal(await waitForExit(spawnedHolder), null);
    holder = undefined;

    const afterKill = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", childScript], {
      env: { ...childEnv, COPI_HOLD_LEASE: "0" },
      stdio: "pipe",
    });
    await waitForOutput(afterKill, "RELEASED");
    assert.equal(await waitForExit(afterKill), 0);
  } finally {
    holder?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
