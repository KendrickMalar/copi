import { createHash } from "node:crypto";

const secretFixtureBytes = Buffer.from("P2_SYNTHETIC_RAW_SECRET_MUST_NEVER_APPEAR");
const unknownFixtureBytes = Buffer.from("UNKNOWN_RAW_SECRET_MUST_REMAIN_UNINTERPRETED");
const checkpoints = new Set([
  "stage-before",
  "stage-after",
  "placement-before",
  "placement-after",
  "catalog-before",
  "catalog-after",
]);
const perturbations = new Set([
  "none",
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
]);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function file(dev, ino, mode, bytes) {
  return { kind: "file", dev: String(dev), ino: String(ino), mode, bytes: Buffer.from(bytes) };
}

function directory(dev, ino, mode, children = {}) {
  return { kind: "directory", dev: String(dev), ino: String(ino), mode, children };
}

function entryHash(entry) {
  if (entry.kind === "file") return hash(entry.bytes);
  const children = Object.keys(entry.children).sort().map((name) => `${name}\0${entryHash(entry.children[name])}`).join("\0");
  return hash(Buffer.from(children));
}

function signature(entry) {
  return { mode: entry.mode, sha256: entryHash(entry) };
}

function cloneWithNewInodes(entry, startIno) {
  if (entry.kind === "file") return file(entry.dev, startIno, entry.mode, entry.bytes);
  let ino = startIno;
  const children = {};
  for (const name of Object.keys(entry.children).sort()) {
    children[name] = cloneWithNewInodes(entry.children[name], ++ino);
  }
  return directory(entry.dev, ino, entry.mode, children);
}

function snapshotEntry(entry) {
  const common = { kind: entry.kind, dev: entry.dev, ino: entry.ino, mode: entry.mode };
  if (entry.kind === "file") return { ...common, sha256: hash(entry.bytes) };
  const names = Object.keys(entry.children).sort();
  return {
    ...common,
    children: names,
    entries: Object.fromEntries(names.map((name) => [name, snapshotEntry(entry.children[name])])),
  };
}

function candidateEntry(fixture) {
  return fixture.placed ?? fixture.stage ?? fixture.intendedStage;
}

function applyPerturbation(fixture, perturbation) {
  const candidate = candidateEntry(fixture);
  switch (perturbation) {
    case "none":
      break;
    case "same-inode-edit": {
      const payload = candidate.children.payload;
      payload.bytes = Buffer.from("externally edited in the same synthetic inode");
      break;
    }
    case "samebytes-new-inode":
      candidate.ino = `${candidate.ino}-replacement`;
      break;
    case "unknown-next-entry":
      fixture.lock.children["next-0"] = file("41", "4102", 0o600, unknownFixtureBytes);
      break;
    case "unknown-old-entry":
      fixture.lock.children["old-0"] = file("41", "4103", 0o600, unknownFixtureBytes);
      break;
    case "unknown-displaced-entry":
      fixture.lock.children["displaced-0"] = file("41", "4104", 0o600, unknownFixtureBytes);
      break;
    case "unknown-child":
      candidate.children["unknown-child.raw"] = file("41", "4105", 0o600, unknownFixtureBytes);
      break;
    case "parent-replaced":
      fixture.namespace.currentParent = { dev: "41", ino: "4199", mode: 0o700 };
      fixture.namespace.parentLocation = "replacement-at-original-name";
      fixture.namespace.detachedOpenedParent = { ...fixture.namespace.openedParent };
      break;
    case "ancestor-replaced":
      fixture.namespace.currentAncestor = { dev: "41", ino: "4200", mode: 0o700 };
      fixture.namespace.detachedOpenedAncestor = { ...fixture.namespace.openedAncestor };
      break;
    case "opened-parent-outside-root":
      fixture.namespace.parentLocation = "outside-root";
      fixture.namespace.outsideRootPlacementObserved = true;
      break;
    case "source-basename-replaced": {
      fixture.detachedOriginalSource = fixture.placed;
      fixture.placed = cloneWithNewInodes(fixture.placed, 4300);
      fixture.sources.children.placed = fixture.placed;
      fixture.namespace.sourceAtPath = { dev: fixture.placed.dev, ino: fixture.placed.ino, mode: fixture.placed.mode };
      fixture.namespace.detachedOriginalSource = {
        dev: fixture.detachedOriginalSource.dev,
        ino: fixture.detachedOriginalSource.ino,
        mode: fixture.detachedOriginalSource.mode,
      };
      break;
    }
    default:
      throw new TypeError("Unknown synthetic perturbation.");
  }
  fixture.observedStageSignature = signature(candidateEntry(fixture));
}

