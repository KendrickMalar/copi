import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { candidateHint, candidateLabel, candidateLabels, defaultRenameName, displayPath, findSelectionConflicts, formatBytes, formatLocalDate, formatOutsideRootSummary, gatherCandidateStats, pendingNameError, sortCandidates, truncateMiddle, formatSearchProgress, collapseIdenticalCandidates, contentFingerprint, identicalCopiesSuffix } from "../src/setup-display.ts";
import { nameKey } from "../src/names.ts";
import type { ResourceCandidate } from "../src/types.ts";

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

test("candidateLabels keeps same-named rows distinct when dirs differ only in a truncated middle", () => {
  const mk = (id: string, mid: string) => cand({ id, sourcePath: `/Users/a/${"p".repeat(40)}/${mid}/${"q".repeat(40)}/agents/x.md` });
  const list = [mk("1", "alpha"), mk("2", "beta")];
  assert.equal(candidateLabel(list[0]!, "/Users/a", false, 80), candidateLabel(list[1]!, "/Users/a", false, 80));
  const labels = candidateLabels(list, "/Users/a", () => false, 80);
  assert.notEqual(labels.get("1"), labels.get("2"));
  assert.match(labels.get("1")!, /alpha/);
  assert.match(labels.get("2")!, /beta/);
  const solo = candidateLabels([list[0]!], "/Users/a", () => true, 80);
  assert.equal(solo.get("1"), candidateLabel(list[0]!, "/Users/a", true, 80));
});

test("directory with exactly the cap shows no plus", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copi-cap-"));
  try {
    await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(path.join(dir, `f${i}`), "")));
    assert.equal((await gatherCandidateStats([cand({ id: "d", kind: "skill", sourcePath: dir })])).get("d")?.size, "1000 files");
    await writeFile(path.join(dir, "extra"), "");
    assert.equal((await gatherCandidateStats([cand({ id: "d", kind: "skill", sourcePath: dir })])).get("d")?.size, "1000+ files");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#9 findSelectionConflicts groups 2+ candidates by nameKey across kinds, in input order", () => {
  const list = [
    cand({ id: "a", name: "Straße" }), cand({ id: "b", name: "solo" }), cand({ id: "c", kind: "skill", name: " STRASSE " }),
    cand({ id: "d", name: "dup" }), cand({ id: "e", name: "DUP" }), cand({ id: "f", name: "dup" }),
  ];
  assert.deepEqual(findSelectionConflicts(list).map((group) => group.map((c) => c.id)), [["a", "c"], ["d", "e", "f"]]);
  assert.deepEqual(findSelectionConflicts([cand({ id: "x" }), cand({ id: "y", name: "y" })]), []);
});

test("#9 defaultRenameName appends the grandparent dir of the source, falling back to the parent", () => {
  assert.equal(defaultRenameName(cand({ name: "jandel.md", sourcePath: "/Users/a/Code/agent-rbx/agents/jandel.md" })), "jandel.md (agent-rbx)");
  assert.equal(defaultRenameName(cand({ name: "dup", sourcePath: "/p/.pi/skills/set-0/dup" })), "dup (skills)");
  assert.equal(defaultRenameName(cand({ name: "x.md", sourcePath: "/agents/x.md" })), "x.md (agents)");
});

test("#9 defaultRenameName uses the nearest ancestor dir that differs within the conflict group", () => {
  const a = cand({ id: "a", name: "jandel.md", sourcePath: "/Users/a/Code/agent-rbx/agents/jandel.md" });
  const b = cand({ id: "b", name: "jandel.md", sourcePath: "/Users/a/Code/agent/agents/jandel.md" });
  assert.equal(defaultRenameName(a, [a, b]), "jandel.md (agent-rbx)");
  assert.equal(defaultRenameName(b, [a, b]), "jandel.md (agent)");
  // Two same-named skills under different roots: the folders' parents are both "skills"; the roots differ higher up.
  const s1 = cand({ id: "s1", kind: "skill", name: "dup", sourcePath: "/h/proj-a/.pi/skills/dup" });
  const s2 = cand({ id: "s2", kind: "skill", name: "dup", sourcePath: "/h/proj-b/.pi/skills/dup" });
  assert.equal(defaultRenameName(s2, [s1, s2]), "dup (proj-b)");
  // Three same-named skills in sibling folders.
  const group = ["set-0", "set-1", "set-2"].map((dir) => cand({ id: dir, kind: "skill", name: "dup", sourcePath: `/p/.pi/skills/${dir}/dup` }));
  assert.deepEqual(group.map((c) => defaultRenameName(c, group)), ["dup (set-0)", "dup (set-1)", "dup (set-2)"]);
  // Nothing differs (same parent chain): fall back to the single-candidate rule.
  const twin = cand({ id: "t", name: "x", sourcePath: "/h/a/b/x.md" });
  assert.equal(defaultRenameName(twin, [twin, { ...twin, id: "u" }]), "x (a)");
});

