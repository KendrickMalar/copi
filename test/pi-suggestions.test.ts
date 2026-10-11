import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { askPiForSuggestions, buildSuggestionPrompt, isolatedPiFlags, parseSuggestions, resolvePiCommand } from "../src/pi-suggestions.ts";
import type { ResourceCandidate } from "../src/types.ts";
import { acceptanceBox, cli, realPty } from "./helpers/issue2-acceptance.ts";

const secret = ["sk", "live", "suggestSecret12345678"].join("_");
const cand = (id: string, sourcePath: string, kind: ResourceCandidate["kind"] = "skill"): ResourceCandidate =>
  ({ id, kind, source: "s", scope: "project", sourceRoot: "/", sourcePath, name: path.basename(sourcePath), destination: { kind: "global-only" } });

/** A fake `pi` that records its argv and answers with the given script body (POSIX sh). */
async function fakePi(dir: string, body: string): Promise<{ command: string; argsLog: string }> {
  const command = path.join(dir, "fake-pi");
  const argsLog = path.join(dir, "args.log");
  await writeFile(command, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done\n${body}\n`);
  await chmod(command, 0o755);
  return { command, argsLog };
}

test("parseSuggestions keeps only known ids with valid verdicts and tolerates prose around the JSON", () => {
  const parsed = parseSuggestions('Sure!\n[{"id":"r1","verdict":"keep","reason":"useful"},{"id":"r2","verdict":"maybe"},{"id":"zz","verdict":"skip"}]\nDone', new Set(["r1", "r2"]));
  assert.deepEqual([...parsed!.entries()], [["r1", { keep: true, reason: "useful" }]]);
  assert.equal(parseSuggestions("no json here", new Set(["r1"])), undefined);
  assert.equal(parseSuggestions("[not json]", new Set(["r1"])), undefined);
});

test("buildSuggestionPrompt sends masked excerpts and descriptions, never source paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-suggest-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "alpha"), { recursive: true });
  await writeFile(path.join(root, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: "Alpha helper"\n---\napiKey: ${secret}\n`);
  const prompt = buildSuggestionPrompt([{ id: "r1", candidate: cand("x", path.join(root, "alpha")) }]);
  assert.match(prompt, /"description": "Alpha helper"/);
  assert.ok(!prompt.includes(secret), "secrets are masked");
  assert.ok(!prompt.includes(root), "no paths are sent");
});

test("resolvePiCommand honours COPI_PI_COMMAND and PATH, and rejects missing commands", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-suggest-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { command } = await fakePi(root, "true");
  assert.equal(resolvePiCommand({ COPI_PI_COMMAND: command }), command);
  assert.equal(resolvePiCommand({ PATH: root, COPI_PI_COMMAND: "fake-pi" }), command);
  assert.equal(resolvePiCommand({ PATH: root }), undefined, "no `pi` on this PATH");
  assert.equal(resolvePiCommand({ COPI_PI_COMMAND: path.join(root, "missing") }), undefined);
});

test("askPiForSuggestions runs Pi isolated and maps verdicts back to candidates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-suggest-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["a", "b"]) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "SKILL.md"), `# ${name}\n`);
  }
  const ok = await fakePi(root, `echo '[{"id":"r1","verdict":"keep","reason":"solid"},{"id":"r2","verdict":"skip","reason":"empty"}]'`);
  const result = await askPiForSuggestions([cand("A", path.join(root, "a")), cand("B", path.join(root, "b"))], { command: ok.command });
  assert.ok(result.ok);
  assert.deepEqual(result.ok && [...result.suggestions.entries()], [["A", { keep: true, reason: "solid" }], ["B", { keep: false, reason: "empty" }]]);
  const args = (await readFile(ok.argsLog, "utf8")).split("\n");
  for (const flag of isolatedPiFlags) assert.ok(args.includes(flag), `pi runs with ${flag}`);
});

test("askPiForSuggestions reports failures instead of throwing: exit code, garbage, timeout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-suggest-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "a"), { recursive: true });
  await writeFile(path.join(root, "a", "SKILL.md"), "# a\n");
  const list = [cand("A", path.join(root, "a"))];
  const exits = await fakePi(await mkdtemp(path.join(root, "x-")), "exit 3");
  assert.deepEqual(await askPiForSuggestions(list, { command: exits.command }), { ok: false, reason: "pi exited with code 3" });
  const garbage = await fakePi(await mkdtemp(path.join(root, "g-")), "echo hello");
  assert.deepEqual(await askPiForSuggestions(list, { command: garbage.command }), { ok: false, reason: "the reply was not a JSON array" });
  const slow = await fakePi(await mkdtemp(path.join(root, "s-")), "sleep 5");
  const timedOut = await askPiForSuggestions(list, { command: slow.command, timeoutMs: 300 });
  assert.equal(timedOut.ok, false);
});

async function suggestionProject() {
  const box = await acceptanceBox();
  for (const name of ["keeper", "dropper"]) {
    const folder = path.join(box.project, ".pi", "skills", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `# ${name}\n`);
  }
  return box;
}
const flat = (output: string) => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("setup: suggestions are opt-in (default No never runs Pi) and keep-verdicts start selected", async (t) => {
  const tools = await mkdtemp(path.join(os.tmpdir(), "copi-suggest-pty-"));
  t.after(() => rm(tools, { recursive: true, force: true }));
  // Candidates are sorted by name: dropper = r1, keeper = r2.
  const pi = await fakePi(tools, `echo '[{"id":"r1","verdict":"skip","reason":"near empty"},{"id":"r2","verdict":"keep","reason":"reusable"}]'`);
  const previous = process.env.COPI_PI_COMMAND;
  process.env.COPI_PI_COMMAND = pi.command;
  t.after(() => { process.env.COPI_PI_COMMAND = previous; });

  const declined = await realPty(await suggestionProject(), [process.execPath, cli, "setup"], [
    { waitFor: "Choose the locations", send: "\u001b[B\r" },
    { waitFor: "Authorize copi", send: "y" },
    { waitFor: "Ask Pi to suggest", send: "\r" },
    { waitFor: "Select resources to review", send: "\u0003" },
  ]);
  assert.match(flat(declined.output), /Skills 2(?! \()/, "no suggestions or preselection without consent");
  await assert.rejects(readFile(pi.argsLog), { code: "ENOENT" }, "declining never runs Pi");

  const accepted = await realPty(await suggestionProject(), [process.execPath, cli, "setup"], [
    { waitFor: "Choose the locations", send: "\u001b[B\r" },
    { waitFor: "Authorize copi", send: "y" },
    { waitFor: "Ask Pi to suggest", send: "y" },
    { waitFor: "Pi suggested 1 of 2", send: "" },
    { waitFor: "Skills 2 (1 selected, 1 suggested)", send: "\r" },
    { waitFor: "1 items selected", send: "\u0003" },
  ]);
  const screen = flat(accepted.output);
  assert.match(screen, /★ \[skill\] keeper/);
  assert.match(screen, /· \[skill\] dropper/);
  assert.match(screen, /Pi: skip — near empty/);
});
