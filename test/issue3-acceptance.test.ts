import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog, readSnapshotFiles } from "../src/catalog.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange } from "../src/resource-mutations.ts";
import { nameKey } from "../src/names.ts";
import { answer, box, cli, environment, finish, groupSteps, hash, normalized, observe, originals, originalModes,
  plain, pty, refreshApprovals, refreshRoute, register, route, run, savedContentRoot, select, setupSteps, snapshot, source, tree,
  unchanged, uuid, type Fixture, type Step } from "./helpers/issue3-acceptance.ts";

// Oracles are fixed here from the approved Issues/supplements. No coder helper import.
const refreshed = {
  "SKILL.md": "# Embedded MapKit\napiKey: sk_live_i3FixedRefresh123456\n完全な置換\n",
  "a.md": "password: i3FixedOther123456\nnew second\n",
  "empty.txt": "",
  "new.md": "added by the approved whole source snapshot\n",
};
const refreshModes = { "SKILL.md": 0o700, "a.md": 0o604, "empty.txt": 0o644, "new.md": 0o750 };
async function replacement(b: Fixture) {
  await rename(path.join(b.sourcePath, "retired.md"), path.join(b.root, "held-retired.md"));
  await source(b, refreshed, refreshModes);
}
const editStart = (): Step[] => [...route(1), select("Select saved file", 3), answer("Expose raw text of SKILL.md")];
const submit = (text = "copi独立追記\n\n末尾\n"): Step => answer("Ctrl-S", `\x1b[1;5F\x1b[200~${text}\x1b[201~\x13`);
const saveReview = (): Step[] => [answer("Approve this masked diff for saving?"), answer("Save suspected sensitive file a.md"), answer("Save suspected sensitive file SKILL.md"), answer("Save edited copy of SKILL.md?")];
function masked(output: string, secrets: readonly string[]) { for (const s of secrets) assert.ok(!output.includes(s), `unapproved display leak: ${s}`); }
const oldSecrets = ["sk_live_i3OriginalMap123456", "i3OriginalOther123456"];
const newSecrets = ["sk_live_i3FixedRefresh123456", "i3FixedOther123456"];

