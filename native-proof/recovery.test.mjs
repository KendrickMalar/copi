import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

let prototype;
try {
  prototype = await import("./recovery-prototype.mjs");
} catch {
  prototype = null;
}

if (!prototype) {
  test("P2 pure-stop recovery module contract exists", () => {
    assert.ok(prototype, "recovery-prototype.mjs is not implemented");
  });
} else {
  const {
    authorizeNextOperation,
    createSyntheticRecoveryFixture,
    decideRecovery,
    snapshotSyntheticRecoveryFixture,
  } = prototype;

  const checkpoints = [
    "stage-before",
    "stage-after",
    "placement-before",
    "placement-after",
    "catalog-before",
    "catalog-after",
  ];
  const receiptStates = [false, true];
  const forbiddenActions = [
    "retry-placement",
    "cleanup",
    "rollback",
    "adopt",
    "move",
    "delete",
    "catalog-switch",
  ];
  const perturbations = [
    "same-inode-edit",
    "samebytes-new-inode",
    "unknown-next-entry",
    "unknown-old-entry",
    "unknown-displaced-entry",
    "unknown-child",
    "parent-replaced",
    "ancestor-replaced",
    "opened-parent-outside-root",
    "source-basename-replaced",
  ];
  const rawSecret = "P2_SYNTHETIC_RAW_SECRET_MUST_NEVER_APPEAR";

  function snapshotDigest(snapshot) {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  function snapshotSummary(snapshot) {
    const workspace = snapshot.workspace;
    const library = workspace.entries.library;
    const lock = workspace.entries.lock;
    const sources = library.entries.sources;
    const stage = lock.entries.stage ?? sources.entries.placed;
    return {
      workspace: { dev: workspace.dev, ino: workspace.ino, mode: workspace.mode, children: workspace.children },
      lock: { dev: lock.dev, ino: lock.ino, mode: lock.mode, children: lock.children },
      input: workspace.entries.input,
      journal: lock.entries["journal.json"],
      unknownRaw: lock.entries["unknown.raw"],
      catalog: library.entries["catalog.json"],
      sources: { dev: sources.dev, ino: sources.ino, mode: sources.mode, children: sources.children },
      stageOrPlaced: stage ?? null,
      namespace: snapshot.namespace,
      detachedOriginalSource: snapshot.detachedOriginalSource,
    };
  }

  function assertPerturbationWasModeled(fixture, perturbation) {
    const candidate = fixture.placed ?? fixture.stage ?? fixture.intendedStage;
    switch (perturbation) {
      case "same-inode-edit":
        assert.deepEqual({ dev: candidate.dev, ino: candidate.ino }, fixture.expectedStageIdentity);
        assert.notDeepEqual(fixture.observedStageSignature, fixture.expectedStageSignature);
        break;
      case "samebytes-new-inode":
        assert.notEqual(candidate.ino, fixture.expectedStageIdentity.ino);
        assert.deepEqual(fixture.observedStageSignature, fixture.expectedStageSignature);
        break;
      case "unknown-next-entry":
        assert.ok(fixture.lock.children["next-0"]);
        break;
      case "unknown-old-entry":
        assert.ok(fixture.lock.children["old-0"]);
        break;
      case "unknown-displaced-entry":
        assert.ok(fixture.lock.children["displaced-0"]);
        break;
      case "unknown-child":
        assert.ok(candidate.children["unknown-child.raw"]);
        break;
      case "parent-replaced":
        assert.notEqual(fixture.namespace.currentParent.ino, fixture.namespace.openedParent.ino);
        break;
      case "ancestor-replaced":
        assert.notEqual(fixture.namespace.currentAncestor.ino, fixture.namespace.openedAncestor.ino);
        break;
      case "opened-parent-outside-root":
        assert.equal(fixture.namespace.outsideRootPlacementObserved, true);
        assert.equal(fixture.namespace.parentLocation, "outside-root");
        break;
      case "source-basename-replaced":
        assert.ok(fixture.detachedOriginalSource);
        assert.notEqual(fixture.detachedOriginalSource.ino, fixture.placed.ino);
        break;
      default:
        assert.fail(`unrecognized perturbation fixture: ${perturbation}`);
    }
  }

  function assertStoppedWithoutMutation(fixture, label) {
    const before = snapshotSyntheticRecoveryFixture(fixture);
    const decision = decideRecovery(fixture);
    assert.equal(decision.status, "stopped");
    assert.equal(
      decision.reason,
      fixture.receipt === null
        ? "receipt-absent-owner-unknown"
        : "receipt-present-cleanup-unproven",
    );
    assert.ok(Array.isArray(decision.retainedPaths));
    assert.ok(decision.retainedPaths.includes("journal"));
    assert.ok(decision.retainedPaths.includes("lock-owner-marker"));
    assert.ok(decision.retainedPaths.includes("stage-or-placed-object"));
    assert.ok(decision.retainedPaths.includes("input"));
    assert.ok(decision.retainedPaths.includes("catalog-and-held-catalog"));
    assert.ok(decision.retainedPaths.includes("source"));
    assert.ok(decision.retainedPaths.includes("unknown-bytes"));
    assert.ok(Array.isArray(decision.manualReview) && decision.manualReview.length > 0);
    assert.deepEqual(decision.automaticActions, []);

    for (const action of forbiddenActions) {
      assert.throws(
        () => authorizeNextOperation(decision, action),
        (error) => error.name === "RecoveryStoppedError",
        `${label}: ${action} must be refused after stop`,
      );
    }

    const after = snapshotSyntheticRecoveryFixture(fixture);
    assert.deepEqual(after, before, `${label}: decision or refused operations mutated retained model state`);
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(rawSecret));
    console.log(JSON.stringify({
      label,
      beforeSha256: snapshotDigest(before),
      afterSha256: snapshotDigest(after),
      state: snapshotSummary(before),
      decision,
      refusedActions: forbiddenActions,
    }));
  }

  for (const checkpoint of checkpoints) {
    for (const receiptPresent of receiptStates) {
      test(`stop retains all artifacts at ${checkpoint}; receipt=${receiptPresent}`, () => {
        const fixture = createSyntheticRecoveryFixture({ checkpoint, receiptPresent });
        assertStoppedWithoutMutation(fixture, `${checkpoint}/receipt=${receiptPresent}`);
      });
    }
  }

  for (const perturbation of perturbations) {
    for (const receiptPresent of receiptStates) {
      test(`stop retains ${perturbation}; receipt=${receiptPresent}`, () => {
        const fixture = createSyntheticRecoveryFixture({
          checkpoint: "placement-after",
          receiptPresent,
          perturbation,
        });
        assertPerturbationWasModeled(fixture, perturbation);
        assertStoppedWithoutMutation(fixture, `${perturbation}/receipt=${receiptPresent}`);
      });
    }
  }

  test("matching mode and hash without a receipt still cannot authorize adoption", () => {
    const fixture = createSyntheticRecoveryFixture({
      checkpoint: "stage-after",
      receiptPresent: false,
    });
    assert.equal(fixture.receipt, null);
    assert.deepEqual(fixture.observedStageSignature, fixture.expectedStageSignature);
    const decision = decideRecovery(fixture);
    assert.equal(decision.status, "stopped");
    assert.equal(decision.reason, "receipt-absent-owner-unknown");
    assert.throws(() => authorizeNextOperation(decision, "adopt"), { name: "RecoveryStoppedError" });
    console.log(JSON.stringify({
      label: "matching-mode-hash-without-receipt",
      mode: fixture.observedStageSignature.mode,
      sha256: fixture.observedStageSignature.sha256,
      receipt: "absent",
      decision,
      adoption: "refused",
    }));
  });

  test("a receipt does not grant cleanup when source and namespace guarantees are absent", () => {
    const fixture = createSyntheticRecoveryFixture({
      checkpoint: "stage-after",
      receiptPresent: true,
    });
    assert.ok(fixture.receipt);
    assert.equal(fixture.sourceIdentityConditional, false);
    assert.equal(fixture.namespaceConfined, false);
    const decision = decideRecovery(fixture);
    assert.equal(decision.status, "stopped");
    assert.equal(decision.reason, "receipt-present-cleanup-unproven");
    assert.throws(() => authorizeNextOperation(decision, "cleanup"), { name: "RecoveryStoppedError" });
    console.log(JSON.stringify({
      label: "receipt-without-source-namespace-guarantees",
      receipt: "present",
      sourceIdentityConditional: false,
      namespaceConfined: false,
      decision,
      cleanup: "refused",
    }));
  });

  test("P1 parent, root-namespace, and source-name LIMITs remain unrepaired and stopped", () => {
    for (const perturbation of ["parent-replaced", "opened-parent-outside-root", "source-basename-replaced"]) {
      const fixture = createSyntheticRecoveryFixture({
        checkpoint: "placement-after",
        receiptPresent: true,
        perturbation,
      });
      const before = snapshotSyntheticRecoveryFixture(fixture);
      const decision = decideRecovery(fixture);
      assert.equal(decision.status, "stopped");
      assert.equal(decision.reason, "receipt-present-cleanup-unproven");
      assert.throws(() => authorizeNextOperation(decision, "move"), { name: "RecoveryStoppedError" });
      assert.deepEqual(snapshotSyntheticRecoveryFixture(fixture), before);
      if (perturbation === "opened-parent-outside-root") {
        assert.equal(fixture.namespace.outsideRootPlacementObserved, true);
        assert.equal(fixture.namespace.parentLocation, "outside-root");
      }
      if (perturbation === "source-basename-replaced") {
        assert.ok(fixture.detachedOriginalSource);
        assert.notEqual(fixture.detachedOriginalSource.ino, fixture.placed.ino);
      }
      console.log(JSON.stringify({
        label: `P1-LIMIT-preserved/${perturbation}`,
        classification: "LIMIT-unresolved-not-repaired-by-P2",
        beforeSha256: snapshotDigest(before),
        afterSha256: snapshotDigest(snapshotSyntheticRecoveryFixture(fixture)),
        state: snapshotSummary(before),
        decision,
      }));
    }
  });

  test("the stop report never serializes synthetic input or unknown raw bytes", () => {
    const fixture = createSyntheticRecoveryFixture({
      checkpoint: "catalog-after",
      receiptPresent: false,
      perturbation: "unknown-child",
    });
    const decision = decideRecovery(fixture);
    const encoded = JSON.stringify(decision);
    assert.equal(encoded.includes(rawSecret), false);
    assert.equal(encoded.includes("UNKNOWN_RAW_SECRET"), false);
    assert.equal(encoded.includes("base64"), false);
    console.log(JSON.stringify({ label: "raw-byte-redaction", decision, rawBytes: "not-serialized" }));
  });
}
