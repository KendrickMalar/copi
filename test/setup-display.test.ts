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
