import assert from "node:assert/strict";
import test from "node:test";
import { appendReferenceLines, chooseReferenceTarget, isAutoLoadedInstruction, referenceLine, unreferencedPaths } from "../src/instruction-reference.ts";

test("treats Pi context files and project system prompts as auto-loaded", () => {
  for (const value of ["AGENTS.md", "AGENTS.MD", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.MD", "docs/AGENTS.md", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"]) {
    assert.equal(isAutoLoadedInstruction(value), true, value);
  }
  for (const value of ["RULES.md", "docs/RULES.md", "SYSTEM.md", "agents.md", ".pi/rules/SYSTEM.txt"]) {
    assert.equal(isAutoLoadedInstruction(value), false, value);
  }
});

test("renders one Japanese reference line per instruction", () => {
  assert.equal(referenceLine("RULES.md"), "- 作業を始める前に `RULES.md` を読み、その指示に従うこと。");
});

test("reports paths no context text mentions, keeping first-seen order without duplicates", () => {
  assert.deepEqual(unreferencedPaths(["RULES.md", "docs/B.md", "RULES.md"], ["see docs/B.md"]), ["RULES.md"]);
  assert.deepEqual(unreferencedPaths(["RULES.md"], []), ["RULES.md"]);
  assert.deepEqual(unreferencedPaths(["RULES.md"], ["Read RULES.md first."]), []);
});

test("chooses the existing context file Pi prefers, else AGENTS.md", () => {
  assert.equal(chooseReferenceTarget(["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"]), "AGENTS.override.md");
  assert.equal(chooseReferenceTarget(["CLAUDE.MD", "CLAUDE.md"]), "CLAUDE.md");
  assert.equal(chooseReferenceTarget([]), "AGENTS.md");
});

test("appends after a blank line and repairs a missing final newline", () => {
  const line = referenceLine("RULES.md");
  assert.equal(appendReferenceLines(undefined, ["RULES.md"]), `${line}\n`);
  assert.equal(appendReferenceLines("", ["RULES.md"]), `${line}\n`);
  assert.equal(appendReferenceLines("# Project\n", ["RULES.md"]), `# Project\n\n${line}\n`);
  assert.equal(appendReferenceLines("# Project", ["RULES.md", "docs/B.md"]), `# Project\n\n${line}\n${referenceLine("docs/B.md")}\n`);
});