// Sole full operation route uses actual setup/manage/apply CLI, not mutation APIs.
test("I1/I2 independent actual registration → text edit → display rename → fixed refresh → every group → apply", async () => {
  const b = await box();
  for (const excluded of ["auth/private.md", ".env-test", "cache/private.md"]) await source(b, { [excluded]: "must never be imported\n" }, {});
  const item = await register(b);
  await run(b, "beta-membership", ["manage"], groupSteps("Beta", 1));
  const before = await observe(b, "before-editor");
  assert.deepEqual(before.catalog.groups.map(g => g.name), ["Alpha 日本", "Beta"]);
  assert.ok(before.catalog.groups.every(g => g.itemIds.length === 1 && g.itemIds[0] === item.id));
  const edited = { ...originals, "SKILL.md": originals["SKILL.md"] + "copi独立追記\n\n末尾\n" };
  const e = await run(b, "terminal-edit", ["manage"], [...editStart(), submit(), ...saveReview(), finish]);
  assert.ok(e.output.indexOf("Expose raw text") < e.output.indexOf("\x1b[?1049h"));
  assert.ok(e.output.includes(oldSecrets[0]!)); // Raw text only after actual individual Yes.
  assert.ok(e.output.indexOf("Full masked saved diff") < e.output.indexOf("Approve this masked diff"));
  masked(e.output.slice(e.output.indexOf("Full masked saved diff")), oldSecrets);
  const afterEdit = await snapshot(b, edited, originalModes);
  assert.deepEqual(afterEdit, { ...item, files: afterEdit.files });
  assert.deepEqual((await loadCatalog(b.library)).groups, before.catalog.groups);
  assert.deepEqual(await tree(b.source), before.source); assert.deepEqual(await tree(b.target), before.target);
  await observe(b, "after-editor");

  await run(b, "display-rename", ["manage"], [...route(2), answer("New display name for", "Renamed 地図\r"), answer("Save display name only?"), finish]);
  const renamed = await snapshot(b, edited, originalModes);
  assert.deepEqual(renamed, { ...afterEdit, name: "Renamed 地図" });
  assert.ok((await readSnapshotFiles(b.library, renamed)).find(f => f.path === "SKILL.md")!.bytes.includes(Buffer.from("Embedded MapKit")));
  assert.deepEqual((await loadCatalog(b.library)).groups, before.catalog.groups);
  assert.deepEqual(await tree(b.source), before.source); await observe(b, "renamed");

  await replacement(b); const sourceFixed = await tree(b.source);
  const late = "# late unreviewed source\n変更混入禁止\n";
  const approvals = refreshApprovals();
  approvals[3] = { ...approvals[3]!, replace: { path: path.join(b.sourcePath, "SKILL.md"), text: late } };
  const r = await run(b, "fixed-refresh", ["manage"], [...refreshRoute(), ...approvals, finish]);
  for (const phrase of ["All copi-only edits will be lost", "Original files will not be changed or written back", "no history, restore or automatic merge"]) assert.ok(normalized(r.output).includes(phrase));
  assert.ok(r.output.indexOf("Replacement warning") < r.output.indexOf("Approve this refresh diff"));
  masked(r.output, [...oldSecrets, ...newSecrets]);
  assert.match(plain(r.output), /retired\.md/); assert.match(plain(r.output), /new\.md/);
  const saved = await snapshot(b, refreshed, refreshModes);
  assert.deepEqual(saved, { ...renamed, files: saved.files });
  assert.deepEqual((await loadCatalog(b.library)).groups, before.catalog.groups);
  const expectedSource = structuredClone(sourceFixed); expectedSource["MapKit/SKILL.md"]!.hex = Buffer.from(late).toString("hex");
  assert.deepEqual(await tree(b.source), expectedSource);
  assert.equal(await readFile(path.join(b.root, "held-retired.md"), "utf8"), originals["retired.md"]);
  assert.ok(!(await readFile(path.join(savedContentRoot(b, saved), "SKILL.md"))).includes(Buffer.from("copi独立追記")));
  await observe(b, "after-fixed-refresh");

  await run(b, "gamma-membership", ["manage"], groupSteps("Gamma", 2));
  const last = await observe(b, "last-canonical-save");
  assert.equal(last.catalog.groups.length, 3); assert.deepEqual(last.catalog.items, [saved]);
  assert.deepEqual(last.catalog.groups.slice(0, 2), before.catalog.groups);
  assert.ok(last.catalog.groups.every(g => g.itemIds.length === 1 && g.itemIds[0] === item.id));
  const apply = await run(b, "real-apply", ["manage"], [select("Manage saved resources", 2), select("Select group to apply", 2),
    answer("Apply target directory", `\x01\x0b${b.target}\r`), answer("Apply suspected sensitive file .pi/skills/MapKit/a.md?"),
    answer("Apply suspected sensitive file .pi/skills/MapKit/SKILL.md?"), answer("Apply the selected snapshots to"), finish]);
  assert.match(plain(apply.output), /Applied 4 file\(s\)/); masked(apply.output, newSecrets);
  const target = await tree(b.target);
  for (const [file, text] of Object.entries(refreshed)) {
    const applied = await readFile(path.join(b.target, ".pi/skills/MapKit", file));
    const stored = await readFile(path.join(savedContentRoot(b, saved), file));
    assert.deepEqual(applied, Buffer.from(text)); assert.deepEqual(applied, stored);
    assert.equal(hash(applied), saved.files.find(f => f.path === file)!.sha256);
    assert.equal(target[`.pi/skills/MapKit/${file}`]!.mode, refreshModes[file as keyof typeof refreshModes]);
    console.log(`I2 independent ${file} bytes=${applied.length} sha256=${hash(applied)} private=600 descriptor/apply=${target[`.pi/skills/MapKit/${file}`]!.mode.toString(8)}`);
  }
  assert.deepEqual(await tree(b.library), last.library); assert.deepEqual(await tree(b.source), expectedSource);
  await observe(b, "after-real-apply", { fixedBytes: refreshed, expectedModes: refreshModes, sourceOnlyDeliberateChanges: true });
});

