import assert from "node:assert/strict";
import test from "node:test";
import { displayPath, formatBytes, formatOutsideRootSummary, truncateMiddle } from "../src/setup-display.ts";

test("displayPath replaces only the exact home prefix", () => {
  assert.equal(displayPath("/Users/a", "/Users/a"), "~");
  assert.equal(displayPath("/Users/a/x/y.md", "/Users/a"), "~/x/y.md");
  assert.equal(displayPath("/Users/aX/x", "/Users/a"), "/Users/aX/x");
  assert.equal(displayPath("/other/x", "/Users/a"), "/other/x");
  assert.equal(displayPath("/Users/a/x", ""), "/Users/a/x");
  assert.equal(displayPath("/Users/a/x", "/Users/a/"), "~/x");
});

test("truncateMiddle keeps head and tail and ignores missing or tiny max", () => {
  assert.equal(truncateMiddle("abcdefghij", 10), "abcdefghij");
  assert.equal(truncateMiddle("abcdefghijkl", 7), "abc…jkl");
  assert.equal(truncateMiddle("abcdefghijkl", 6), "abc…kl");
  assert.equal(truncateMiddle("abcdefghijkl", undefined), "abcdefghijkl");
  assert.equal(truncateMiddle("abcdefghijkl", 3), "abcdefghijkl");
  assert.equal(truncateMiddle("abcdefghijkl", Number.NaN), "abcdefghijkl");
  assert.equal(truncateMiddle("abcdefghijkl", 4).length, 4);
});

test("formatBytes uses B, KB, MB with one decimal", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("formatOutsideRootSummary shows title, ~ paths, first 5 and +N more", () => {
  assert.equal(formatOutsideRootSummary([], "/h"), undefined);
  const few = formatOutsideRootSummary(["/h/a", "/x/b"], "/h");
  assert.deepEqual(few, { title: "Skipped 2 resource(s) outside the selected locations", body: "~/a\n/x/b" });
  const many = formatOutsideRootSummary(Array.from({ length: 8 }, (_, i) => `/h/p${i}`), "/h");
  assert.equal(many?.title, "Skipped 8 resource(s) outside the selected locations");
  assert.equal(many?.body, "~/p0\n~/p1\n~/p2\n~/p3\n~/p4\n+3 more");
  assert.equal(formatOutsideRootSummary(Array.from({ length: 5 }, (_, i) => `/h/p${i}`), "/h")?.body.includes("more"), false);
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { candidateHint, candidateLabel, formatLocalDate, gatherCandidateStats, sortCandidates } from "../src/setup-display.ts";
import type { ResourceCandidate } from "../src/types.ts";

function cand(over: Partial<ResourceCandidate>): ResourceCandidate {
  return { id: "i", kind: "subagent", source: "s", scope: "user", sourceRoot: "/h", sourcePath: "/h/a/x.md", name: "x", destination: { kind: "global-only" }, ...over };
}

test("candidateLabel shows kind, name, ~dirname source and already-saved marker", () => {
  const c = cand({ sourcePath: "/Users/a/.pi/agent-rbx/agents/x.md" });
  assert.equal(candidateLabel(c, "/Users/a", false), "[subagent] x — ~/.pi/agent-rbx/agents");
  assert.equal(candidateLabel(c, "/Users/a", true), "[subagent] x — ~/.pi/agent-rbx/agents (already saved)");
});

test("candidateLabel truncates the source dir in the middle to fit columns, keeping the tail", () => {
  const c = cand({ sourcePath: `/very/long/${"d".repeat(120)}/set-1/x.md` });
  const label = candidateLabel(c, "/Users/a", false, 80);
  assert.ok(label.length <= 80 - 6 && label.endsWith("set-1"), label);
  assert.doesNotThrow(() => candidateLabel(c, "", true, 10));
});

test("sortCandidates orders by kind, nameKey, source path without mutating input", () => {
  const list = [
    cand({ id: "1", kind: "subagent", name: "b", sourcePath: "/z/b.md" }),
    cand({ id: "2", kind: "skill", name: "Z", sourcePath: "/z/Z" }),
    cand({ id: "3", kind: "subagent", name: "B", sourcePath: "/a/b.md" }),
    cand({ id: "4", kind: "subagent", name: "a", sourcePath: "/q/a.md" }),
  ];
  const copy = [...list];
  assert.deepEqual(sortCandidates(list).map((c) => c.id), ["2", "4", "3", "1"]);
  assert.deepEqual(list, copy);
});

test("candidateHint joins size, modified date and destination, and truncates to width", () => {
  const c = cand({ destination: { kind: "project", path: "/Users/a/proj/.pi/agents/x.md" } });
  const stat = { size: "1.5 KB", mtime: new Date(2026, 9, 3, 12) };
  assert.equal(formatLocalDate(stat.mtime), "2026-10-03");
  assert.equal(candidateHint(c, stat, "/Users/a", undefined, 10), "1.5 KB · modified 2026-10-03 · ~/proj/.pi/agents/x.md");
  assert.equal(candidateHint(cand({}), {}, "/Users/a", undefined, 10), "save only");
  const narrow = candidateHint(c, stat, "/Users/a", 40, 20);
  assert.ok(narrow.length <= 20 && narrow.includes("…"), narrow);
  assert.doesNotThrow(() => candidateHint(c, stat, "/Users/a", 5, 100));
});

test("gatherCandidateStats reports file size, directory file count, and tolerates missing paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copi-stats-"));
  try {
    await writeFile(path.join(dir, "f.md"), "x".repeat(2048));
    await mkdir(path.join(dir, "sk", "sub"), { recursive: true });
    await writeFile(path.join(dir, "sk", "SKILL.md"), "a");
    await writeFile(path.join(dir, "sk", "sub", "b.md"), "b");
    await symlink(path.join(dir, "f.md"), path.join(dir, "sk", "link"));
    const stats = await gatherCandidateStats([
      cand({ id: "f", sourcePath: path.join(dir, "f.md") }),
      cand({ id: "d", kind: "skill", sourcePath: path.join(dir, "sk") }),
      cand({ id: "m", sourcePath: path.join(dir, "missing") }),
    ]);
    assert.equal(stats.get("f")?.size, "2.0 KB");
    assert.equal(stats.get("d")?.size, "2 files");
    assert.ok(stats.get("f")?.mtime instanceof Date);
    assert.deepEqual(stats.get("m"), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
