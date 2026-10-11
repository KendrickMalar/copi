import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acceptanceBox, cli, realPty } from "./helpers/issue2-acceptance.ts";

const flat = (output: string) => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[│◇◆┌└─]/g, " ").replace(/\s+/g, " ");

test("setup merges identical same-named candidates into one row and keeps differing ones apart", async () => {
  const box = await acceptanceBox();
  for (const [dir, body] of [["set-0", "# same\n"], ["set-1", "# same\n"], ["set-2", "# different\n"]] as const) {
    const folder = path.join(box.project, ".pi", "skills", dir, "dup");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), body);
  }
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    { waitFor: "Choose the locations", send: "\u001b[B\r" },
    { waitFor: "Authorize copi", send: "y" },
    { waitFor: "Select resources to review", send: "\u0003" },
  ]);
  const screen = flat(result.output);
  assert.match(screen, /Merged 1 identical copies; 2 distinct resource\(s\) to choose from\./);
  assert.equal((screen.match(/\[skill\] dup —/g) ?? []).length, 2);
  assert.equal((screen.match(/\(\+1 identical copy\)/g) ?? []).length, 1);
});
