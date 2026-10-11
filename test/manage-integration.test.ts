import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog, readSnapshotFiles } from "../src/catalog.ts";
import { addGroupSteps, at, choose, evidence, finish, hash, initialFiles, integrationBox, interactive, plain, registered,
  resource, runCli, setupSteps, sourceFiles, tree, type IntegrationBox, type Step } from "./helpers/manage-integration.ts";

// Catches wiring that bypasses setup/editor/refresh approval, loses identity/membership,
// writes originals, or applies different bytes/modes than the fixed approved copy.
const refreshedFiles = {
  "SKILL.md": "# Original embedded name\napiKey: sk_live_refreshFirst12345678\nsource replacement\n",
  "second.md": "password: refreshSecond12345678\nreplacement secondary\n",
};
const refreshSteps = (): Step[] => [...resource(4), at("Authorize reading only this selected source"),
  at("Approve this refresh diff and source metadata"), at("Save suspected sensitive file second.md"),
  at("Save suspected sensitive file SKILL.md")];
async function replaceSource(b: IntegrationBox) {
  for (const [file, text] of Object.entries(refreshedFiles)) await writeFile(path.join(b.sourcePath, file), text);
  await chmod(path.join(b.sourcePath, "SKILL.md"), 0o700);
}
async function assertSnapshot(b: IntegrationBox, expected: Record<string, string>, skillMode: number) {
  const catalog = await loadCatalog(b.library);
  if (catalog.version !== 2) throw new Error("Saved snapshots must use catalog v2 sources content.");
  const item = catalog.items[0]!;
  const files = await readSnapshotFiles(b.library, item);
  const contentRoot = path.join(b.library, ...item.content.path.split("/"));
  assert.deepEqual(files.map(f => f.path).sort(), Object.keys(expected).sort());
  for (const file of files) {
    const bytes = Buffer.from(expected[file.path]!);
    assert.deepEqual(file.bytes, bytes); assert.equal(file.sha256, hash(bytes));
    assert.equal(file.mode, file.path === "SKILL.md" ? skillMode : 0o640);
    const saved = (await tree(contentRoot))[file.path]!;
    assert.equal(saved.mode, 0o600); assert.equal(saved.hex, bytes.toString("hex"));
  }
  return item;
}

