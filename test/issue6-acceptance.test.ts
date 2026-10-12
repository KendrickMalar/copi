import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { prepareSavedChange, prepareSavedEdit, readSavedChange } from "../src/resource-mutations.ts";
import { add, box, catalogModule, cli, custody, down, editor, editRoute, finish, fixture, hash, loadCatalog, manage, noIds, plain, pty, restored, runCli, sourceNodeFlags, storedContentPath, terminalEditorModule, tree, type Step } from "./helpers/issue6-acceptance.ts";

const choose = (wait: string, index = 0): Step => ({ wait: `◆  ${wait}`, text: `${down.repeat(index)}\r` });
const reviewNo: Step = { wait: "Approve this masked diff", text: "n\r" };
const reviewYes: Step = { wait: "Approve this masked diff", text: "y\r" };
const submit = (text = "west\n\n東🙂\n"): Step => ({ wait: "Ctrl-S", text: `\x1b[1;5F\x1b[200~${text}\x1b[201~\x13` });
function success(run: Awaited<ReturnType<typeof manage>>) { assert.equal(run.code, 0, run.output); restored(run); }

// Expectations below are derived from the approved U1–U7 contract, not existing pass results.
test("U1 independent real name routes: view, confirmed rename and separate placement preserve identities and all body modes/bytes", async () => {
  const b = await fixture("# Route\nbody unchanged\n", { "notes.txt": "secondary\n" }); const before = await custody(b), old = await loadCatalog(b.library);
  const run = await manage(b, [choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action"), choose("Select saved file", 1),
    choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action", 2), { wait: "New display name", text: "  New route 計画  \r" }, { wait: "Save display name", text: "y\r" },
    choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action", 3), choose("Destination kind"), { wait: "New project-relative destination", text: ".pi/skills/route-next\r" }, { wait: "Save destination", text: "y\r" }, finish]);
  success(run); noIds(run.output, [b.item.id, b.group.id]);
  for (const visible of ["旅程 notes", "skill", "出張 bundle", ".pi/skills/itinerary", "body unchanged"]) assert.ok(plain(run.output).includes(visible), visible);
  const next = await loadCatalog(b.library);
  assert.deepEqual(next.items, [{ ...old.items[0]!, name: "New route 計画", destination: { kind: "project", path: ".pi/skills/route-next" } }]);
  assert.deepEqual(next.groups, old.groups);
  const after = await custody(b); delete before.library["catalog.json"]; delete after.library["catalog.json"]; assert.deepEqual(after, before);
});

for (const operation of ["rename", "destination", "group"] as const) test(`U1/U2 ${operation} explicit No preserves full raw filesystem`, async () => {
  const b = await fixture(), before = await custody(b);
  const steps: Step[] = operation === "group" ? [choose("Manage saved resources", 1), choose("Manage saved groups"), { wait: "New group name", text: "Not saved\r" }, choose("Manage saved groups", 4), { wait: "Save these group changes", text: "n\r" }] :
    [choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action", operation === "rename" ? 2 : 3), ...(operation === "rename" ? [{ wait: "New display name", text: "Abandoned\r" }, { wait: "Save display name", text: "n\r" }] : [choose("Destination kind"), { wait: "New project-relative destination", text: ".pi/skills/abandoned\r" }, { wait: "Save destination", text: "n\r" }])];
  const run = await manage(b, [...steps, finish]); success(run); assert.deepEqual(await custody(b), before); noIds(run.output, [b.item.id, b.group.id]);
});

test("U1 legacy Unicode duplicates allow masked view/explicit resolution only; cancel never repairs", async () => {
  const b = await fixture("apiKey: sk_live_tripSecret000012345\n"), second = await add(b, { "SKILL.md": "second body\n" }, "Other");
  const catalog = await loadCatalog(b.library); catalog.items[1]!.name = "旅程 NOTES";
  await writeFile(path.join(b.library, "catalog.json"), JSON.stringify(catalog)); const before = await custody(b);
  const run = await manage(b, [choose("Manage saved resources"), choose("Select saved resource", 1), choose("Resource action"), choose("Select saved file"), choose("Manage saved resources", 1), choose("Select a conflicting name", 1), { wait: "New name", text: "\x03" }, finish]);
  success(run); noIds(run.output, [b.item.id, second.item.id, b.group.id]);
  for (const forbidden of ["Edit saved text", "Rename display name", "Change destination", "Apply group", "Manage groups", "Setup copied resources"]) assert.ok(!run.output.includes(forbidden), forbidden);
  assert.ok(run.output.includes("second body")); assert.deepEqual(await custody(b), before);
  const resolved = await manage(b, [choose("Manage saved resources", 1), choose("Select a conflicting name", 1), { wait: "New name", text: "Another itinerary\r" }, { wait: "Save these name changes", text: "y\r" }, finish]);
  success(resolved); const next = await loadCatalog(b.library); assert.deepEqual(next, { ...catalog, items: catalog.items.map(i => i.id === second.item.id ? { ...i, name: "Another itinerary" } : i) });
});

test("U2 actual group membership then target apply keeps originals and saved bytes, without UUID input", async () => {
  const b = await fixture(), second = await add(b, { "SKILL.md": "backup route\n" }, "Spare itinerary", ".pi/skills/spare");
  const before = await custody(b), target = path.join(b.cwd, "chosen-target"); await mkdir(target);
  const run = await manage(b, [choose("Manage saved resources", 1), choose("Manage saved groups", 2), choose("Select group"), { wait: "Select resources in", text: `${down} \r` }, choose("Manage saved groups", 4), { wait: "Save these group changes", text: "y\r" },
    choose("Manage saved resources", 2), choose("Select group to apply"), { wait: "Apply target directory", text: `\x01\x0b${target}\r` }, { wait: "Apply the selected snapshots", text: "y\r" }, finish]);
  success(run); noIds(run.output, [b.item.id, second.item.id, b.group.id]);
  assert.deepEqual((await loadCatalog(b.library)).groups[0]!.itemIds, [b.item.id, second.item.id]);
  assert.deepEqual(await readFile(path.join(target, ".pi/skills/spare/SKILL.md")), Buffer.from("backup route\n"));
  assert.deepEqual(await readFile(path.join(target, ".pi/skills/itinerary/SKILL.md")), Buffer.from("north\nsouth\n"));
  assert.deepEqual(await tree(b.source), before.source); assert.deepEqual(await readSnapshotFiles(b.library, b.item), [{ ...b.item.files[0]!, bytes: Buffer.from("north\nsouth\n") }]);
});

test("U2 real colliding saved candidates/existing target/secret No are guarded; affirmative apply writes selected bytes only", async () => {
  const b = await fixture("public option\n"), second = await add(b, { "SKILL.md": "apiKey: sk_live_privateTrip12345678\n" }, "Private option");
  const catalog = await loadCatalog(b.library); catalog.groups[0]!.itemIds.push(second.item.id); await saveCatalog(b.library, catalog);
  const target = path.join(b.cwd, ".pi/skills/itinerary/SKILL.md"); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "existing target\n");
  const before = await custody(b);
  const route: Step[] = [choose("Manage saved resources", 2), choose("Select group to apply"), { wait: "Apply target directory", text: "\r" }, choose("Choose one resource for colliding", 1), choose("Existing file", 2)];
  // Existing-file prompt starts at Abort: 2 down wraps to Replace.
  const denied = await manage(b, [...route, { wait: "Apply suspected sensitive file", text: "n\r" }, finish]); success(denied); assert.deepEqual(await custody(b), before);
  const applied = await manage(b, [...route, { wait: "Apply suspected sensitive file", text: "y\r" }, { wait: "Apply the selected snapshots", text: "y\r" }, finish]); success(applied);
  noIds(applied.output, [b.item.id, second.item.id, b.group.id]); assert.ok(!applied.output.includes("sk_live_privateTrip12345678"));
  assert.deepEqual(await readFile(target), Buffer.from("apiKey: sk_live_privateTrip12345678\n"));
  const after = await tree(b.library), backups = Object.fromEntries(Object.entries(after).filter(([key]) => key === "backups" || key.startsWith("backups/")));
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key]) => key !== "backups" && !key.startsWith("backups/"))), before.library);
  const backupBytes = Object.entries(backups).filter(([key]) => key.endsWith(".bin")); assert.equal(backupBytes.length, 1);
  assert.equal(backupBytes[0]![1].hex, Buffer.from("existing target\n").toString("hex")); assert.equal(backupBytes[0]![1].mode, 0o600);
  assert.deepEqual(await tree(b.source), before.source);
});