for (const stage of ["search-No", "secret-one-No", "secret-two-No", "final-No"] as const) test(`I3 independent actual setup ${stage}: no partial library/source/target mutation`, async () => {
  const b = await box(); await source(b); const before = await observe(b, "setup-before");
  let steps = setupSteps();
  if (stage === "search-No") steps = [steps[0]!, answer("Authorize copi to search only", "n\r")];
  if (stage === "secret-one-No") steps = [...steps.slice(0, 4), answer("Save suspected sensitive file a.md", "n\r"), answer("Save suspected sensitive file SKILL.md")];
  if (stage === "secret-two-No") steps = [...steps.slice(0, 5), answer("Save suspected sensitive file SKILL.md", "n\r")];
  if (stage === "final-No") steps[6] = answer("Save 1 copied resource(s)", "n\r");
  const r = await run(b, stage, ["setup"], steps); masked(r.output, oldSecrets);
  assert.match(plain(r.output), /not authorized|No resources were approved|Nothing was saved/);
  await unchanged(b, before, "setup-after");
});

for (const stage of ["raw-No", "editor-Esc", "diff-No", "secret-one-No", "secret-two-No", "final-No", "final-EOF"] as const) test(`I3/U5/U6 independent terminal edit ${stage}: no save despite prior partial approvals`, async () => {
  const b = await box(); await register(b); const before = await observe(b, "edit-cancel-before");
  let steps: Step[] = editStart();
  if (stage === "raw-No") steps[4] = answer("Expose raw text of SKILL.md", "n\r");
  else if (stage === "editor-Esc") steps.push(answer("Ctrl-S", "未承認\x1b"));
  else {
    steps.push(submit()); const approvals = saveReview();
    if (stage === "diff-No") steps.push(answer("Approve this masked diff", "n\r"));
    if (stage === "secret-one-No") steps.push(approvals[0]!, answer("Save suspected sensitive file a.md", "n\r"));
    if (stage === "secret-two-No") steps.push(...approvals.slice(0, 2), answer("Save suspected sensitive file SKILL.md", "n\r"));
    if (stage === "final-No" || stage === "final-EOF") steps.push(...approvals.slice(0, 3), answer("Save edited copy of SKILL.md?", stage === "final-No" ? "n\r" : "\x04"));
  }
  if (stage !== "editor-Esc" && stage !== "final-EOF") steps.push(finish);
  const r = await run(b, stage, ["manage"], steps);
  if (stage === "raw-No") { masked(r.output, oldSecrets); assert.ok(!r.output.includes("\x1b[?1049h")); }
  else if (stage !== "editor-Esc") masked(r.output.slice(r.output.indexOf("Full masked saved diff")), oldSecrets);
  await unchanged(b, before, "edit-cancel-after");
});

for (const stage of ["read-No", "diff-No", "second-secret-No", "final-Esc", "stale-catalog"] as const) test(`I3/R6 independent actual refresh ${stage}: retain copy, originals, all references and external winner`, async () => {
  const b = await box(); await register(b); await replacement(b);
  const before = await observe(b, "refresh-before");
  let steps = refreshRoute();
  if (stage === "read-No") steps[3] = answer("Authorize reading only this selected source", "n\r");
  else if (stage === "diff-No") steps.push(answer("Approve this refresh diff and source metadata?", "n\r"));
  else if (stage === "second-secret-No") steps.push(...refreshApprovals().slice(0, 2), answer("Save suspected sensitive file SKILL.md", "n\r"));
  else steps.push(...refreshApprovals());
  if (stage === "final-Esc") steps[7] = answer("Replace saved copy with this approved source snapshot?", "\x1b");
  const external = ` \n${await readFile(path.join(b.library, "catalog.json"), "utf8")}`;
  if (stage === "stale-catalog") steps[7] = { ...steps[7]!, replace: { path: path.join(b.library, "catalog.json"), text: external } };
  else if (stage !== "final-Esc") steps.push(finish);
  const r = await run(b, stage, ["manage"], steps, stage === "stale-catalog" ? 1 : 0); masked(r.output, [...oldSecrets, ...newSecrets]);
  if (stage === "stale-catalog") {
    assert.match(plain(r.output), /changed|revision|reload/i);
    const after = await observe(b, "refresh-conflict-after"); const expected = structuredClone(before.library);
    expected["catalog.json"]!.hex = Buffer.from(external).toString("hex");
    assert.deepEqual(after.library, expected); assert.deepEqual(after.source, before.source); assert.deepEqual(after.target, before.target);
    assert.deepEqual(after.catalog, before.catalog); assert.deepEqual(after.snapshots, before.snapshots);
  } else await unchanged(b, before, "refresh-cancel-after");
});