test("I1/I2 real setup → name edit → rename → fixed refresh → all groups → apply; UUID-free, bytes/hash/mode custody", async () => {
  const b = await integrationBox(), item = await registered(b);
  await interactive(b, "initial-second-group", "manage", addGroupSteps("Second bundle", 1));
  const initial = await evidence(b, "before-edit"), catalog = initial.catalog;
  assert.equal(catalog.groups.length, 2);
  assert.ok(catalog.groups.every(g => g.itemIds.length === 1 && g.itemIds[0] === item.id));
  const edited = { ...initialFiles, "SKILL.md": initialFiles["SKILL.md"] + "copi-only 日本\n\nedit\n" };
  const edit = await interactive(b, "edit", "manage", [...resource(1), choose("Select saved file", 1),
    at("Expose raw text of SKILL.md"), at("Ctrl-S", "\x1b[1;5F\x1b[200~copi-only 日本\n\nedit\n\x1b[201~\x13"),
    at("Approve this masked diff"), at("Save suspected sensitive file second.md"),
    at("Save suspected sensitive file SKILL.md"), at("Save edited copy of SKILL.md"), finish]);
  assert.match(plain(edit.output), /Full masked saved diff/);
  const diff = edit.output.slice(edit.output.indexOf("Full masked saved diff"));
  assert.ok(!diff.includes("sk_live_setupFirst12345678")); assert.ok(!diff.includes("setupSecond12345678"));
  assert.ok(edit.output.indexOf("Expose raw text") < edit.output.indexOf("\x1b[?1049h"));
  assert.ok(edit.output.indexOf("Full masked saved diff") < edit.output.indexOf("Approve this masked diff"));
  const afterEdit = await assertSnapshot(b, edited, 0o751);
  assert.deepEqual(afterEdit, { ...item, files: afterEdit.files });
  assert.deepEqual((await loadCatalog(b.library)).groups, catalog.groups);
  assert.deepEqual(await tree(b.source), initial.source); assert.deepEqual(await tree(b.target), initial.target);

  const rename = await interactive(b, "rename", "manage", [...resource(2), at("New display name", "Renamed 日本\r"), at("Save display name only"), finish]);
  assert.match(plain(rename.output), /Display name saved/);
  const renamed = await assertSnapshot(b, edited, 0o751);
  assert.deepEqual(renamed, { ...afterEdit, name: "Renamed 日本" });
  assert.deepEqual((await loadCatalog(b.library)).groups, catalog.groups);
  assert.deepEqual(await tree(b.source), initial.source);
  assert.ok((await readSnapshotFiles(b.library, renamed)).find(f => f.path === "SKILL.md")!.bytes.includes(Buffer.from("Original embedded name")));

  await replaceSource(b);
  const preparedSource = await tree(b.source), beforeRefresh = await evidence(b, "source-intentionally-updated");
  const lateText = "# Original embedded name\nlate unreviewed source bytes\n";
  const refreshed = await interactive(b, "refresh", "manage", [...refreshSteps(), {
    ...at("Replace saved copy with this approved source snapshot"), checkpoint: true,
    replace: { path: path.join(b.sourcePath, "SKILL.md"), text: lateText },
  }, finish]);
  assert.match(plain(refreshed.output), /Full masked refresh diff/);
  const normalized = plain(refreshed.output).replace(/[│◇◆┌└─]/g, " ").replace(/\s+/g, " ");
  for (const warning of ["All copi-only edits will be lost", "Original files will not be changed or written back", "no history, restore or automatic merge"])
    assert.ok(normalized.toLowerCase().includes(warning.toLowerCase()), warning);
  assert.ok(refreshed.output.indexOf("Replacement warning") < refreshed.output.indexOf("Approve this refresh diff"));
  assert.ok(!refreshed.output.includes("sk_live_refreshFirst12345678")); assert.ok(!refreshed.output.includes("refreshSecond12345678"));
  const next = await assertSnapshot(b, refreshedFiles, 0o700);
  assert.deepEqual(next, { ...renamed, files: next.files });
  assert.deepEqual((await loadCatalog(b.library)).groups, beforeRefresh.catalog.groups);
  assert.ok(!next.files.some(f => f.sha256 === hash(Buffer.from(edited["SKILL.md"]))));
  const expectedSource = structuredClone(preparedSource);
  expectedSource["original/SKILL.md"]!.hex = Buffer.from(lateText).toString("hex");
  assert.deepEqual(await tree(b.source), expectedSource, "only deliberate source changes, never copi writes");

  await interactive(b, "third-group-assignment", "manage", addGroupSteps("Third bundle", 2));
  const allGroups = await loadCatalog(b.library);
  assert.deepEqual(allGroups.items, [next]);
  assert.deepEqual(allGroups.groups.slice(0, 2), catalog.groups);
  assert.equal(allGroups.groups.length, 3); assert.ok(allGroups.groups.every(g => g.itemIds[0] === item.id && g.itemIds.length === 1));
  const beforeApply = await evidence(b, "last-saved-copy");
  for (const args of [["list"], ["groups"], ["apply", "Third bundle", b.target, "--dry-run"]]) {
    const run = runCli(b, args); assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes(item.id)); for (const g of allGroups.groups) assert.ok(!run.stdout.includes(g.id));
    assert.ok(!run.stdout.includes("sk_live_")); assert.ok(!run.stdout.includes("refreshSecond12345678"));
  }
  assert.deepEqual(await tree(b.target), beforeApply.target);
  const apply = await interactive(b, "apply", "manage", [choose("Manage saved resources", 2), choose("Select group to apply", 2),
    at("Apply target directory", `\x01\x0b${b.target}\r`),
    at("Apply suspected sensitive file .pi/skills/original/second.md"),
    at("Apply suspected sensitive file .pi/skills/original/SKILL.md"), at("Apply the selected snapshots"), finish]);
  assert.match(plain(apply.output), /Applied 2 file\(s\)/);
  const target = await tree(b.target);
  for (const [file, text] of Object.entries(refreshedFiles)) {
    const applied = await readFile(path.join(b.target, ".pi/skills/original", file));
    const saved = await readFile(path.join(b.library, ...next.content.path.split("/"), file));
    assert.deepEqual(applied, saved); assert.deepEqual(applied, Buffer.from(text)); assert.equal(hash(applied), hash(saved));
    assert.equal(target[`.pi/skills/original/${file}`]!.mode, file === "SKILL.md" ? 0o700 : 0o640);
    console.log(`I2 applied ${file} bytes=${applied.length} sha256=${hash(applied)} savedHash=${hash(saved)}`);
  }
  assert.deepEqual(await tree(b.source), expectedSource);
  assert.deepEqual(await tree(b.library), beforeApply.library);
  await evidence(b, "applied-final", { sourceOnlyIntentionalChanges: true, approvedSnapshotNotLateSource: true });
});

