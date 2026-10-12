import { randomUUID } from "node:crypto";
import type { Catalog, Group } from "./types.ts";
import { assertNameAvailable, assertNoNameConflicts, nameKey } from "./names.ts";

function findGroup(catalog: Catalog, groupId: string): Group {
  const group = catalog.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Unknown group: ${groupId}`);
  return group;
}

function normalizedName(name: string): string {
  nameKey(name);
  return name.trim();
}

export function createGroup(catalog: Catalog, name: string): Group {
  assertNoNameConflicts(catalog);
  assertNameAvailable(catalog, "group", name);
  const group: Group = { id: randomUUID(), name: normalizedName(name), itemIds: [] };
  catalog.groups.push(group);
  return group;
}

export function renameGroup(catalog: Catalog, groupId: string, name: string): void {
  const group = findGroup(catalog, groupId);
  const nextName = normalizedName(name);
  assertNameAvailable(catalog, "group", nextName, groupId);
  group.name = nextName;
}

export function setGroupItems(catalog: Catalog, groupId: string, itemIds: string[]): void {
  assertNoNameConflicts(catalog);
  const group = findGroup(catalog, groupId);
  if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length) throw new Error("Group membership must contain unique item identifiers.");
  const knownItems = new Set(catalog.items.map((item) => item.id));
  if (itemIds.some((id) => !knownItems.has(id))) throw new Error("Group membership references an unknown saved item.");
  group.itemIds = [...itemIds];
}

/** Remove a group. Its saved resources stay in the library; they only leave this group. */
export function deleteGroup(catalog: Catalog, groupId: string): void {
  const group = findGroup(catalog, groupId);
  catalog.groups = catalog.groups.filter((entry) => entry !== group);
}