test("I3/R2 independent source absent reselects same-kind explicit path without changing saved identity or held original", async () => {
  const b = await box(), item = await register(b);
  await run(b, "extra-group", ["manage"], groupSteps("Reselect team", 1));
  const held = path.join(b.root, "held-original"); await rename(b.sourcePath, held); const old = await tree(held);
  const next = path.join(b.root, "explicit-new-source"); await source(b, refreshed, refreshModes, next);
  const before = await observe(b, "missing-source-before"), fresh = await tree(next);
  await run(b, "explicit-reselect", ["manage"], [...route(4), answer("New source path (absolute; same resource kind)", `${next}\r`), select("Source scope (metadata only"),
    answer("Authorize reading only this selected source"), ...refreshApprovals(), finish]);
  const after = await snapshot(b, refreshed, refreshModes);
  assert.deepEqual(after, { ...item, source: "explicit-refresh-path", sourcePath: next, files: after.files });
  assert.deepEqual((await loadCatalog(b.library)).groups, before.catalog.groups);
  assert.deepEqual(await tree(held), old); assert.deepEqual(await tree(next), fresh); assert.deepEqual(await tree(b.target), before.target);
  await observe(b, "missing-source-after", { held: await tree(held), explicitSource: await tree(next) });
});

test("I3/N3/N4 legacy v1 duplicate names remain read-only: masked reader and cancelled exit preserve legacy bytes", async () => {
  const b = await box(), item = await register(b), modern = await loadCatalog(b.library);
  if (modern.version !== 2) throw new Error("Legacy fixture setup requires a modern registration source.");
  const legacyFiles = await readSnapshotFiles(b.library, item);
  const legacyFilesRoot = path.join(b.library, "items", item.id, "files");
  await mkdir(legacyFilesRoot, { recursive: true });
  for (const file of legacyFiles) {
    const target = path.join(legacyFilesRoot, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: 0o600 });
  }
  const legacyItem = { id: item.id, kind: item.kind, source: item.source, scope: item.scope, sourcePath: item.sourcePath,
    destination: item.destination, name: item.name, savedAt: item.savedAt, files: item.files };
  const legacyCatalog = { version: 1, items: [legacyItem], groups: [...modern.groups,
    { id: randomUUID(), name: "Ａlpha 日本", itemIds: [item.id] }] };
  await writeFile(path.join(b.library, "catalog.json"), JSON.stringify(legacyCatalog));
  const before = await observe(b, "legacy-before");
  const r = await run(b, "legacy-view-cancel", ["manage"], [...route(0), select("Select saved file", 3), answer("Manage saved resources", "\x1b")]);
  assert.match(plain(r.output), /Legacy catalog v1 is read-only; duplicate names are not changed here/);
  assert.match(plain(r.output), /Only listing and masked viewing are available/);
  assert.match(plain(r.output), /Masked saved view/); masked(r.output, oldSecrets);
  assert.ok(!r.output.includes("Edit saved text") && !r.output.includes("Apply group") && !r.output.includes("Resolve name conflicts"));
  assert.deepEqual(await readFile(path.join(legacyFilesRoot, "SKILL.md")), Buffer.from(originals["SKILL.md"]));
  await unchanged(b, before, "legacy-after-cancel");
});