test("I3 real setup two concrete secret approvals: second No cannot register an incompletely approved resource", async () => {
  const b = await integrationBox(); await sourceFiles(b); const before = await evidence(b, "setup-denial-before");
  const steps = setupSteps().slice(0, 6); steps[5] = at("Save suspected sensitive file SKILL.md", "n\r");
  const run = await interactive(b, "setup-second-secret-no", "setup", steps);
  assert.match(plain(run.output), /No resources were approved/);
  const after = await evidence(b, "setup-denial-after");
  assert.deepEqual(after.catalog, before.catalog); assert.deepEqual(after.library, before.library);
  assert.deepEqual(after.source, before.source); assert.deepEqual(after.target, before.target);
});

for (const stage of ["second-secret-No", "final-No", "stale-catalog", "stale-content"] as const) test(`I3 real refresh ${stage} preserves unconfirmed bytes/references and restores TTY`, async () => {
  const b = await integrationBox(); await registered(b); await replaceSource(b);
  const before = await evidence(b, `${stage}-before`), catalogPath = path.join(b.library, "catalog.json");
  const runtimeCatalog = await loadCatalog(b.library);
  if (runtimeCatalog.version !== 2) throw new Error("Refresh race fixture requires catalog v2.");
  const item = runtimeCatalog.items[0]!;
  const contentFile = path.join(b.library, ...item.content.path.split("/"), "SKILL.md");
  const contentDescriptor = item.files.find(file => file.path === "SKILL.md")!;
  const contentInode = stage === "stale-content" ? await lstat(contentFile, { bigint: true }) : undefined;
  const lateContent = "# Original embedded name\nUnreviewed saved-source edit after preview\n";
  const external = ` ${await readFile(catalogPath, "utf8")}`;
  let steps = refreshSteps();
  if (stage === "second-secret-No") steps[steps.length - 1] = at("Save suspected sensitive file SKILL.md", "n\r");
  else steps.push(at("Replace saved copy with this approved source snapshot", stage === "final-No" ? "n\r" : "y\r"));
  if (stage === "stale-catalog") steps[4] = { ...steps[4]!, replace: { path: catalogPath, text: external } };
  else if (stage === "stale-content") steps[4] = { ...steps[4]!, replace: { path: contentFile, text: lateContent } };
  else steps.push(finish);
  const stale = stage.startsWith("stale-");
  const run = await interactive(b, `${stage}-run`, "manage", steps, stale ? 1 : 0);
  assert.match(plain(run.output), stale ? /changed|revision|reload/i : /not approved|cancelled/i);
  const after = await evidence(b, `${stage}-after`);
  if (stage === "stale-catalog") {
    assert.deepEqual(await readFile(catalogPath), Buffer.from(external));
    const expected = structuredClone(before.library); expected["catalog.json"]!.hex = Buffer.from(external).toString("hex");
    assert.deepEqual(after.library, expected);
    assert.deepEqual(after.snapshots, before.snapshots);
  } else if (stage === "stale-content") {
    const expectedLibrary = structuredClone(before.library);
    const relativeContent = `${item.content.path}/SKILL.md`;
    expectedLibrary[relativeContent]!.hex = Buffer.from(lateContent).toString("hex");
    assert.deepEqual(after.library, expectedLibrary);
    assert.deepEqual(after.catalog, before.catalog); assert.deepEqual(after.source, before.source); assert.deepEqual(after.target, before.target);
    const current = (await readSnapshotFiles(b.library, item)).find(file => file.path === "SKILL.md")!;
    assert.deepEqual(current.bytes, Buffer.from(lateContent)); assert.equal(current.sha256, hash(Buffer.from(lateContent)));
    assert.notEqual(current.sha256, contentDescriptor.sha256); assert.equal(current.mode, contentDescriptor.mode);
    const contentAfter = await lstat(contentFile, { bigint: true });
    assert.equal(contentAfter.dev, contentInode!.dev); assert.equal(contentAfter.ino, contentInode!.ino);
  } else {
    assert.deepEqual(after.library, before.library);
    assert.deepEqual(after.catalog, before.catalog); assert.deepEqual(after.source, before.source); assert.deepEqual(after.target, before.target);
    assert.deepEqual(after.snapshots, before.snapshots);
  }
});