test("U2/U7 empty library group/apply/setup exits remain read-only without authorized search", async () => {
  const b = await box(), before = await custody(b);
  const run = await manage(b, [choose("Manage saved resources", 1), choose("Manage saved resources", 0), choose("Manage saved groups", 1), choose("Manage saved resources", 2), { wait: "Choose the locations", text: "\r" }, { wait: "Authorize copi to search only", text: "\r" }, finish]);
  success(run); assert.match(run.output, /No groups to apply/); assert.match(run.output, /Search not authorized/); assert.deepEqual(await custody(b), before);
});

for (const initial of ["\ufeffCafe\u0301\r\n旅程🙂\r\n\r\n", "", "A".repeat(1_000_000)]) test(`U3 independent no-op prefill bytes ${Buffer.byteLength(initial)}`, async () => {
  const run = await editor(initial, [{ wait: "Ctrl-S", text: "\x13" }]); assert.deepEqual(run.result, { kind: "submitted", text: initial }); assert.ok(run.raw.length < 6_000); console.log(`editor result bytes=${Buffer.from(initial).toString("hex").slice(0, 160)} sha256=${hash(Buffer.from(initial))}`);
});

test("U3 chunk-split bracketed paste keeps blank/newline/control/UTF8 bytes literal and never submits until Ctrl-S", async () => {
  const pasted = "日\n\nCafe\u0301🙂\r\n\x03\x04\x13\x1b]52;c;NO_EXEC\x07\n";
  const chunks = ["1b5b32", "30307e", ...Array.from(Buffer.from(pasted), byte => byte.toString(16).padStart(2, "0")), "1b5b32", "30317e"];
  const run = await editor("base", [{ wait: "Ctrl-S", hex: chunks[0]!, delayMs: 10 }, ...chunks.slice(1).map(hex => ({ hex, delayMs: 10 })), { text: "\x13" }]);
  assert.deepEqual(run.result, { kind: "submitted", text: pasted + "base" }); assert.ok(!run.output.includes("\x1b]52;c;NO_EXEC"));
});