test("I3/N3/N4 modern v2 duplicate names retain explicit name-only resolution", async () => {
  const b = await box(), item = await register(b), catalog = await loadCatalog(b.library);
  if (catalog.version !== 2) throw new Error("Modern conflict fixture requires catalog v2.");
  catalog.groups.push({ id: randomUUID(), name: "Ａlpha 日本", itemIds: [item.id] });
  await writeFile(path.join(b.library, "catalog.json"), JSON.stringify(catalog));
  const before = await observe(b, "modern-duplicate-before");
  const r = await run(b, "modern-duplicate-resolve", ["manage"], [select("Manage saved resources", 1),
    select("Select a conflicting name to rename"), answer("New name for", "Chosen Alpha\r"), answer("Save these name changes?"), finish]);
  assert.match(plain(r.output), /Duplicate names/); assert.match(plain(r.output), /Explicit name changes/);
  assert.match(plain(r.output), /Explicit name changes; saved contents and destinations stay unchanged/); masked(r.output, oldSecrets);
  const after = await observe(b, "modern-duplicate-after");
  const expected = structuredClone(before.catalog); expected.groups[0]!.name = "Chosen Alpha";
  assert.deepEqual(after.catalog, expected); assert.deepEqual(after.snapshots, before.snapshots);
  assert.deepEqual(after.source, before.source); assert.deepEqual(after.target, before.target);
});

test("I3/S5 independent API exact approval set: insufficient/No/foreign/duplicate/extra approvals cannot borrow raw consent", async () => {
  const b = await box(), item = await register(b); const before = await observe(b, "approval-before");
  const proposal = await prepareSavedChange(await prepareSavedEdit(b.library, item.id, "SKILL.md"), Buffer.from("apiKey: sk_live_i3NewSave123456\n"));
  assert.deepEqual([...readSavedChange(proposal).sensitivePaths].sort(), ["SKILL.md", "a.md"].sort());
  for (const approval of [
    { confirmed: false, reviewId: proposal.reviewId, approvedSensitivePaths: ["a.md", "SKILL.md"] },
    { confirmed: true, reviewId: "unrelated-review", approvedSensitivePaths: ["a.md", "SKILL.md"] },
    ...[[], ["SKILL.md"], ["a.md"], ["a.md", "SKILL.md", "a.md"], ["a.md", "SKILL.md", "extra.md"]].map(approvedSensitivePaths => ({ confirmed: true, reviewId: proposal.reviewId, approvedSensitivePaths })),
  ]) {
    await assert.rejects(commitSavedChange(proposal, approval), /confirm|review|approval/i);
    await unchanged(b, before, "approval-denied");
  }
});

for (const [label, bytes, reason] of [
  ["too-large", Buffer.alloc(1_000_001, 120), /1_000_000|limited/i],
  ["invalid-UTF8", Buffer.from([0xc0, 0xaf]), /Unsupported encoding|UTF-8/i],
  ["NUL", Buffer.from([65, 0, 66]), /Binary|NUL/i],
] as const) test(`I3/U4 independent actual setup then editor boundary ${label}: refusal before raw editor`, async () => {
  const b = await box(); await register(b, { "SKILL.md": bytes }, { "SKILL.md": 0o751 }, false);
  const before = await observe(b, "boundary-before");
  const r = await run(b, label, ["manage"], [...route(1), select("Select saved file")], 1);
  assert.match(plain(r.output), reason); assert.ok(!r.output.includes("\x1b[?1049h")); await unchanged(b, before, "boundary-after");
});

test("I3/U4 independent exact million bytes is editable but million-plus-one proposal fails, retaining bytes/hash/mode", async () => {
  const b = await box(); await register(b, { "SKILL.md": Buffer.alloc(1_000_000, 120) }, { "SKILL.md": 0o751 }, false);
  const before = await observe(b, "million-before");
  const r = await run(b, "million-plus-one", ["manage"], [...route(1), select("Select saved file"), answer("Ctrl-S", "\x1b[1;5FX\x13")], 1);
  assert.match(plain(r.output), /1_000_000/); assert.ok(r.output.includes("\x1b[?1049h"));
  assert.ok(!r.output.includes("Approve this masked diff")); await unchanged(b, before, "million-after");
});

