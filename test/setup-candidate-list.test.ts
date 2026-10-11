import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptanceBox, add, cli, realPty } from "./helpers/issue2-acceptance.ts";

test("#8 setup lists same-named candidates with distinct source labels, adjacent, and marks already-saved names", async () => {
  const box = await acceptanceBox();
  await add(box, "Known");
  for (const [dir, name] of [["set-0", "dup"], ["set-1", "dup"], ["set-2", "Known"], ["set-3", "zeta"]] as const) {
    const folder = path.join(box.project, ".pi", "skills", dir, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "# safe\n");
  }
  const result = await realPty(box, [process.execPath, cli, "setup"], [
    { waitFor: "Choose the locations", send: "\u001b[B\r" },
    { waitFor: "Authorize copi", send: "y" },
    { waitFor: "Filter resources", send: "\u0003" },
  ]);
  const text = result.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(text, /PTY actions 3\/3/);
  const rows = text.split(/\r?\n/).filter((line) => /\[skill\] /.test(line));
  const dups = rows.map((r, i) => ({ r, i })).filter(({ r }) => /\] dup — /.test(r));
  assert.equal(dups.length, 2, text);
  assert.equal(dups[1]!.i - dups[0]!.i, 1, "same-named rows are adjacent");
  assert.notEqual(dups[0]!.r.match(/— (\S+)/)?.[1], dups[1]!.r.match(/— (\S+)/)?.[1]);
  assert.match(dups[0]!.r, /set-0/);
  assert.match(dups[1]!.r, /set-1/);
  assert.ok(rows.some((r) => /\] Known — .*set-2.*\(already saved\)/.test(r)), text);
  assert.ok(!rows.some((r) => /\] dup .*already saved/.test(r)));
  assert.ok(!rows.some((r) => /\] zeta .*already saved/.test(r)));
});
