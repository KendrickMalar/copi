import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { previewText, tabOf } from "../src/resource-picker.ts";
import type { ResourceCandidate } from "../src/types.ts";
import { safeDisplay } from "../src/wizard.ts";
import { acceptanceBox, cli, realPty } from "./helpers/issue2-acceptance.ts";

const flat = (output: string) => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const cand = (sourcePath: string, kind: ResourceCandidate["kind"] = "skill"): ResourceCandidate =>
  ({ id: sourcePath, kind, source: "s", scope: "project", sourceRoot: "/", sourcePath, name: path.basename(sourcePath), destination: { kind: "global-only" } });

test("tabOf groups kinds into Skills, Agents, Instructions and Settings", () => {
  assert.equal(tabOf("skill"), "Skills");
  assert.equal(tabOf("subagent"), "Agents");
  assert.equal(tabOf("instruction"), "Instructions");
  for (const kind of ["pi-settings", "mcp-config", "model-config", "keybindings"] as const) assert.equal(tabOf(kind), "Settings");
});

test("previewText masks secrets, limits lines, neutralizes control characters and refuses binary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-picker-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = ["sk", "live", "abcdEFGH12345678"].join("_");
  await mkdir(path.join(root, "skill"), { recursive: true });
  await writeFile(path.join(root, "skill", "SKILL.md"), `line1\napiKey: ${secret}\nbell\u0007here\n4\n5\n6\n7\n8\n`);
  const shown = previewText(cand(path.join(root, "skill")), 6, safeDisplay);
  assert.equal(shown.title, "skill/SKILL.md");
  assert.equal(shown.body.length, 7);
  assert.ok(!shown.body.join("\n").includes(secret));
  assert.ok(!shown.body.join("\n").includes("\u0007"));
  assert.equal(shown.body.at(-1), "… 2 more lines");
  await writeFile(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  assert.deepEqual(previewText(cand(path.join(root, "bin.dat"), "pi-settings"), 6, safeDisplay).body, ["[binary file]"]);
  assert.deepEqual(previewText(cand(path.join(root, "missing")), 6, safeDisplay).body, []);
});

async function mixedProject() {
  const box = await acceptanceBox();
  const skill = path.join(box.project, ".pi", "skills", "alpha");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), `# alpha\napiKey: ${["sk", "live", "pickerSecret12345678"].join("_")}\n`);
  await mkdir(path.join(box.project, ".pi", "agents"), { recursive: true });
  await writeFile(path.join(box.project, ".pi", "agents", "helper.md"), "---\nname: helper\n---\nhelps\n");
  return box;
}
const start = [
  { waitFor: "Choose the locations", send: "\u001b[B\r" },
  { waitFor: "Authorize copi", send: "y" },
];

test("picker tabs keep selections across tabs and preview the focused row masked", async () => {
  const box = await mixedProject();
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Preview: alpha/SKILL.md", send: "\t" },
    { waitFor: "Skills 1 (1 selected)", send: "\u001b[C" },
    { waitFor: "Preview: helper.md", send: "\t" },
    { waitFor: "Agents 1 (1 selected)", send: "\r" },
    { waitFor: "2 items selected", send: "\u0003" },
  ]);
  const screen = flat(result.output);
  assert.match(screen, /Skills 1 │/);
  assert.match(screen, /Agents 1/);
  assert.ok(!screen.includes("pickerSecret12345678"), "preview is masked");
  assert.match(screen, /←\/→ tabs/);
});

test("Ctrl-C in the picker cancels setup and saves nothing", async () => {
  const box = await mixedProject();
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    ...start,
    { waitFor: "Preview: alpha/SKILL.md", send: "\t\u0003" },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.match(flat(result.output), /Setup cancelled; no resources were saved\./);
  const catalog = await loadCatalog(box.library).catch(() => undefined);
  assert.ok(!catalog || catalog.items.length === 0, "nothing was saved");
});
