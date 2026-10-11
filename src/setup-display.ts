import path from "node:path";

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