test("setup location select: Enter right after start chooses HOME and reaches the search authorization", async () => {
  const b = await integrationBox();
  const run = plain((await interactive(b, "location-default", "setup", [at("Choose the locations copi may inspect", "\r"), at("Authorize copi to search only", "\r")])).output);
  assert.ok(run.includes("Choose the locations copi may inspect"));
  assert.ok(run.includes("Authorize copi to search only"));
  assert.match(run, /Search not authorized/);
  assert.ok(!run.includes("No locations selected"));
  // The scope note proves HOME (not project-only) was chosen, and prints before the Authorize prompt.
  assert.ok(run.includes(`HOME: ${b.home}`));
  assert.ok(run.includes(`Pi agent directory: ${b.agent}`));
  assert.ok(run.includes("Project: not selected"));
  assert.ok(run.indexOf("Project: not selected") < run.indexOf("Authorize copi to search only"));
});

for (const [name, project, labels] of [
  ["project outside HOME", (b: IntegrationBox) => b.cwd, { project: true, both: true }],
  ["project nested in HOME", (b: IntegrationBox) => path.join(b.home, "work"), { project: true, both: false }],
  ["project equal to HOME", (b: IntegrationBox) => b.home, { project: false, both: false }],
] as const) test(`setup location options: ${name}; Cancel (last option) searches and saves nothing`, async () => {
  const b = await integrationBox(); const cwd = project(b); await mkdir(cwd, { recursive: true });
  const downs = "\u001b[B".repeat(1 + Number(labels.project) + Number(labels.both));
  const run = plain((await interactive({ ...b, cwd }, "location-options", "setup", [at("Choose the locations copi may inspect", `${downs}\r`)])).output);
  assert.ok(run.includes("HOME and Pi agent directory \u2014 ~ (can take a minute or more)"));
  assert.equal(run.includes("This project only \u2014 "), labels.project);
  assert.equal(/\bBoth\b/.test(run), labels.both);
  assert.ok(run.includes("Cancel"));
  assert.ok(run.includes("Setup cancelled."));
  assert.ok(!run.includes("Authorize copi to search only") && !run.includes("Search scope and exclusions") && !run.includes("Search complete"));
  await assert.rejects(lstat(b.library), { code: "ENOENT" });
});

test("setup and group prompts show the Tab key hint and a search progress indicator", async () => {
  const b = await integrationBox();
  await sourceFiles(b);
  const setup = plain((await interactive(b, "key-hint-setup", "setup", setupSteps())).output);
  assert.ok(setup.includes("Choose the locations copi may inspect"));
  assert.ok(!setup.includes("Choose the locations copi may inspect (Tab"));
  for (const prompt of ["Select resources to review and save as copied snapshots"]) {
    assert.ok(setup.includes(`${prompt} (Tab: select, Enter: confirm)`), prompt);
  }
  // The spinner draws its first frame after 80 ms; this tiny fixture finishes sooner, so only the stop line is observable.
  assert.match(setup, /Search complete: \d+ supported resource\(s\) found/);
  const groups = plain((await interactive(b, "key-hint-groups", "manage", addGroupSteps("Hint bundle", 1))).output);
  assert.ok(groups.includes("Select resources in Hint bundle (Tab: select, Enter: confirm)"));
});