export function createSyntheticRecoveryFixture({ checkpoint, receiptPresent, perturbation = "none" }) {
  if (!checkpoints.has(checkpoint) || typeof receiptPresent !== "boolean" || !perturbations.has(perturbation)) {
    throw new TypeError("Invalid synthetic recovery fixture parameters.");
  }

  const input = file("41", "4001", 0o600, secretFixtureBytes);
  const payload = file("41", "4002", 0o600, secretFixtureBytes);
  const intendedStage = directory("41", "4003", 0o700, { payload });
  const originalItem = directory("41", "4004", 0o700, {
    payload: file("41", "4005", 0o600, Buffer.from("previous source bytes")),
  });
  const oldCatalog = file("41", "4006", 0o600, Buffer.from("old catalog"));
  const newCatalog = file("41", "4007", 0o600, Buffer.from("new catalog"));
  const sources = directory("41", "4008", 0o700, { original: originalItem });
  const catalog = checkpoint === "catalog-after" ? newCatalog : oldCatalog;
  const lockChildren = {
    "journal.json": file("41", "4009", 0o600, Buffer.from("synthetic journal metadata")),
    "owner.json": file("41", "4014", 0o600, Buffer.from("synthetic lock owner marker")),
    "unknown.raw": file("41", "4010", 0o600, unknownFixtureBytes),
  };
  if (checkpoint === "stage-after" || checkpoint === "placement-before") lockChildren.stage = intendedStage;

  let stage = lockChildren.stage ?? null;
  let placed = null;
  if (checkpoint === "placement-after" || checkpoint === "catalog-before" || checkpoint === "catalog-after") {
    stage = null;
    placed = intendedStage;
    sources.children.placed = placed;
  }
  const lock = directory("41", "4011", 0o700, lockChildren);
  const library = directory("41", "4012", 0o700, {
    "catalog.json": catalog,
    sources,
  });
  const workspace = directory("41", "4013", 0o700, {
    input,
    library,
    lock,
  });
  if (checkpoint === "catalog-after") lock.children["held-catalog"] = oldCatalog;

  const fixture = {
    checkpoint,
    receipt: receiptPresent
      ? Object.freeze({
          persisted: true,
          checkpoint,
          stage: Object.freeze({
            dev: intendedStage.dev,
            ino: intendedStage.ino,
            ...signature(intendedStage),
          }),
        })
      : null,
    workspace,
    lock,
    sources,
    stage,
    placed,
    intendedStage,
    detachedOriginalSource: null,
    namespace: {
      openedAncestor: { dev: workspace.dev, ino: workspace.ino, mode: workspace.mode },
      currentAncestor: { dev: workspace.dev, ino: workspace.ino, mode: workspace.mode },
      openedParent: { dev: sources.dev, ino: sources.ino, mode: sources.mode },
      currentParent: { dev: sources.dev, ino: sources.ino, mode: sources.mode },
      parentLocation: "inside-root",
      outsideRootPlacementObserved: false,
      sourceAtPath: placed ? { dev: placed.dev, ino: placed.ino, mode: placed.mode } : null,
    },
    expectedStageIdentity: { dev: intendedStage.dev, ino: intendedStage.ino },
    expectedStageSignature: signature(intendedStage),
    observedStageSignature: signature(placed ?? stage ?? intendedStage),
    sourceIdentityConditional: false,
    namespaceConfined: false,
  };
  applyPerturbation(fixture, perturbation);
  return fixture;
}

export function snapshotSyntheticRecoveryFixture(fixture) {
  return {
    checkpoint: fixture.checkpoint,
    receipt: fixture.receipt === null ? null : fixture.receipt,
    workspace: snapshotEntry(fixture.workspace),
    detachedOriginalSource: fixture.detachedOriginalSource
      ? snapshotEntry(fixture.detachedOriginalSource)
      : null,
    namespace: {
      openedAncestor: fixture.namespace.openedAncestor,
      currentAncestor: fixture.namespace.currentAncestor,
      detachedOpenedAncestor: fixture.namespace.detachedOpenedAncestor ?? null,
      openedParent: fixture.namespace.openedParent,
      currentParent: fixture.namespace.currentParent,
      detachedOpenedParent: fixture.namespace.detachedOpenedParent ?? null,
      parentLocation: fixture.namespace.parentLocation,
      outsideRootPlacementObserved: fixture.namespace.outsideRootPlacementObserved,
      sourceAtPath: fixture.namespace.sourceAtPath,
      detachedOriginalSource: fixture.namespace.detachedOriginalSource ?? null,
    },
  };
}

export function decideRecovery(fixture) {
  const reason = fixture.receipt === null
    ? "receipt-absent-owner-unknown"
    : "receipt-present-cleanup-unproven";
  return Object.freeze({
    status: "stopped",
    reason,
    retainedPaths: Object.freeze([
      "journal",
      "lock-owner-marker",
      "stage-or-placed-object",
      "input",
      "catalog-and-held-catalog",
      "source",
      "unknown-bytes",
    ]),
    manualReview: Object.freeze([
      "Reconcile inode custody and namespace placement against separately obtained evidence.",
      "Keep retained artifacts; cleanup or adoption needs a separate approval and a proven method.",
    ]),
    automaticActions: Object.freeze([]),
  });
}

export function authorizeNextOperation(_decision, _action) {
  const error = new Error("Automatic recovery is stopped; no mutation is authorized.");
  error.name = "RecoveryStoppedError";
  throw error;
}
