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
  if (columns !== undefined && Number.isFinite(columns)) dir = truncateMiddle(dir, Math.max(columns - head.length - tail.length - 6, 24));
  return `${head}${dir}${tail}`;
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

async function statOne(c: ResourceCandidate): Promise<CandidateStats> {
  try {
    const st = await lstat(c.sourcePath);
    if (st.isDirectory()) {
      const budget = { left: countCap };
      await countFiles(c.sourcePath, budget);
      const n = countCap - budget.left;
      return { size: n >= countCap ? `${countCap}+ files` : `${n} file${n === 1 ? "" : "s"}`, mtime: st.mtime };
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
