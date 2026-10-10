import type { StoredCatalog } from "./types.ts";
import { foldCaseUnicode17 } from "./unicode-case-folding.ts";

export interface NameConflict {
  namespace: "item" | "group";
  key: string;
  ids: string[];
}

export function nameKey(name: string): string {
  const key = foldCaseUnicode17(name.trim().normalize("NFKC")).normalize("NFKC");
  if (key.length === 0) throw new Error("Name must not be empty after normalization.");
  return key;
}

export function findNameConflicts(catalog: StoredCatalog): NameConflict[] {
  const conflicts: NameConflict[] = [];
  for (const namespace of ["item", "group"] as const) {
    const keys = new Map<string, string[]>();
    for (const entry of namespace === "item" ? catalog.items : catalog.groups) {
      const key = nameKey(entry.name);
      const ids = keys.get(key) ?? [];
      ids.push(entry.id);
      keys.set(key, ids);
    }
    for (const [key, ids] of keys) if (ids.length > 1) conflicts.push({ namespace, key, ids });
  }
  return conflicts;
}

export function assertNoNameConflicts(catalog: StoredCatalog): void {
  if (findNameConflicts(catalog).length > 0) {
    throw new Error("Duplicate names in the copi library. Only listing, masked viewing, and name conflict resolution are allowed; resolve the names interactively with copi groups.");
  }
}

/** A rename during resolution may touch a conflict member only, and must use a free name. */
export function assertNameAvailable(catalog: StoredCatalog, namespace: "item" | "group", name: string, id?: string): void {
  const key = nameKey(name);
  const conflicts = findNameConflicts(catalog);
  if (conflicts.length > 0 && !conflicts.some((conflict) => conflict.namespace === namespace && conflict.ids.includes(id ?? ""))) {
    assertNoNameConflicts(catalog);
  }
  const entries = namespace === "item" ? catalog.items : catalog.groups;
  if (entries.some((entry) => entry.id !== id && nameKey(entry.name) === key)) {
    throw new Error(`Duplicate ${namespace} name; choose a unique display name.`);
  }
}
