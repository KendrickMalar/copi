import path from "node:path";
import type { Catalog, SavedItem } from "./types.ts";

export interface LegacyStorageJournal {
  version: 1;
  root: string;
  token: string;
  oldCatalog: string | null;
  newCatalog: string;
  operations: { itemId: string; oldTree: string | null; newTree: string }[];
}

export interface SourcesStorageJournal {
  version: 2;
  root: string;
  token: string;
  oldCatalog: string | null;
  newCatalog: string;
  stableSourcesTree: string;
  operations: { itemId: string; target: string; kind: "file" | "tree"; oldTree: string | null; newTree: string }[];
}

export type StorageJournal = LegacyStorageJournal | SourcesStorageJournal;

const itemPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const excludedNames = new Set([
  ".git", ".cache", ".npm", "auth", "node_modules", "cache", "caches", "history", "sessions",
  "auth.json", "mcp-auth.json", "oauth.json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function isOptionalSha256(value: unknown): value is string | null {
  return value === null || isSha256(value);
}

function isSafeSourcesTarget(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  if (parts.length < 2 || parts[0] !== "sources" || parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (path.posix.normalize(value) !== value) return false;
  return !parts.slice(1).some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === ".env" || lower.startsWith(".env");
  });
}

type JournalEnvelope = Record<string, unknown> & {
  root: string;
  token: string;
  oldCatalog: string | null;
  newCatalog: string;
  operations: unknown[];
};

function assertCommonJournal(value: Record<string, unknown>, expected: { root: string; token: string }): asserts value is JournalEnvelope {
  if (typeof expected.root !== "string" || typeof expected.token !== "string" ||
      typeof value.root !== "string" || value.root !== expected.root ||
      typeof value.token !== "string" || value.token !== expected.token ||
      !isOptionalSha256(value.oldCatalog) || !isSha256(value.newCatalog) || !Array.isArray(value.operations)) {
    throw new Error("Invalid storage journal envelope or root/token/catalog commitment.");
  }
}

function assertItemId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !itemPattern.test(value)) throw new Error("Invalid storage journal item UUID.");
}

function assertUniqueItemIds(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate item UUID in storage journal.");
}

function assertNoTargetOverlap(targets: readonly string[]): void {
  for (let index = 0; index < targets.length; index += 1) {
    const left = targets[index]!;
    for (const right of targets.slice(index + 1)) {
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new Error("Duplicate or overlapping sources targets in storage journal.");
      }
    }
  }
}

export function parseStorageJournal(value: unknown, expected: { root: string; token: string }): StorageJournal {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) throw new Error("Unsupported or invalid storage journal version.");
  const commonKeys = ["version", "root", "token", "oldCatalog", "newCatalog", "operations"];
  const expectedKeys = value.version === 1 ? commonKeys : [...commonKeys, "stableSourcesTree"];
  if (!hasExactKeys(value, expectedKeys)) throw new Error("Invalid storage journal object.");
  assertCommonJournal(value, expected);

  if (value.version === 1) {
    const operations: LegacyStorageJournal["operations"] = [];
    for (const valueOperation of value.operations) {
      if (!isRecord(valueOperation) || !hasExactKeys(valueOperation, ["itemId", "oldTree", "newTree"])) {
        throw new Error("Invalid legacy storage journal operation.");
      }
      assertItemId(valueOperation.itemId);
      if (!isOptionalSha256(valueOperation.oldTree) || !isSha256(valueOperation.newTree)) {
        throw new Error("Invalid legacy storage journal tree commitment.");
      }
      operations.push({ itemId: valueOperation.itemId, oldTree: valueOperation.oldTree, newTree: valueOperation.newTree });
    }
    assertUniqueItemIds(operations.map((operation) => operation.itemId));
    return {
      version: 1,
      root: value.root,
      token: value.token,
      oldCatalog: value.oldCatalog,
      newCatalog: value.newCatalog,
      operations,
    };
  }

  if (!isSha256(value.stableSourcesTree)) throw new Error("Invalid stable sources tree commitment in v2 storage journal.");
  const operations: SourcesStorageJournal["operations"] = [];
  for (const valueOperation of value.operations) {
    if (!isRecord(valueOperation) || !hasExactKeys(valueOperation, ["itemId", "target", "kind", "oldTree", "newTree"])) {
      throw new Error("Invalid sources storage journal operation.");
    }
    assertItemId(valueOperation.itemId);
    if (typeof valueOperation.target !== "string" || !isSafeSourcesTarget(valueOperation.target) ||
        (valueOperation.kind !== "file" && valueOperation.kind !== "tree") ||
        !isOptionalSha256(valueOperation.oldTree) || !isSha256(valueOperation.newTree)) {
      throw new Error("Invalid sources storage journal target, kind, or tree commitment.");
    }
    operations.push({
      itemId: valueOperation.itemId,
      target: valueOperation.target,
      kind: valueOperation.kind,
      oldTree: valueOperation.oldTree,
      newTree: valueOperation.newTree,
    });
  }
  assertUniqueItemIds(operations.map((operation) => operation.itemId));
  assertNoTargetOverlap(operations.map((operation) => operation.target));
  return {
    version: 2,
    root: value.root,
    token: value.token,
    oldCatalog: value.oldCatalog,
    newCatalog: value.newCatalog,
    stableSourcesTree: value.stableSourcesTree,
    operations,
  };
}