test("U3 grapheme horizontal/vertical/Home/End/newline editing uses entire Japanese/combining/astral glyphs", async () => {
  const run = await editor("one\n\n日本e\u0301🙂\nlast", [{ wait: "Ctrl-S", text: "\x1b[1;5F\x1b[A\x1b[H\x1b[C\x1b[C\x1b[3~X\x1b[F\x7f\r\r\x13" }]);
  assert.deepEqual(run.result, { kind: "submitted", text: "one\n\n日本X\n\n\nlast" });
});

test("U3 split UTF8 outside paste remains lossless and deleting combining/surrogate never cuts codepoints", async () => {
  const run = await editor("suffix", [{ wait: "Ctrl-S", hex: "f09f" }, { hex: "9982e697" }, { hex: "a5" }, { text: "e\u0301\x1b[D\x7f\x13" }]);
  assert.deepEqual(run.result, { kind: "submitted", text: "🙂e\u0301suffix" });
});

test("U3 long-line viewport PgUp/PgDn/resize is bounded and does not change bytes", async () => {
  const initial = Array.from({ length: 350 }, (_, i) => `ROW-${i}: ${"日本🙂e\u0301".repeat(24)}`).join("\n");
  const run = await editor(initial, [{ wait: "Ctrl-S", text: "\x1b[1;5F" }, { resize: [9, 26] }, { text: "\x1b[5~" }, { text: "\x1b[6~" }, { text: "\x13" }]);
  assert.deepEqual(run.result, { kind: "submitted", text: initial }); assert.ok(run.raw.length < 15_000); assert.ok(!run.output.includes("ROW-170:"));
  assert.ok(run.output.includes("Line 350/350")); assert.match(run.output, /Ctrl-S review\/Esc cancel/);
});

test("U3 auto cursor coordinates reflect Japanese/combining/emoji display cells (not an IME claim)", async () => {
  const run = await editor("日e\u0301🙂Z", [{ wait: "Ctrl-S", text: "\x1b[C\x1b[C" }, { text: "\x1b[C" }, { text: "\x13" }]);
  assert.deepEqual(run.result, { kind: "submitted", text: "日e\u0301🙂Z" });
  assert.ok(run.output.includes("\x1b[2;4H\x1b[?25h")); assert.ok(run.output.includes("\x1b[2;6H\x1b[?25h"));
});

