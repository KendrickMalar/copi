import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeNextOperation, decideRecovery } from "./recovery-prototype.mjs";

export const proofDir = dirname(fileURLToPath(import.meta.url));
export const scratchDir = join(proofDir, "ignoredtmp");
export const perturbations = Object.freeze([
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

const checkpointSet = new Set([
  "stage-before",
  "stage-after",
  "placement-before",
  "placement-after",
  "catalog-before",
  "catalog-after",
]);
const rawSecret = Buffer.from("P2_FILESYSTEM_RAW_SECRET_MUST_NOT_BE_LOGGED");
const stageSecret = Buffer.from("P2_FILESYSTEM_STAGE_SECRET_MUST_NOT_BE_LOGGED");
const sourceSecret = Buffer.from("P2_FILESYSTEM_SOURCE_SECRET_MUST_NOT_BE_LOGGED");
const unknownSecret = Buffer.from("P2_FILESYSTEM_UNKNOWN_SECRET_MUST_NOT_BE_LOGGED");
const forbiddenActions = Object.freeze([
  "retry-placement",
  "cleanup",
  "rollback",
  "adopt",
  "move",
  "delete",
  "catalog-switch",
]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWrite(path, bytes, mode = 0o600) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function durableMkdir(path, mode = 0o700) {
  mkdirSync(path, { mode });
  syncDirectory(dirname(path));
  syncDirectory(path);
}

function durableRename(from, to) {
  renameSync(from, to);
  syncDirectory(dirname(from));
  if (dirname(from) !== dirname(to)) syncDirectory(dirname(to));
}

function writeInPlace(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function snapshotNode(path) {
  const info = lstatSync(path, { bigint: true });
  const common = {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: Number(info.mode & 0o777n),
  };
  if (info.isSymbolicLink()) {
    const target = readlinkSync(path, { encoding: "buffer" });
    return { ...common, kind: "symlink", sha256: digest(target) };
  }
  if (!info.isDirectory()) {
    const bytes = readFileSync(path);
    return { ...common, kind: "file", sha256: digest(bytes) };
  }

  const children = readdirSync(path).sort();
  const entries = Object.fromEntries(children.map((name) => [name, snapshotNode(join(path, name))]));
  const treeHashInput = children.map((name) => `${name}\0${entries[name].sha256}`).join("\0");
  return {
    ...common,
    kind: "directory",
    sha256: digest(Buffer.from(treeHashInput)),
    children,
    entries,
  };
}

function currentCandidate(root) {
  const stagePath = join(root, "lock", "stage");
  const placedPath = join(root, "library", "sources", "placed");
  if (existsSync(stagePath)) return stagePath;
  if (existsSync(placedPath)) return placedPath;
  return null;
}

function writeReceipt(root, checkpoint) {
  const candidate = currentCandidate(root);
  let signature = null;
  if (candidate) {
    const stat = lstatSync(candidate, { bigint: true });
    const snapshot = snapshotNode(candidate);
    signature = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mode: Number(stat.mode & 0o777n),
      sha256: snapshot.sha256,
    };
  }
  const receipt = JSON.stringify({ persisted: true, checkpoint, candidate: signature });
  durableWrite(join(root, "lock", "receipt.json"), Buffer.from(receipt));
}

function createStage(root) {
  const stage = join(root, "lock", "stage");
  durableMkdir(stage);
  durableWrite(join(stage, "payload.raw"), stageSecret);
  syncDirectory(stage);
}

function assertFixtureOptions({ checkpoint, receiptPresent }) {
  if (!checkpointSet.has(checkpoint) || typeof receiptPresent !== "boolean") {
    throw new TypeError("invalid-filesystem-fixture-options");
  }
}

function initializeFixture({ root, outsideRoot, checkpoint, receiptPresent }) {
  if (!checkpointSet.has(checkpoint) || typeof receiptPresent !== "boolean") {
    throw new TypeError("invalid-filesystem-fixture-options");
  }
  durableMkdir(join(root, "library"));
  durableMkdir(join(root, "library", "sources"));
  durableMkdir(join(root, "library", "sources", "source"));
  durableMkdir(join(root, "lock"));
  durableWrite(join(root, "input.raw"), rawSecret);
  durableWrite(join(root, "library", "catalog.json"), Buffer.from("P2 synthetic catalog: old\n"));
  durableWrite(join(root, "library", "sources", "source", "payload.raw"), sourceSecret);
  durableWrite(join(root, "lock", "journal.json"), Buffer.from(JSON.stringify({ checkpoint, operation: "synthetic-retain-stop" })));
  durableWrite(join(root, "lock", "owner.json"), Buffer.from("synthetic owner marker\n"));
  durableWrite(join(root, "lock", "unknown.raw"), unknownSecret);
  syncDirectory(join(root, "library", "sources", "source"));
  syncDirectory(join(root, "library", "sources"));
  syncDirectory(join(root, "library"));
  syncDirectory(join(root, "lock"));
  syncDirectory(root);
  syncDirectory(outsideRoot);

  if (checkpoint === "stage-after" || checkpoint === "placement-before") createStage(root);
  if (checkpoint === "placement-after" || checkpoint === "catalog-before" || checkpoint === "catalog-after") {
    createStage(root);
    durableRename(join(root, "lock", "stage"), join(root, "library", "sources", "placed"));
  }
  if (checkpoint === "catalog-after") {
    durableRename(join(root, "library", "catalog.json"), join(root, "lock", "held-catalog"));
    durableWrite(join(root, "library", "catalog.json"), Buffer.from("P2 synthetic catalog: new\n"));
  }
  if (receiptPresent) writeReceipt(root, checkpoint);
  syncDirectory(join(root, "lock"));
  syncDirectory(root);
}

export async function allocateFilesystemFixture() {
  mkdirSync(scratchDir, { recursive: true });
  const root = mkdtempSync(join(scratchDir, "p2-root-"));
  const outsideRoot = mkdtempSync(join(scratchDir, "p2-outside-"));
  syncDirectory(scratchDir);
  return { root, outsideRoot };
}

export async function createFilesystemFixture(options) {
  assertFixtureOptions(options);
  const fixture = await allocateFilesystemFixture();
  initializeFixture({ ...fixture, ...options });
  return { ...fixture, checkpoint: options.checkpoint, receiptPresent: options.receiptPresent };
}

export async function snapshotFilesystemFixture(fixture) {
  return {
    root: snapshotNode(fixture.root),
    outside: snapshotNode(fixture.outsideRoot),
  };
}

export async function applyFilesystemPerturbation(fixture, perturbation) {
  if (!perturbations.includes(perturbation)) throw new TypeError("invalid-filesystem-perturbation");
  const root = fixture.root;
  const lock = join(root, "lock");
  const library = join(root, "library");
  const sources = join(library, "sources");
  const placed = join(sources, "placed");
  const outside = fixture.outsideRoot;

  switch (perturbation) {
    case "same-inode-edit":
      writeInPlace(join(placed, "payload.raw"), Buffer.from("externally edited in the same filesystem inode\n"));
      break;
    case "samebytes-new-inode":
      replaceWithSameBytes(root, outside, placed, "held-stage");
      break;
    case "unknown-next-entry":
      durableWrite(join(lock, "next-0"), unknownSecret);
      break;
    case "unknown-old-entry":
      durableWrite(join(lock, "old-0"), unknownSecret);
      break;
    case "unknown-displaced-entry":
      durableWrite(join(lock, "displaced-0"), unknownSecret);
      break;
    case "unknown-child":
      durableWrite(join(placed, "unknown-child.raw"), unknownSecret);
      break;
    case "parent-replaced":
      durableRename(sources, join(outside, "parent-original"));
      durableMkdir(sources);
      durableWrite(join(sources, "replacement-marker.raw"), unknownSecret);
      break;
    case "ancestor-replaced":
      durableRename(library, join(outside, "ancestor-original"));
      durableMkdir(library);
      durableWrite(join(library, "catalog.json"), Buffer.from("replacement ancestor catalog\n"));
      durableMkdir(sources);
      durableWrite(join(sources, "replacement-marker.raw"), unknownSecret);
      break;
    case "opened-parent-outside-root":
      durableRename(sources, join(outside, "opened-parent-outside"));
      durableMkdir(sources);
      durableWrite(join(sources, "replacement-marker.raw"), unknownSecret);
      break;
    case "source-basename-replaced":
      replaceWithSameBytes(root, outside, placed, "held-source");
      break;
    default:
      throw new TypeError("invalid-filesystem-perturbation");
  }
  syncDirectory(root);
  syncDirectory(outside);
}

function createStageAt(path) {
  durableMkdir(path);
  durableWrite(join(path, "payload.raw"), stageSecret);
  syncDirectory(path);
}

function replaceWithSameBytes(root, outside, placed, heldName) {
  const replacement = join(root, "lock", "replacement-stage");
  createStageAt(replacement);
  durableRename(placed, join(outside, heldName));
  durableRename(replacement, placed);
}

async function recoverFromFilesystem(root, outsideRoot) {
  const before = await snapshotFilesystemFixture({ root, outsideRoot });
  const receiptPath = join(root, "lock", "receipt.json");
  const receiptPresent = existsSync(receiptPath) && lstatSync(receiptPath).isFile();
  let receipt = null;
  if (receiptPresent) {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt = parsed && parsed.persisted === true ? parsed : { persisted: false };
    } catch {
      receipt = { persisted: false };
    }
  }
  const journal = JSON.parse(readFileSync(join(root, "lock", "journal.json"), "utf8"));
  const decision = decideRecovery({ receipt });
  const refusedActions = [];
  for (const action of forbiddenActions) {
    try {
      authorizeNextOperation(decision, action);
    } catch (error) {
      if (error.name === "RecoveryStoppedError") refusedActions.push(action);
      else throw error;
    }
  }
  const after = await snapshotFilesystemFixture({ root, outsideRoot });
  return {
    processId: process.pid,
    crashCheckpoint: journal.checkpoint,
    receiptPresent,
    before,
    after,
    decision,
    refusedActions,
  };
}

async function runCli() {
  const [, , mode, root, outsideRoot, checkpoint, receiptArgument] = process.argv;
  if (mode === "--crash-checkpoint") {
    if (!root || !outsideRoot || !checkpointSet.has(checkpoint) || !["true", "false"].includes(receiptArgument)) {
      throw new TypeError("invalid-crash-fixture-arguments");
    }
    initializeFixture({ root, outsideRoot, checkpoint, receiptPresent: receiptArgument === "true" });
    process.kill(process.pid, "SIGKILL");
    return;
  }
  if (mode === "--recover") {
    if (!root || !outsideRoot) throw new TypeError("invalid-recovery-arguments");
    const result = await recoverFromFilesystem(root, outsideRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new TypeError("unknown-filesystem-driver-mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`filesystem-driver-error:${error.code ?? error.name}\n`);
    process.exitCode = 1;
  });
}