function assertCatalogItems(catalog: Catalog, label: string): Map<string, SavedItem> {
  if (!catalog || catalog.version !== 2 || !Array.isArray(catalog.items)) {
    throw new Error(`Invalid ${label} sources catalog.`);
  }
  const items = new Map<string, SavedItem>();
  const targets: string[] = [];
  for (const item of catalog.items) {
    if (!item || typeof item.id !== "string" || items.has(item.id) || !item.content ||
        (item.content.kind !== "file" && item.content.kind !== "tree") ||
        typeof item.content.path !== "string" || !isSafeSourcesTarget(item.content.path) ||
        item.content.kind !== (item.kind === "skill" ? "tree" : "file")) {
      throw new Error(`Invalid or duplicate content target in ${label} sources catalog.`);
    }
    items.set(item.id, item);
    targets.push(item.content.path);
  }
  assertNoTargetOverlap(targets);
  return items;
}

export function validateSourcesJournalTargets(journal: SourcesStorageJournal, previous: Catalog | null, next: Catalog): void {
  if (!journal || journal.version !== 2 || !Array.isArray(journal.operations)) {
    throw new Error("Sources journal target validation requires a v2 journal.");
  }
  const nextItems = assertCatalogItems(next, "next");
  const previousItems = previous === null ? null : assertCatalogItems(previous, "previous");
  const operationIds: string[] = [];
  const operationTargets: string[] = [];

  for (const operation of journal.operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Invalid sources journal operation.");
    assertItemId(operation.itemId);
    if (typeof operation.target !== "string" || !isSafeSourcesTarget(operation.target) ||
        (operation.kind !== "file" && operation.kind !== "tree") ||
        !isOptionalSha256(operation.oldTree) || !isSha256(operation.newTree)) {
      throw new Error("Invalid sources journal operation.");
    }
    const item = nextItems.get(operation.itemId);
    if (!item || item.content.path !== operation.target || item.content.kind !== operation.kind) {
      throw new Error("Sources journal target or kind does not match the next catalog item.");
    }
    const oldItem = previousItems?.get(operation.itemId);
    if (oldItem) {
      if (oldItem.content.path !== item.content.path || oldItem.content.kind !== item.content.kind || operation.oldTree === null) {
        throw new Error("Existing sources item changed target or lacks its old tree commitment.");
      }
    } else if (operation.oldTree !== null) {
      throw new Error("New sources item must not have an old tree commitment.");
    }
    operationIds.push(operation.itemId);
    operationTargets.push(operation.target);
  }
  assertUniqueItemIds(operationIds);
  assertNoTargetOverlap(operationTargets);
}
