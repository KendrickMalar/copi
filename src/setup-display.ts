import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { nameKey } from "./names.ts";
import type { ResourceCandidate } from "./types.ts";

/** Replace a leading home directory with `~` (only on a path-segment boundary). */
export function displayPath(p: string, home: string): string {
  if (!home) return p;
  const base = home.length > 1 && home.endsWith(path.sep) ? home.slice(0, -1) : home;
  if (p === base) return "~";
  if (p.startsWith(base + path.sep)) return `~${p.slice(base.length)}`;
  return p;
}

/** Keep head and tail joined by `…`; return `s` unchanged when `max` is missing, tiny, or not smaller than the length. */
export function truncateMiddle(s: string, max: number | undefined): string {
  if (max === undefined || !Number.isFinite(max) || max < 4 || s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const outsideRootPreview = 5;

/** Summarize skipped out-of-root resources into one note (undefined when none). */
export function formatOutsideRootSummary(paths: readonly string[], home: string): { title: string; body: string } | undefined {
  if (paths.length === 0) return undefined;
  const lines = paths.slice(0, outsideRootPreview).map((p) => displayPath(p, home));
  if (paths.length > outsideRootPreview) lines.push(`+${paths.length - outsideRootPreview} more`);
  return { title: `Skipped ${paths.length} resource(s) outside the selected locations`, body: lines.join("\n") };
}

export interface CandidateStats { size?: string; mtime?: Date }

/**
 * `[kind] name — ~/source/dir`, plus `(already saved)`. Shared with conflict-resolution options.
 * When `columns` is given the source directory is middle-truncated (tail kept) so the row does not wrap.
 */
export function candidateLabel(c: ResourceCandidate, home: string, alreadySaved: boolean, columns?: number): string {
  const head = `[${c.kind}] ${c.name} \u2014 `;
  const tail = alreadySaved ? " (already saved)" : "";
  let dir = displayPath(path.dirname(c.sourcePath), home);
  if (columns !== undefined && Number.isFinite(columns)) dir = truncateMiddle(dir, Math.max(columns - head.length - tail.length - 6, 8));
  return `${head}${dir}${tail}`;
}

/**
 * Labels for a whole list. Rows sharing kind + nameKey must stay distinguishable: when truncation makes their
 * source labels collide, that group falls back to whole trailing segments (`…/a/b`), widened until they differ.
 */
export function candidateLabels(list: readonly ResourceCandidate[], home: string, isSaved: (c: ResourceCandidate) => boolean, columns?: number): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, ResourceCandidate[]>();
  for (const c of list) {
    out.set(c.id, candidateLabel(c, home, isSaved(c), columns));
    const key = `${c.kind}\0${nameKey(c.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const labels = group.map((c) => out.get(c.id)!);
    if (new Set(labels).size === labels.length) continue;
    const dirs = group.map((c) => displayPath(path.dirname(c.sourcePath), home));
    const segs = dirs.map((d) => d.split(path.sep));
    const max = Math.max(...segs.map((x) => x.length));
    for (let k = 1; k <= max; k += 1) {
      const cut = segs.map((x, i) => (x.length <= k ? dirs[i]! : `\u2026${path.sep}${x.slice(-k).join(path.sep)}`));
      const rendered = group.map((c, i) => `[${c.kind}] ${c.name} \u2014 ${cut[i]}${isSaved(c) ? " (already saved)" : ""}`);
      if (new Set(rendered).size === rendered.length || k === max) {
        group.forEach((c, i) => out.set(c.id, rendered[i]!));
        break;
      }
    }
  }
  return out;
}

/** Sort by kind, then nameKey, then source path (new array). */
export function sortCandidates(list: readonly ResourceCandidate[]): ResourceCandidate[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort((a, b) => cmp(a.kind, b.kind) || cmp(nameKey(a.name), nameKey(b.name)) || cmp(a.sourcePath, b.sourcePath));
}

export function formatLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `<size> · modified <date> · <destination>`; missing parts are omitted. Truncated to the terminal width minus label and prompt chrome. */
export function candidateHint(c: ResourceCandidate, stats: CandidateStats, home: string, columns: number | undefined, labelLength: number): string {
  const parts: string[] = [];
  if (stats.size !== undefined) parts.push(stats.size);
  if (stats.mtime !== undefined) parts.push(`modified ${formatLocalDate(stats.mtime)}`);
  parts.push(c.destination.kind === "global-only" ? "save only" : displayPath(c.destination.path, home));
  const hint = parts.join(" · ");
  if (columns === undefined || !Number.isFinite(columns)) return hint;
  return truncateMiddle(hint, Math.max(columns - labelLength - 10, 12));
}

const countCap = 1000;

async function countFiles(dir: string, budget: { left: number }): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    if (entry.isDirectory()) await countFiles(path.join(dir, entry.name), budget);
    else if (entry.isFile()) budget.left -= 1;
  }
}

async function hasMoreFiles(dir: string, cap: number): Promise<boolean> {
  const budget = { left: cap + 1 };
  await countFiles(dir, budget);
  return budget.left <= 0;
}

async function statOne(c: ResourceCandidate): Promise<CandidateStats> {
  try {
    const st = await lstat(c.sourcePath);
    if (st.isDirectory()) {
      const budget = { left: countCap };
      await countFiles(c.sourcePath, budget);
      const n = countCap - budget.left;
      return { size: budget.left <= 0 && (await hasMoreFiles(c.sourcePath, countCap)) ? `${countCap}+ files` : `${n} file${n === 1 ? "" : "s"}`, mtime: st.mtime };
    }
    return { size: formatBytes(st.size), mtime: st.mtime };
  } catch {
    return {};
  }
}

/** Cheap, never-throwing stats for the shown candidates, gathered in parallel. */
export async function gatherCandidateStats(list: readonly ResourceCandidate[]): Promise<Map<string, CandidateStats>> {
  const entries = await Promise.all(list.map(async (c) => [c.id, await statOne(c)] as const));
  return new Map(entries);
}

/** Groups of 2+ selected candidates sharing a `nameKey` (any kind), each in input order; groups ordered by first member. */
export function findSelectionConflicts(list: readonly ResourceCandidate[]): ResourceCandidate[][] {
  const groups = new Map<string, ResourceCandidate[]>();
  for (const c of list) {
    const key = nameKey(c.name);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Suggested rename `<name> (<segment>)`. Within a conflict group the segment is the nearest ancestor directory
 * (walking up from the source's parent) whose name tells this member apart from the others — unique if possible,
 * otherwise the first level where the members differ at all. Without such a level (or alone), the segment is the
 * grandparent of the source, falling back to its parent, e.g. `jandel.md (agent-rbx)`.
 */
export function defaultRenameName(c: ResourceCandidate, group: readonly ResourceCandidate[] = [c]): string {
  const ancestors = (x: ResourceCandidate) => {
    const out: string[] = [];
    for (let dir = path.dirname(x.sourcePath); path.basename(dir); dir = path.dirname(dir)) out.push(path.basename(dir));
    return out;
  };
  const mine = ancestors(c);
  const others = group.filter((x) => x.id !== c.id).map(ancestors);
  let segment: string | undefined;
  if (others.length > 0) {
    const unique = mine.findIndex((name, level) => others.every((other) => other[level] !== name));
    const differing = mine.findIndex((name, level) => others.some((other) => other[level] !== name));
    const level = unique !== -1 ? unique : differing;
    if (level !== -1) segment = mine[level];
  }
  segment ??= mine[1] ?? mine[0];
  return segment ? `${c.name} (${segment})` : c.name;
}

/** Validation message for a new display name, or undefined when it is non-empty and its `nameKey` is not taken. */
export function pendingNameError(name: string | undefined, taken: ReadonlySet<string>): string | undefined {
  let key: string;
  try { key = nameKey(name ?? ""); } catch { return "Enter a non-empty display name."; }
  return taken.has(key) ? "That name is already used by a saved or selected resource; choose another." : undefined;
}