for (const key of ["\x1b", "\x03", "\x04"]) test(`U3 cancel key ${Buffer.from(key).toString("hex")} restores exact PTY and subsequent canonical read/echo with no pending editor bytes`, async () => {
  const run = await editor("unique-original-prefill", [{ wait: "Ctrl-S", text: "unsaved" }, { text: key }, { wait: "CANONICAL_READY", checkpoint: true, text: "independent-next" }, { text: "\r" }, { wait: "CANONICAL_DONE", checkpoint: true }], "", true);
  assert.deepEqual(run.result, { kind: "cancelled" }); assert.equal(run.canonical, "independent-next\n"); assert.ok(run.output.includes("independent-next\r\n"));
  for (const check of run.checkpoints) assert.deepEqual(check.raw, run.before);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) test(`U3 ${signal} releases listeners and restores exact PTY`, async () => {
  const run = await editor("unique-signal-prefill", [{ wait: "Ctrl-S", text: "unsaved" }, { signal }]); assert.deepEqual(run.result, { kind: "cancelled" });
});
for (const [label, extra] of [
  ["EOF", "setTimeout(()=>process.stdin.push(null),350);"],
  ["input error", "setTimeout(()=>process.stdin.emit('error',new Error('independent-input-error')),350);"],
  ["output error", "setTimeout(()=>process.stdout.emit('error',new Error('independent-output-error')),350);"],
] as const) test(`U3 ${label} cleanup is exact (no general PENDIN exclusion)`, async () => {
  const run = await editor("unique-exception-prefill", [], extra); assert.deepEqual(run.result, { kind: "cancelled" });
});
const renderFailure = "const write=process.stdout.write.bind(process.stdout);let count=0;process.stdout.write=(...args)=>{if(++count===2)throw new Error('independent-sync-render');return write(...args)};";
test("U3 zero-input synchronous render exception records exact/full xor and permits only Darwin PENDIN", async () => {
  const run = await editor("render-exception-only", [], renderFailure, false, true); assert.deepEqual(run.result, { kind: "cancelled" }); console.log(`raw exact=${run.exact} xor=${JSON.stringify(run.xor)} before=${JSON.stringify(run.before)} after=${JSON.stringify(run.after)}`);
});
test("U3 render exception later canonical input independently clears PENDIN with full exact/echo/no leftover", async () => {
  const run = await editor("render-canonical-fixture", [{ wait: "CANONICAL_READY", checkpoint: true, text: "fresh-line" }, { text: "\r" }, { wait: "CANONICAL_DONE", checkpoint: true }], renderFailure, true);
  assert.equal(run.canonical, "fresh-line\n"); assert.ok(run.output.includes("fresh-line\r\n")); assert.deepEqual(run.checkpoints.at(-1)!.raw, run.before);
});

for (const [label, bytes, reason] of [
  ["oversize", Buffer.alloc(1_000_001, 0x71), /1_000_000|1 MB|limit/i], ["NUL", Buffer.from([0x71, 0]), /Binary|NUL/i],
  ["overlong UTF8", Buffer.from([0xc0, 0xaf]), /encoding|UTF-8/i], ["UTF16", Buffer.from([0xff, 0xfe, 0x41, 0]), /Binary|NUL|encoding/i],
] as const) test(`U4 real UI rejects ${label} before opening editor and never writes`, async () => {
  const b = await fixture(bytes), before = await custody(b), run = await manage(b, editRoute());
  assert.equal(run.code, 1, run.output); restored(run); assert.match(run.output, reason); assert.ok(!run.output.includes("\x1b[?1049h")); noIds(run.output, [b.item.id]); assert.deepEqual(await custody(b), before);
});
test("U4 exactly 1MB accepted but edited 1_000_001 bytes refused before any review", async () => {
  const b = await fixture(Buffer.alloc(1_000_000, 0x71)), before = await custody(b);
  const run = await manage(b, [...editRoute(), { wait: "Ctrl-S", text: "!\x13" }]); assert.equal(run.code, 1, run.output); restored(run); assert.match(run.output, /1_000_000|1 MB/); assert.ok(!run.output.includes("Approve this masked diff")); assert.deepEqual(await custody(b), before);
});
test("U4 missing original source is not required; saved UTF8 remains editable", async () => {
  const b = await fixture(); await rename(b.sourcePath, `${b.sourcePath}-offline`); const before = await custody(b);
  const run = await manage(b, [...editRoute(), submit(), reviewYes, { wait: "Save edited copy", text: "y\r" }, finish]); success(run);
  assert.deepEqual(await readFile(b.saved("SKILL.md")), Buffer.from("north\nsouth\nwest\n\n東🙂\n")); assert.deepEqual(await tree(b.source), before.source);
});
for (const corrupt of ["missing", "symlink"] as const) test(`U4 ${corrupt} saved layout is rejected with reason, not repaired`, async () => {
  const b = await fixture();
  if (corrupt === "missing") await rename(b.saved("SKILL.md"), path.join(b.root, "retained-missing.bin"));
  if (corrupt === "symlink") { await rename(b.saved("SKILL.md"), path.join(b.root, "retained-original.bin")); await symlink(path.join(b.sourcePath, "SKILL.md"), b.saved("SKILL.md")); }
  const before = await custody(b), run = await manage(b, editRoute()); assert.equal(run.code, 1, run.output); restored(run);
  assert.match(run.output, corrupt === "missing" ? /ENOENT|missing/i : /symbolic|symlink/i);
  assert.ok(!run.output.includes("\x1b[?1049h")); noIds(run.output, [b.item.id]); assert.deepEqual(await custody(b), before);
});
test("U4 ordinary saved children join the captured masked edit review and survive cancellation or approved save", async () => {
  const b = await fixture(), extraPath = b.saved("extra.txt");
  const secret = Buffer.from("apiKey: sk_live_reviewedOrdinaryChild123456789\n");
  await writeFile(extraPath, secret); await chmod(extraPath, 0o600);
  const originalStat = await lstat(extraPath), before = await custody(b);

  const prepared = await prepareSavedEdit(b.library, b.item.id, "SKILL.md");
  const change = await prepareSavedChange(prepared, Buffer.from("north\nsouth\nreviewed\n"));
  const review = readSavedChange(change);
  assert.deepEqual(review.diffs.map((diff) => diff.path), ["SKILL.md", "extra.txt"]);
  assert.equal(review.diffs.find((diff) => diff.path === "extra.txt")?.bytesChanged, false);
  assert.deepEqual(review.sensitivePaths, ["extra.txt"]);
  assert.ok(!JSON.stringify(review).includes(secret.toString()));

  const canceled = await manage(b, [...editRoute(), submit("north\nsouth\ncanceled\n"), reviewNo, finish]); success(canceled);
  assert.ok(!canceled.output.includes(secret.toString()));
  assert.deepEqual(await custody(b), before);
  const afterCancel = await lstat(extraPath); assert.equal(afterCancel.dev, originalStat.dev); assert.equal(afterCancel.ino, originalStat.ino);

  const approved = await manage(b, [...editRoute(), submit("north\nsouth\napproved\n"), reviewYes,
    { wait: "Save suspected sensitive file extra.txt", text: "y\r" }, { wait: "Save edited copy", text: "y\r" }, finish]); success(approved);
  assert.ok(approved.output.includes("Save suspected sensitive file extra.txt"));
  assert.ok(!approved.output.includes(secret.toString()));
  const catalog = await loadCatalog(b.library), item = catalog.items.find((saved) => saved.id === b.item.id)!;
  const extra = item.files.find((file) => file.path === "extra.txt"); assert.ok(extra);
  assert.equal(extra.mode, 0o600); assert.equal(extra.sha256, hash(secret));
  assert.deepEqual(await readFile(extraPath), secret);
  assert.deepEqual(await readSnapshotFiles(b.library, item).then((files) => files.find((file) => file.path === "extra.txt")), { ...extra, bytes: secret });
  assert.deepEqual(await tree(b.source), before.source);
});
test("U4 backend forbidden/unknown paths retain raw catalog/snapshot modes/bytes", async () => {
  const b = await fixture(), before = await custody(b);
  for (const relative of ["new.txt", "../outside", "/absolute", "a\\b", ".env", "auth/token.txt", "cache/x"]) await assert.rejects(prepareSavedEdit(b.library, b.item.id, relative), /registered|Unsafe|excluded/i);
  const prepared = await prepareSavedEdit(b.library, b.item.id, "SKILL.md"); await assert.rejects(prepareSavedChange(prepared, Buffer.alloc(1_000_001)), /1_000_000|1 MB/); assert.deepEqual(await custody(b), before);
});

test("U5 real masked view safely renders OSC/ESC, secrets in label/path/header/body, without sanitizing saved bytes", async () => {
  const b = await box(), secret = "sk_live_controlSecret12345678", filename = `!token-${secret}\x1b]52;c;PATH_ATTACK\x07.txt`;
  const a = await add(b, { "SKILL.md": "# Safe root skill\n", [filename]: `apiKey: ${secret}\n\x1b]52;c;BODY_ATTACK\x07\n` }, `name ${secret}\x1b]0;TITLE_ATTACK\x07`), before = await custody(b);
  const run = await manage(b, [choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action"), choose("Select saved file"), finish]); success(run);
  assert.ok(!run.output.includes(secret)); assert.ok(!run.output.includes("\x1b]")); assert.match(run.output, /REDACTED/); assert.match(run.output, /\\u001b/); noIds(run.output, [a.item.id]); assert.deepEqual(await custody(b), before);
});
for (const reply of ["n\r", "\x1b", "\x03", "\x04"]) test(`U5 raw consent denial/cancel ${Buffer.from(reply).toString("hex")} never exposes secret/editor`, async () => {
  const b = await fixture("apiKey: sk_live_rawExposure12345678\n"), before = await custody(b);
  const run = await manage(b, [...editRoute(), { wait: "Expose raw text of SKILL.md", text: reply }, ...(reply === "n\r" ? [finish] : [])]); success(run);
  assert.ok(!run.output.includes("sk_live_rawExposure12345678")); assert.ok(!run.output.includes("\x1b[?1049h")); assert.match(run.output, /screen, scrollback|terminal recordings/); assert.deepEqual(await custody(b), before);
});

test("U5/U6 multi-file reinspection requires separate path approvals after raw consent/diff; second No writes nothing", async () => {
  const b = await fixture("apiKey: sk_live_firstSecret12345678\n", { "z-secondary.txt": "apiKey: sk_live_secondSecret12345678\n" }), before = await custody(b);
  const selectedRootFile = [...editRoute().slice(0, -1), choose("Select saved file")];
  const run = await manage(b, [...selectedRootFile, { wait: "Expose raw text", text: "y\r" }, submit("apiKey: sk_live_thirdSecret12345678\n"), reviewYes,
    { wait: "Save suspected sensitive file SKILL.md", text: "y\r" }, { wait: "Save suspected sensitive file z-secondary.txt", text: "n\r" }, finish]); success(run);
  assert.deepEqual(await custody(b), before); assert.ok(!run.output.slice(run.output.indexOf("\x1b[?1049l")).includes("sk_live_"));
  assert.ok(run.output.indexOf("new approval") > run.output.indexOf("Approve this masked diff")); assert.ok(!run.output.includes("Save edited copy"));
});

test("U6 all separated masked hunks (four) visible before diff consent; submit does not commit", async () => {
  const original = Array.from({ length: 160 }, (_, i) => `route-${i}\n`).join(""), b = await fixture(original), before = await custody(b);
  const next = original.replace("route-0\n", "FIRST\n").replace("route-50\n", "SECOND\n").replace("route-100\n", "THIRD\n").replace("route-159\n", "LAST\n");
  const run = await manage(b, [...editRoute(), { wait: "Ctrl-S", text: `\x1b[1;5H${"\x1b[3~".repeat(original.length)}\x1b[200~${next}\x1b[201~\x13` }, reviewNo, finish]); success(run);
  const diff = run.output.slice(run.output.indexOf("Full masked saved diff"), run.output.indexOf("Approve this masked diff"));
  for (const line of ["+FIRST", "+SECOND", "+THIRD", "+LAST"]) assert.ok(diff.includes(line), line);
  assert.equal((diff.match(/@@ /g) ?? []).length, 4); assert.deepEqual(await custody(b), before);
});
for (const stage of ["before-editor", "mid-edit", "diff", "final", "EOF-final", "SIGINT-final", "SIGHUP-edit"] as const) test(`U6 ${stage} cancel leaves every raw catalog/file/mode/source/target unchanged`, async () => {
  const b = await fixture(), before = await custody(b); let steps = editRoute();
  if (stage === "before-editor") steps = [choose("Manage saved resources"), choose("Select saved resource"), { wait: "Resource action", text: "\x03" }];
  else if (stage === "mid-edit") steps.push({ wait: "Ctrl-S", text: "not saved\x03" });
  else if (stage === "SIGHUP-edit") steps.push({ wait: "Ctrl-S", signal: "SIGHUP" });
  else { steps.push(submit(), stage === "diff" ? reviewNo : reviewYes); if (stage !== "diff") steps.push(stage === "SIGINT-final" ? { wait: "Save edited copy", signal: "SIGINT" } : { wait: "Save edited copy", text: stage === "EOF-final" ? "\x04" : "n\r" }); }
  if (["diff", "final"].includes(stage)) steps.push(finish);
  const run = await manage(b, steps); success(run); assert.deepEqual(await custody(b), before);
});
for (const mutation of ["catalog", "body", "rename-metadata", "group-metadata"] as const) test(`U6 actual external ${mutation} at review wait rejects stale commit and does not hold storage lock`, async () => {
  const b = await fixture(), before = await custody(b), catalogPath = path.join(b.library, "catalog.json"); let changed: string;
  if (mutation === "body") changed = "external editor owns these bytes\n";
  else { const catalog = await loadCatalog(b.library); if (mutation === "rename-metadata") catalog.items[0]!.name = "Externally renamed"; if (mutation === "group-metadata") catalog.groups[0]!.name = "External group"; changed = ` ${JSON.stringify(catalog)}`; }
  const changedPath = mutation === "body" ? b.saved("SKILL.md") : catalogPath;
  const probe = [process.execPath, ...sourceNodeFlags, "--input-type=module", "-e", `import {loadCatalog} from ${JSON.stringify(catalogModule)}; const c=await loadCatalog(${JSON.stringify(b.library)}); console.log(c.items[0].name);`];
  const run = await manage(b, [...editRoute(), submit(), { ...reviewYes, probe, replace: { path: changedPath, text: changed } }, { wait: "Save edited copy", text: "y\r" }]);
  assert.equal(run.probes[0]!.code, 0, JSON.stringify(run.probes)); assert.match(run.probes[0]!.stdout!, /旅程 notes/);
  assert.equal(run.code, 1, run.output); restored(run); assert.match(run.output, /changed|checksum|revision/i); noIds(run.output, [b.item.id, b.group.id]);
  assert.deepEqual(await readFile(changedPath), Buffer.from(changed)); assert.deepEqual(await tree(b.source), before.source);
  if (mutation !== "body") assert.deepEqual(await readFile(b.saved("SKILL.md")), Buffer.from("north\nsouth\n"));
});

for (const operation of ["rename", "placement", "group"] as const) test(`U1/U2/U6 external ${operation} metadata at confirmation is not silently overwritten`, async () => {
  const b = await fixture(), before = await custody(b), external = await loadCatalog(b.library), catalogPath = path.join(b.library, "catalog.json");
  const snapshotBefore = await tree(storedContentPath(b.library, b.item.content.path));
  if (operation === "rename") external.items[0]!.name = "External user rename";
  if (operation === "placement") external.items[0]!.destination = { kind: "project", path: ".pi/skills/external-placement" };
  if (operation === "group") external.groups[0]!.name = "External user group";
  const externalBytes = `${JSON.stringify(external, null, 2)}\n`;
  const staged: Step[] = operation === "group" ? [choose("Manage saved resources", 1), choose("Manage saved groups", 1), choose("Select group"), { wait: "New name for", text: "Local pending group\r" }, choose("Manage saved groups", 4)] :
    [choose("Manage saved resources"), choose("Select saved resource"), choose("Resource action", operation === "rename" ? 2 : 3), ...(operation === "rename" ? [{ wait: "New display name", text: "Local pending rename\r" }] : [choose("Destination kind"), { wait: "New project-relative destination", text: ".pi/skills/local-pending\r" }])];
  const confirmation = operation === "rename" ? "Save display name only" : operation === "placement" ? "Save destination only" : "Save these group changes";
  const run = await manage(b, [...staged, { wait: confirmation, replace: { path: catalogPath, text: externalBytes }, text: "y\r" }, finish]);
  // Finish is cleanup if the buggy path returns to manage; correct stale rejection exits before it.
  assert.equal(run.timeout, false); assert.equal(run.exact, true, JSON.stringify(run));
  assert.deepEqual(await readFile(catalogPath), Buffer.from(externalBytes), `stale ${operation} approval must preserve external raw catalog; evidence ${run.log}`);
  assert.deepEqual(await tree(b.source), before.source); assert.deepEqual(await tree(storedContentPath(b.library, b.item.content.path)), snapshotBefore);
  assert.equal(run.code, 1, "stale metadata should stop with a reason"); assert.match(run.output, /changed|revision|reload/i);
});

test("U3/U6 manage bracketed control paste must reach review rather than being interpreted as global EOF", async () => {
  const b = await fixture(), before = await custody(b);
  const run = await manage(b, [...editRoute(), { wait: "Ctrl-S", text: "\x1b[200~pasted\x04literal\n\n\x1b[201~\x13" }, reviewNo, finish]);
  assert.equal(run.code, 0, run.output); assert.deepEqual(await custody(b), before);
  assert.match(run.output, /Full masked saved diff/, `literal pasted Ctrl-D must not cancel manage; evidence ${run.log}`); success(run);
});

test("U5/U6 real new-secret save and same-mask secret replacement need fresh save consent and keep IDs/source/modes", async () => {
  const b = await fixture(), before = await custody(b), original = await loadCatalog(b.library);
  const secret = "sk_live_freshConsent12345678", added = `apiKey: ${secret}\n`;
  const run = await manage(b, [...editRoute(), submit(added), reviewYes, { wait: "Save suspected sensitive file SKILL.md", text: "y\r" }, { wait: "Save edited copy", text: "y\r" }, finish]); success(run);
  const expected = Buffer.from(`north\nsouth\n${added}`), next = await loadCatalog(b.library);
  assert.deepEqual(await readFile(b.saved("SKILL.md")), expected); assert.equal(next.items[0]!.files[0]!.sha256, hash(expected));
  assert.deepEqual(next.items, [{ ...original.items[0]!, files: [{ ...original.items[0]!.files[0]!, sha256: hash(expected) }] }]); assert.deepEqual(next.groups, original.groups);
  assert.deepEqual(await tree(b.source), before.source); assert.ok(!run.output.includes("Expose raw text"));
  const newSecret = "sk_live_otherConsent12345678", rawBody = expected.toString();
  const sameMask = await manage(b, [...editRoute(), { wait: "Expose raw text", text: "y\r" }, { wait: "Ctrl-S", text: `\x1b[1;5H${"\x1b[3~".repeat(rawBody.length)}\x1b[200~${rawBody.replace(secret, newSecret)}\x1b[201~\x13` }, reviewYes, { wait: "Save suspected sensitive file SKILL.md", text: "n\r" }, finish]); success(sameMask);
  assert.deepEqual(await readFile(b.saved("SKILL.md")), expected); assert.match(sameMask.output, /Bytes changed/);
  const maskedDiff = sameMask.output.slice(sameMask.output.indexOf("Full masked saved diff")); assert.ok(!maskedDiff.includes(secret)); assert.ok(!maskedDiff.includes(newSecret));
});

test("U6 manage BOM/CRLF/NFD/blank no-op writes no raw catalog/file or mode", async () => {
  const b = await fixture("\ufeffRe\u0301sume\r\n日本🙂\r\n\r\n"), before = await custody(b);
  const run = await manage(b, [...editRoute(), { wait: "Ctrl-S", text: "\x13" }, finish]); success(run);
  assert.match(run.output, /No byte changes/); assert.ok(!run.output.includes("Approve this masked diff")); assert.deepEqual(await custody(b), before);
});

for (const mode of ["stdin-pipe", "stdout-pipe", "both-pipe"]) test(`U7 independent ${mode} guard precedes catalog reading and search/editor`, async () => {
  const b = await box(); await mkdir(b.library); await writeFile(path.join(b.library, "catalog.json"), "malformed sentinel"); const before = await custody(b);
  const run = await pty(b, [process.execPath, ...sourceNodeFlags, cli, "manage"], [], mode); assert.equal(run.code, 1, run.output); restored(run);
  assert.match(run.output, /stdin\/stdout TTY/); assert.ok(!run.output.includes("Invalid copi catalog")); assert.ok(!run.output.includes("Manage saved resources")); assert.deepEqual(await custody(b), before);
});
test("U7 old CLI help/invalid args/symlink/list/groups/setup/apply remain guarded or readonly", async () => {
  const b = await box(), linked = path.join(b.root, "copi-bin"); await symlink(cli, linked); const before = await custody(b);
  for (const args of [[], ["help"], ["--help"], ["-h"], ["manage", "--help"], ["list"], ["groups"]]) { const run = runCli(b, args, linked); assert.equal(run.status, 0, run.stderr); assert.ok(run.stdout.length > 0); }
  for (const args of [["manage", "bad"], ["unknown"], ["setup"], ["apply", "Named"], ["list", "extra"], ["groups", "extra"]]) { const run = runCli(b, args, linked); assert.equal(run.status, 1); assert.ok(run.stderr.length > 0); }
  assert.deepEqual(await custody(b), before);
});

test("U3 recognized partial paste CSI with finite 180ms continuation must not act as a standalone Esc cancellation", async () => {
  const b = await box(), initial = "ANCHOR", pasted = "finite-delay\n\n旅程\n", expected = { kind: "submitted", text: pasted + initial };
  const resultFile = path.join(b.root, "finite-csi-result.json");
  const code = `import {writeFile} from 'node:fs/promises'; import {editTerminalText} from ${JSON.stringify(terminalEditorModule)};
const result=await editTerminalText(${JSON.stringify(initial)});
await writeFile(${JSON.stringify(resultFile)},JSON.stringify({result,expected:${JSON.stringify(expected)},expectedHex:${JSON.stringify(Buffer.from(expected.text).toString("hex"))}}));
process.stdout.write('FINITE_CSI_RESULT_READY'); await new Promise(resolve=>setTimeout(resolve,1000));`;
  // Valid opening CSI is already recognized (ESC[2); this is not an isolated Esc key.
  // Hold the child alive only to record the completed ordered input even on premature cancellation.
  const steps: Step[] = [{ wait: "Ctrl-S", hex: "1b5b32" }, { delayMs: 180, text: `00~${pasted}\x1b[201~\x13` }];
  const run = await pty(b, [process.execPath, ...sourceNodeFlags, "--input-type=module", "-e", code], steps);
  const saved = JSON.parse(await readFile(resultFile, "utf8")) as { result: { kind: string; text?: string }; expectedHex: string };
  console.log(`finite CSI result=${JSON.stringify(saved)} timeline=${JSON.stringify(run.timeline)} resultFile=${resultFile}`);
  assert.equal(run.code, 0, run.output); assert.equal(run.timeout, false); assert.equal(run.actions, 2);
  assert.ok(run.timeline[1]!.elapsedMs - run.timeline[0]!.elapsedMs >= 180);
  for (const action of run.timeline) assert.equal(action.written, action.sentHex.length / 2, "full ordered input must reach PTY");
  assert.deepEqual(saved.result, expected, `finite recognized CSI continuation must preserve pasted text; result ${resultFile}, evidence ${run.log}`);
  restored(run);
});
