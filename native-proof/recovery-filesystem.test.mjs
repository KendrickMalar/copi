import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

let filesystem;
try {
  filesystem = await import("./recovery-filesystem-driver.mjs");
} catch {
  filesystem = null;
}

if (!filesystem) {
  test("P2 real-filesystem recovery driver exists", () => {
    assert.ok(filesystem, "recovery-filesystem-driver.mjs is not implemented");
  });
} else {
  const {
    allocateFilesystemFixture,
    applyFilesystemPerturbation,
    createFilesystemFixture,
    perturbations,
    scratchDir,
    snapshotFilesystemFixture,
  } = filesystem;
  const driverPath = fileURLToPath(new URL("./recovery-filesystem-driver.mjs", import.meta.url));
  const checkpoints = [
    "stage-before",
    "stage-after",
    "placement-before",
    "placement-after",
    "catalog-before",
    "catalog-after",
  ];
  const forbiddenActions = [
    "retry-placement",
    "cleanup",
    "rollback",
    "adopt",
    "move",
    "delete",
    "catalog-switch",
  ];
  const rawSecret = "P2_FILESYSTEM_RAW_SECRET_MUST_NOT_BE_LOGGED";
  const stageBytes = Buffer.from("P2_FILESYSTEM_STAGE_SECRET_MUST_NOT_BE_LOGGED");

  function runChild(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [driverPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }

  function at(snapshot, components) {
    let entry = snapshot;
    for (const component of components) {
      entry = entry?.entries?.[component] ?? null;
      if (entry === null) return null;
    }
    return entry;
  }

  function assertCheckpoint(root, checkpoint, receiptPresent) {
    assert.ok(root.entries["input.raw"]);
    assert.ok(root.entries.library.entries["catalog.json"]);
    assert.ok(root.entries.library.entries.sources.entries.source.entries["payload.raw"]);
    assert.ok(root.entries.lock.entries["journal.json"]);
    assert.ok(root.entries.lock.entries["owner.json"]);
    assert.ok(root.entries.lock.entries["unknown.raw"]);
    assert.equal(Boolean(root.entries.lock.entries["receipt.json"]), receiptPresent);

    const stageExpected = checkpoint === "stage-after"
      || checkpoint === "placement-before";
    const placementExpected = checkpoint === "placement-after"
      || checkpoint === "catalog-before"
      || checkpoint === "catalog-after";
    assert.equal(Boolean(root.entries.lock.entries.stage), stageExpected);
    assert.equal(Boolean(root.entries.library.entries.sources.entries.placed), placementExpected);
    assert.equal(Boolean(root.entries.lock.entries["held-catalog"]), checkpoint === "catalog-after");
  }

  function assertStoppedRecovery(recovery, receiptPresent) {
    assert.equal(recovery.decision.status, "stopped");
    assert.equal(
      recovery.decision.reason,
      receiptPresent ? "receipt-present-cleanup-unproven" : "receipt-absent-owner-unknown",
    );
    assert.deepEqual(recovery.decision.automaticActions, []);
    for (const retained of [
      "journal",
      "lock-owner-marker",
      "stage-or-placed-object",
      "input",
      "catalog-and-held-catalog",
      "source",
      "unknown-bytes",
    ]) assert.ok(recovery.decision.retainedPaths.includes(retained), retained);
    assert.ok(recovery.decision.manualReview.some((note) => note.includes("separate approval")));
    assert.deepEqual(recovery.refusedActions, forbiddenActions);
  }

  async function recoverInNewProcess(fixture, receiptPresent) {
    const result = await runChild(["--recover", fixture.root, fixture.outsideRoot]);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const recovery = JSON.parse(result.stdout);
    assert.notEqual(recovery.processId, process.pid, "recovery decision must run in a separate process");
    assert.equal(recovery.receiptPresent, receiptPresent);
    assert.deepEqual(recovery.before, recovery.after, "recovery decision mutated filesystem state");
    assertStoppedRecovery(recovery, receiptPresent);
    assert.doesNotMatch(JSON.stringify(recovery), new RegExp(rawSecret));
    const after = await snapshotFilesystemFixture(fixture);
    assert.deepEqual(after, recovery.after, "on-disk state changed after the recovery process returned");
    return recovery;
  }

  function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  }

  function assertPerturbation(perturbation, before, after) {
    const lock = after.root.entries.lock;
    const currentSources = after.root.entries.library.entries.sources;
    const currentPlaced = currentSources.entries.placed;
    const outside = after.outside.entries;
    switch (perturbation) {
      case "same-inode-edit": {
        const oldPayload = at(before.root, ["library", "sources", "placed", "payload.raw"]);
        const newPayload = at(after.root, ["library", "sources", "placed", "payload.raw"]);
        assert.deepEqual({ dev: newPayload.dev, ino: newPayload.ino }, { dev: oldPayload.dev, ino: oldPayload.ino });
        assert.notEqual(newPayload.sha256, oldPayload.sha256);
        break;
      }
      case "samebytes-new-inode": {
        const oldPlaced = at(before.root, ["library", "sources", "placed"]);
        const held = outside["held-stage"];
        assert.ok(held);
        assert.equal(currentPlaced.sha256, oldPlaced.sha256);
        assert.equal(held.sha256, oldPlaced.sha256);
        assert.notDeepEqual({ dev: currentPlaced.dev, ino: currentPlaced.ino }, { dev: held.dev, ino: held.ino });
        break;
      }
      case "unknown-next-entry":
        assert.ok(lock.entries["next-0"]);
        break;
      case "unknown-old-entry":
        assert.ok(lock.entries["old-0"]);
        break;
      case "unknown-displaced-entry":
        assert.ok(lock.entries["displaced-0"]);
        break;
      case "unknown-child":
        assert.ok(currentPlaced.entries["unknown-child.raw"]);
        break;
      case "parent-replaced": {
        const original = outside["parent-original"];
        assert.ok(original?.entries.placed);
        assert.notDeepEqual(
          { dev: currentSources.dev, ino: currentSources.ino },
          { dev: original.dev, ino: original.ino },
        );
        break;
      }
      case "ancestor-replaced": {
        const original = outside["ancestor-original"];
        const currentLibrary = after.root.entries.library;
        assert.ok(original?.entries.sources.entries.placed);
        assert.notDeepEqual(
          { dev: currentLibrary.dev, ino: currentLibrary.ino },
          { dev: original.dev, ino: original.ino },
        );
        break;
      }
      case "opened-parent-outside-root": {
        const movedParent = outside["opened-parent-outside"];
        const previousParent = before.root.entries.library.entries.sources;
        assert.ok(movedParent?.entries.placed);
        assert.deepEqual(
          { dev: movedParent.dev, ino: movedParent.ino },
          { dev: previousParent.dev, ino: previousParent.ino },
        );
        break;
      }
      case "source-basename-replaced": {
        const held = outside["held-source"];
        assert.ok(held);
        assert.equal(currentPlaced.sha256, held.sha256);
        assert.notDeepEqual({ dev: currentPlaced.dev, ino: currentPlaced.ino }, { dev: held.dev, ino: held.ino });
        break;
      }
      default:
        assert.fail(`unrecognized filesystem perturbation: ${perturbation}`);
    }
  }

  for (const checkpoint of checkpoints) {
    for (const receiptPresent of [false, true]) {
      test(`SIGKILL retains real filesystem state at ${checkpoint}; receipt=${receiptPresent}`, async () => {
        const fixture = await allocateFilesystemFixture();
        assert.ok(fixture.root.startsWith(scratchDir));
        assert.ok(fixture.outsideRoot.startsWith(scratchDir));
        const killed = await runChild([
          "--crash-checkpoint",
          fixture.root,
          fixture.outsideRoot,
          checkpoint,
          String(receiptPresent),
        ]);
        assert.equal(killed.signal, "SIGKILL", killed.stderr);
        assert.doesNotMatch(killed.stderr, new RegExp(rawSecret));

        const recovery = await recoverInNewProcess(fixture, receiptPresent);
        assertCheckpoint(recovery.after.root, checkpoint, receiptPresent);
        assert.equal(recovery.crashCheckpoint, checkpoint);
        console.log(JSON.stringify({
          label: "filesystem-sigkill-checkpoint",
          checkpoint,
          receiptPresent,
          processId: recovery.processId,
          before: recovery.before,
          after: recovery.after,
          decision: recovery.decision,
          refusedActions: recovery.refusedActions,
        }));
      });
    }
  }

  for (const perturbation of perturbations) {
    test(`real filesystem stop preserves ${perturbation} without further mutation`, async () => {
      const fixture = await createFilesystemFixture({ checkpoint: "placement-after", receiptPresent: true });
      const beforePerturbation = await snapshotFilesystemFixture(fixture);
      await applyFilesystemPerturbation(fixture, perturbation);
      const beforeStop = await snapshotFilesystemFixture(fixture);
      assertPerturbation(perturbation, beforePerturbation, beforeStop);

      const recovery = await recoverInNewProcess(fixture, true);
      assert.deepEqual(recovery.before, beforeStop, "new recovery process observed a different pre-stop tree");
      console.log(JSON.stringify({
        label: "filesystem-perturbation-stop",
        perturbation,
        before: recovery.before,
        after: recovery.after,
        decision: recovery.decision,
        refusedActions: recovery.refusedActions,
      }));
    });
  }

  test("matching stage mode and hash without a receipt still cannot authorize adoption", async () => {
    const fixture = await createFilesystemFixture({ checkpoint: "stage-after", receiptPresent: false });
    const before = await snapshotFilesystemFixture(fixture);
    const stage = at(before.root, ["lock", "stage"]);
    const expectedPayloadHash = sha256(stageBytes);
    const expectedTreeHash = sha256(Buffer.from(`payload.raw\0${expectedPayloadHash}`));
    assert.equal(stage.mode, 0o700);
    assert.equal(stage.sha256, expectedTreeHash);

    const recovery = await recoverInNewProcess(fixture, false);
    assert.equal(recovery.decision.reason, "receipt-absent-owner-unknown");
    assert.ok(recovery.refusedActions.includes("adopt"));
    console.log(JSON.stringify({
      label: "filesystem-matching-mode-hash-without-receipt",
      stage: { dev: stage.dev, ino: stage.ino, mode: stage.mode, sha256: stage.sha256 },
      receiptPresent: false,
      decision: recovery.decision,
      refusedActions: recovery.refusedActions,
      state: recovery.after,
    }));
  });

  test("catalog-after with a durable receipt remains locked and cannot be automatically cleaned", async () => {
    const fixture = await createFilesystemFixture({ checkpoint: "catalog-after", receiptPresent: true });
    const before = await snapshotFilesystemFixture(fixture);
    assertCheckpoint(before.root, "catalog-after", true);
    const lockBefore = before.root.entries.lock;
    const currentCatalog = before.root.entries.library.entries["catalog.json"];
    const heldCatalog = lockBefore.entries["held-catalog"];
    assert.ok(lockBefore.entries["journal.json"]);
    assert.ok(lockBefore.entries["owner.json"]);
    assert.notEqual(currentCatalog.sha256, heldCatalog.sha256);

    const recovery = await recoverInNewProcess(fixture, true);
    assert.equal(recovery.decision.reason, "receipt-present-cleanup-unproven");
    assert.deepEqual(recovery.decision.automaticActions, []);
    assert.ok(recovery.decision.manualReview.some((note) => note.includes("separate approval")));
    console.log(JSON.stringify({
      label: "filesystem-catalog-after-retained-lock",
      currentCatalog: { dev: currentCatalog.dev, ino: currentCatalog.ino, mode: currentCatalog.mode, sha256: currentCatalog.sha256 },
      heldCatalog: { dev: heldCatalog.dev, ino: heldCatalog.ino, mode: heldCatalog.mode, sha256: heldCatalog.sha256 },
      state: recovery.after,
      decision: recovery.decision,
      refusedActions: recovery.refusedActions,
    }));
  });
}