test("#9 pendingNameError rejects empty names and names taken by the library or other pending names", () => {
  const taken = new Set([nameKey("Known"), nameKey("Straße")]);
  assert.equal(pendingNameError("fresh name", taken), undefined);
  assert.match(pendingNameError("  ", taken) ?? "", /non-empty/);
  assert.match(pendingNameError(undefined, taken) ?? "", /non-empty/);
  assert.match(pendingNameError(" known ", taken) ?? "", /already used/);
  assert.match(pendingNameError("STRASSE", taken) ?? "", /already used/);
});

test("formatSearchProgress shows count and the directory being searched", () => {
  assert.equal(formatSearchProgress({ done: 14, total: 36, current: "/Users/a/Library" }, "/Users/a"), "14/36  ~/Library");
  assert.equal(formatSearchProgress({ done: 36, total: 36 }, "/Users/a"), "36/36  Searching HOME");
});

test("contentFingerprint matches identical files and directories and differs on content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-fingerprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [dir, body] of [["a", "same\n"], ["b", "same\n"], ["c", "different\n"]] as const) {
    await mkdir(path.join(root, dir, "skill", "refs"), { recursive: true });
    await writeFile(path.join(root, dir, "skill", "SKILL.md"), body);
    await writeFile(path.join(root, dir, "skill", "refs", "x.md"), "ref\n");
    await writeFile(path.join(root, dir, "agent.md"), body);
  }
  await mkdir(path.join(root, "b", "skill", "node_modules"), { recursive: true });
  await writeFile(path.join(root, "b", "skill", "node_modules", "ignored.js"), "excluded from the copy\n");
  const fp = (p: string) => contentFingerprint(cand({ id: p, sourcePath: path.join(root, p) }));
  assert.equal(await fp("a/skill"), await fp("b/skill"));
  assert.notEqual(await fp("a/skill"), await fp("c/skill"));
  assert.equal(await fp("a/agent.md"), await fp("b/agent.md"));
  assert.notEqual(await fp("a/agent.md"), await fp("c/agent.md"));
  assert.equal(await fp("missing"), undefined);
});

test("collapseIdenticalCandidates keeps one row per kind + name + content, preferring ~/.pi then the shortest path", () => {
  const home = "/Users/a";
  const list = [
    cand({ id: "w", kind: "skill", name: "foo", sourcePath: "/Users/a/Code/app/.worktrees/x/.pi/skills/foo" }),
    cand({ id: "p", kind: "skill", name: "foo", sourcePath: "/Users/a/.pi/agent/skills/foo" }),
    cand({ id: "c", kind: "skill", name: "foo", sourcePath: "/Users/a/Code/app/.pi/skills/foo" }),
    cand({ id: "d", kind: "skill", name: "foo", sourcePath: "/Users/a/Code/other/.pi/skills/foo" }),
    cand({ id: "u", kind: "skill", name: "bar", sourcePath: "/Users/a/Code/app/.pi/skills/bar" }),
    cand({ id: "v", kind: "skill", name: "bar", sourcePath: "/Users/a/Code/b/.pi/skills/bar" }),
  ];
  const fingerprints = new Map<string, string | undefined>([["w", "h1"], ["p", "h1"], ["c", "h1"], ["d", "h2"], ["u", undefined], ["v", undefined]]);
  const { kept, copies } = collapseIdenticalCandidates(list, fingerprints, home);
  assert.deepEqual(kept.map((c) => c.id), ["p", "d", "u", "v"]);
  assert.equal(copies.get("p"), 2);
  assert.equal(copies.has("d"), false);
  assert.equal(identicalCopiesSuffix(copies.get("p")), " (+2 identical copies)");
  assert.equal(identicalCopiesSuffix(1), " (+1 identical copy)");
  assert.equal(identicalCopiesSuffix(undefined), "");
});