for (const scenario of ["current-content", "source-symlink"] as const) test(`I3/S2/S6/R5 independent ${scenario}: current bytes and inode custody; unsafe source links fail closed`, async () => {
  const b = await box(), item = await register(b);
  if (scenario === "current-content") {
    const file = path.join(savedContentRoot(b, item), "SKILL.md");
    const descriptor = item.files.find(entry => entry.path === "SKILL.md")!;
    const inodeBefore = await lstat(file, { bigint: true });
    const currentText = "# Embedded MapKit\nCurrent registered bytes are the source of truth.\n";
    await writeFile(file, currentText);
    const inodeAfterEdit = await lstat(file, { bigint: true });
    assert.equal(inodeAfterEdit.dev, inodeBefore.dev); assert.equal(inodeAfterEdit.ino, inodeBefore.ino);
    const currentFiles = await readSnapshotFiles(b.library, item);
    const current = currentFiles.find(entry => entry.path === "SKILL.md")!;
    assert.deepEqual(current.bytes, Buffer.from(currentText)); assert.equal(current.sha256, hash(Buffer.from(currentText)));
    assert.notEqual(current.sha256, descriptor.sha256); assert.equal(current.mode, descriptor.mode);
    const catalog = await loadCatalog(b.library);
    if (catalog.version !== 2) throw new Error("Current-content fixture must remain catalog v2.");
    assert.deepEqual(catalog.items[0]!.files.find(entry => entry.path === "SKILL.md"), descriptor);
    const before = await observe(b, "current-content-before-view");
    const r = await run(b, "current-content-view", ["manage"], [...route(0), select("Select saved file", 3), finish]);
    assert.match(plain(r.output), /Current registered bytes are the source of truth/); masked(r.output, oldSecrets);
    await unchanged(b, before, "current-content-after-view");
    const inodeAfterView = await lstat(file, { bigint: true });
    assert.equal(inodeAfterView.dev, inodeBefore.dev); assert.equal(inodeAfterView.ino, inodeBefore.ino);
  } else {
    const original = path.join(b.sourcePath, "SKILL.md"), held = path.join(b.root, "held-source-SKILL.md");
    await rename(original, held); await symlink(held, original);
    const before = { library: await tree(b.library), source: await tree(b.source), target: await tree(b.target), held: await tree(b.root) };
    const r = await run(b, scenario, ["manage"], refreshRoute(), 1); assert.match(plain(r.output), /symbolic/i);
    assert.deepEqual(await tree(b.library), before.library); assert.deepEqual(await tree(b.source), before.source); assert.deepEqual(await tree(b.target), before.target);
    assert.equal(await readFile(path.join(b.root, "held-source-SKILL.md"), "utf8"), originals["SKILL.md"]);
    await writeFile(path.join(b.root, `${scenario}-custody.json`), JSON.stringify({ before, after: { library: await tree(b.library), source: await tree(b.source), target: await tree(b.target) } }));
  }
});

test("I5/U3 independent documented actual editor keys produce fixed Japanese/blank-line bytes and restore terminal ownership", async () => {
  const b = await box(), result = path.join(b.root, "key-result.json");
  const entry = new URL("../src/terminal-editor.js", import.meta.url).href;
  const code = `import {writeFile} from 'node:fs/promises';import {editTerminalText} from ${JSON.stringify(entry)};
const count=()=>['data','end','close','error'].map(e=>process.stdin.listenerCount(e)).concat(['SIGINT','SIGTERM','SIGHUP'].map(e=>process.listenerCount(e)),['resize','error'].map(e=>process.stdout.listenerCount(e)));
const before=count(),rawBefore=Boolean(process.stdin.isRaw);const r=await editTerminalText('abc\\ndef');await new Promise(r=>setTimeout(r,30));await writeFile(${JSON.stringify(result)},JSON.stringify({r,before,after:count(),rawBefore,rawAfter:Boolean(process.stdin.isRaw)}));`;
  const keys = "\x1b[F\x1b[D\x7f\x1b[3~\x1b[H\x1b[C\r\x1b[B\x1b[A\x1b[B\x1b[F\x1b[D\x1b[200~日本\n\n\x1b[201~\x1b[1;5H[\x1b[1;5F]\x1b[5~\x1b[6~";
  const r = await pty(b, [process.execPath, "--input-type=module", "-e", code], [answer("Ctrl-S", keys), { delayMs: 100, resize: [18, 68], checkpoint: true }, { delayMs: 100, text: "\x13", checkpoint: true }]);
  assert.equal(r.timeout, false); assert.equal(r.code, 0); assert.equal(r.actions, 3); assert.equal(r.exact, true);
  assert.ok(r.output.includes("\x1b[?2004l\x1b[?1049l\x1b[?25h"));
  const actual = JSON.parse(await readFile(result, "utf8"));
  assert.deepEqual(actual.r, { kind: "submitted", text: "[a\n\nde日本\n\nf]" });
  assert.deepEqual(actual.after, actual.before); assert.equal(actual.rawAfter, actual.rawBefore);
  console.log(`I5 keys result=${result} bytes=${Buffer.byteLength(actual.r.text)} hash=${hash(Buffer.from(actual.r.text))}`);
});

