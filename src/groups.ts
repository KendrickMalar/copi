import { randomUUID } from "node:crypto";
import type { Catalog, Group } from "./types.ts";


function findGroup(catalog: Catalog, groupId: string): Group {
  const group = catalog.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Unknown group: ${groupId}`);
  return group;
}

function normalizedName(name: string): string {
  if (name.trim().length === 0) throw new Error("Group name must not be empty.");
  return name.trim();
}

export function createGroup(catalog: Catalog, name: string): Group {
  const group: Group = { id: randomUUID(), name: normalizedName(name), itemIds: [] };
  catalog.groups.push(group);
  return group;
}

export function renameGroup(catalog: Catalog, groupId: string, name: string): void {
  const nextName = normalizedName(name);
  findGroup(catalog, groupId).name = nextName;
}

export function setGroupItems(catalog: Catalog, groupId: string, itemIds: string[]): void {
  const group = findGroup(catalog, groupId);
  if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length) throw new Error("Group membership must contain unique item identifiers.");
  const knownItems = new Set(catalog.items.map((item) => item.id));
  if (itemIds.some((id) => !knownItems.has(id))) throw new Error("Group membership references an unknown saved item.");
  group.itemIds = [...itemIds];
}