test("I5/U7 independent fixed documentation/help meanings, aliases, read-only old commands and non-TTY boundaries", async () => {
  const b = await box(); const before = await observe(b, "help-before");
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const statements = [/copi manage/, /names.*unique.*separate|unique across the library.*separate/s, /NFKC.*Unicode 17.*full case folding.*NFKC/s,
    /duplicate.*manual|rename them manually/s, /UTF-8/, /1_000_000 bytes/, /raw text.*screen.*scrollback.*recordings/s,
    /separate individual approval|individual approval to expose/, /heuristic/, /whole.*saved copy/s, /same-kind source/,
    /edits.*lost/s, /Originals are not written back|writes back to the original/, /history.*restore.*automatic merge/s,
    /0600/, /source mode|Original source modes/, /outside scope/, /Ctrl-S/, /PgUp.*PgDn/];
  for (const regex of statements) assert.match(readme, regex);
  assert.match(readme, /real-device.*outside.*has not been performed/s); assert.match(readme, /minimum Node 22\.19\.0.*not been verified/s);
  const aliases = [[], ["help"], ["--help"], ["-h"], ...["setup", "manage", "groups", "list", "apply"].flatMap(c => [[c, "--help"], [c, "-h"]])];
  let canonical: string | undefined;
  const commands: unknown[] = [];
  for (const args of aliases) {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: b.cwd, env: environment(b), encoding: "utf8", timeout: 15_000 });
    commands.push({ args, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
    assert.equal(r.status, 0); assert.equal(r.signal, null); assert.equal(r.error, undefined); assert.equal(r.stderr, "");
    canonical ??= r.stdout; assert.equal(r.stdout, canonical); assert.doesNotMatch(r.stdout, uuid);
    for (const regex of statements) assert.match(r.stdout, regex);
  }
  for (const args of [["list"], ["groups"], ["manage"], ["setup"], ["apply", "Alpha 日本", b.target]]) {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: b.cwd, env: environment(b), encoding: "utf8", timeout: 15_000 });
    commands.push({ args, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
    assert.equal(r.status, args[0] === "list" || args[0] === "groups" ? 0 : 1); assert.equal(r.signal, null); assert.equal(r.error, undefined);
    if (r.status === 1) assert.match(r.stderr, /TTY/);
  }
  await writeFile(path.join(b.root, "readonly-commands.json"), JSON.stringify(commands));
  await unchanged(b, before, "help-after");
  await register(b); const saved = await observe(b, "old-readonly-before");
  for (const args of [["list"], ["groups"], ["apply", "Alpha 日本", b.target, "--dry-run"]]) {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: b.cwd, env: environment(b), encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0); assert.equal(r.signal, null); assert.equal(r.error, undefined);
    assert.doesNotMatch(r.stdout, uuid); masked(r.stdout, oldSecrets);
    commands.push({ args, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr });
  }
  await writeFile(path.join(b.root, "registered-readonly-commands.json"), JSON.stringify(commands));
  await unchanged(b, saved, "old-readonly-after");
  for (const mode of ["stdin-pipe", "stdout-pipe", "both-pipe"]) {
    await run(b, `manage-${mode}`, ["manage"], [], 1, mode); await unchanged(b, saved, `after-${mode}`);
  }
});

// A small independent frozen specification seam, not product-derived keys.
for (const [left, right, same] of [[" Ａ ", "a", true], ["Straße", "STRASSE", true], ["é", "e\u0301", true], ["é", "e", false], ["I", "ı", false], ["İ", "i\u0307", true]] as const)
  test(`I5/N1 fixed Unicode oracle ${left}/${right}`, () => assert.equal(nameKey(left) === nameKey(right), same));
