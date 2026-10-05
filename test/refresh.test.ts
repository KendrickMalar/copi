import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importPreparedResource, loadCatalog, prepareResource, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange, type ChangeApproval, type SavedChangeView } from "../src/resource-mutations.ts";
import type { Catalog, ResourceCandidate, SavedItem } from "../src/types.ts";
import { packageRefreshFixture, refreshCustody, refreshFixture } from "./helpers/refresh.ts";
import type { DiscoveryOptions } from "../src/discovery.ts";
import { storageTransactions, StorageTransactions } from "../src/storage-transaction.ts";

// Dynamic loading makes the initial RED an observable missing API assertion, not a compiler error.
interface Token { readonly reviewId: string }
interface RefreshApi {
  prepareRefresh(library: string, id: string, source: ResourceCandidate): Promise<Token>;
  readRefresh(token: Token): SavedChangeView & { originalCatalog: Catalog; source: ResourceCandidate };
  commitRefresh(token: Token, approval: ChangeApproval): Promise<SavedItem>;
  discoverRefreshOrigin(item: SavedItem, options: DiscoveryOptions): Promise<ResourceCandidate | undefined>;
}
async function api(): Promise<RefreshApi> {
  const module = await import("../src/" + "refresh.js").catch(() => undefined) as Record<string, unknown> | undefined;
  assert.equal(typeof module?.prepareRefresh, "function", "refresh preparation API is missing");
  return module as unknown as RefreshApi;
}
function approval(refresh: RefreshApi, token: Token) { return { reviewId: token.reviewId, confirmed: true, approvedSensitivePaths: refresh.readRefresh(token).sensitivePaths }; }

for (const kind of ["instruction", "skill"] as const) {
  test(`R1/R3 ${kind} replaces independently edited copy with fixed bytes, retaining all identity and memberships`, async t => {
    const refresh = await api(), box = await refreshFixture(t, kind);
    const edit = await prepareSavedEdit(box.libraryDir, box.item.id, path.basename(box.file));
    const change = await prepareSavedChange(edit, Buffer.from("copi-only edits\n"));
    await commitSavedChange(change, { reviewId: change.reviewId, confirmed: true, approvedSensitivePaths: readSavedChange(change).sensitivePaths });
    const before = await loadCatalog(box.libraryDir), expected = Buffer.from("\ufeffreplacement e\u0301\r\n日本語\r\n");
    await writeFile(box.sourceFile, expected);
    const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate);
    const view = refresh.readRefresh(token);
    assert.match(view.diffs[0]!.diff, /-copi-only edits/); assert.match(view.diffs[0]!.diff, /replacement/);
    view.originalCatalog.items[0]!.name = "caller mutation"; view.source.name = "caller source mutation";
    await writeFile(box.sourceFile, "source changed after review\n");
    const saved = await refresh.commitRefresh(token, approval(refresh, token));
    const files = await readSnapshotFiles(box.libraryDir, saved);
    assert.deepEqual(files[0]!.bytes, expected);
    assert.equal(saved.files[0]!.sha256, createHash("sha256").update(expected).digest("hex"));
    assert.deepEqual({ ...saved, files: [] }, { ...box.item, files: [] });
    assert.deepEqual((await loadCatalog(box.libraryDir)).groups, before.groups);
    assert.equal(await readFile(box.sourceFile, "utf8"), "source changed after review\n");
    await assert.rejects(refresh.commitRefresh(token, approval(refresh, token)), /already|committed/i);
    console.log(`R1 ${kind} before=${Buffer.from("copi-only edits\n").toString("hex")} after=${expected.toString("hex")} hash=${saved.files[0]!.sha256}`);
  });
}

test("R1/R5 bundle adds/removes asset files, mode-only changes, source exclusions and separated masked hunks", async t => {
  const refresh = await api(), lines = Array.from({ length: 120 }, (_, i) => `line ${i}\n`).join(""), box = await refreshFixture(t, "skill", lines);
  await writeFile(path.join(box.item.sourcePath, "obsolete.txt"), "obsolete\n");
  let token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate);
  await refresh.commitRefresh(token, approval(refresh, token));
  await rm(path.join(box.item.sourcePath, "obsolete.txt"));
  await mkdir(path.join(box.item.sourcePath, "assets"));
  await writeFile(path.join(box.item.sourcePath, "assets", "raw.bin"), Buffer.from([0, 1, 255]));
  for (const excluded of ["auth", "cache", ".env.local"]) {
    await mkdir(path.join(box.item.sourcePath, excluded));
    await writeFile(path.join(box.item.sourcePath, excluded, "private"), "apiKey=sk_live_excludedsecret123456\n");
  }
  await writeFile(box.sourceFile, lines.replace("line 0\n", "FIRST\n").replace("line 60\n", "MIDDLE\n").replace("line 119\n", "LAST\n"));
  await chmod(box.sourceFile, 0o755);
  token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate);
  const view = refresh.readRefresh(token), diff = view.diffs.find(entry => entry.path === "SKILL.md")!;
  for (const line of ["+FIRST", "+MIDDLE", "+LAST"]) assert.ok(diff.diff.includes(line));
  assert.equal((diff.diff.match(/@@ /g) ?? []).length, 3);
  assert.match(diff.summary, /755/); assert.match(view.diffs.find(entry => entry.path === "obsolete.txt")!.summary, /absent/);
  assert.match(view.diffs.find(entry => entry.path === "assets\/raw.bin")!.summary, /0 → 3 bytes/);
  assert.deepEqual(view.excludedPaths, [".env.local", "auth", "cache"]); assert.deepEqual(view.sensitivePaths, []);
  assert.ok(view.warnings.some(w => w.code === "auth-directory-excluded"));
  const saved = await refresh.commitRefresh(token, approval(refresh, token));
  assert.deepEqual(saved.files.map(file => file.path), ["assets/raw.bin", "SKILL.md"]);
  assert.equal(saved.files.find(file => file.path === "SKILL.md")!.mode, 0o755);
  await assert.rejects(lstat(path.join(path.dirname(box.file), "obsolete.txt")), { code: "ENOENT" });
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, saved)).find(file => file.path === "assets/raw.bin")!.bytes, Buffer.from([0, 1, 255]));
});

test("R1/R2 metadata-only reselection and mode-only changes are committed without byte-change shortcut", async t => {
  const refresh = await api(), box = await refreshFixture(t);
  const sourcePath = path.join(box.sourceRoot, "replacement"); await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, "SKILL.md"), await readFile(box.sourceFile));
  const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, { ...box.candidate, name: "Do not adopt", sourcePath, scope: "shared", source: "explicit-refresh-path", destination: { kind: "project", path: "not-adopted" } });
  assert.equal(refresh.readRefresh(token).bytesChanged, false);
  let saved = await refresh.commitRefresh(token, approval(refresh, token));
  assert.equal(saved.source, "explicit-refresh-path"); assert.equal(saved.scope, "shared"); assert.equal(saved.sourcePath, await realpath(sourcePath));
  assert.equal(saved.name, box.item.name); assert.deepEqual(saved.destination, box.item.destination);
  await chmod(path.join(sourcePath, "SKILL.md"), 0o755);
  const mode = await refresh.prepareRefresh(box.libraryDir, box.item.id, { ...box.candidate, sourcePath });
  assert.equal(refresh.readRefresh(mode).bytesChanged, false);
  saved = await refresh.commitRefresh(mode, approval(refresh, mode)); assert.equal(saved.files[0]!.mode, 0o755);
});

test("R2 absent origin allows explicitly selected same-kind source and old copy remains readable", async t => {
  const refresh = await api(), box = await refreshFixture(t);
  await rename(box.item.sourcePath, path.join(box.sourceRoot, "moved"));
  assert.equal((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes.toString(), "source original\r\n日本語\n");
  await assert.rejects(refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate), /ENOENT|unavailable|missing/i);
  const sourcePath = path.join(box.sourceRoot, "moved");
  const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, { ...box.candidate, sourcePath });
  await refresh.commitRefresh(token, approval(refresh, token));
});

test("R5 two concrete secret approvals and real reviewId are mandatory; identical masking still reports bytes", async t => {
  const refresh = await api(), box = await refreshFixture(t, "skill", "apiKey=sk_live_oldsecret123456\n"), before = await refreshCustody(box);
  await writeFile(box.sourceFile, "apiKey=sk_live_newsecret123456\n");
  await writeFile(path.join(box.item.sourcePath, "second.json"), "password=syntheticpassword12345\n");
  const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate), view = refresh.readRefresh(token);
  assert.deepEqual(view.sensitivePaths, ["second.json", "SKILL.md"]); assert.equal(view.bytesChanged, true);
  assert.ok(!JSON.stringify(view.diffs).includes("sk_live_"));
  for (const approvedSensitivePaths of [[], ["SKILL.md"], ["second.json"], ["SKILL.md", "SKILL.md"], ["second.json", "SKILL.md", "invented"]]) {
    await assert.rejects(refresh.commitRefresh(token, { ...approval(refresh, token), approvedSensitivePaths }), /approval/i);
  }
  await assert.rejects(refresh.commitRefresh(token, { ...approval(refresh, token), reviewId: "wrong" }), /review/i);
  await assert.rejects(refresh.commitRefresh(token, { ...approval(refresh, token), confirmed: "yes" as unknown as boolean }), /confirm/i);
  await assert.rejects(refresh.commitRefresh({ reviewId: token.reviewId }, approval(refresh, token)), /token|prepared/i);
  assert.deepEqual(await readFile(box.file), before.file); assert.deepEqual(await readFile(path.join(box.libraryDir, "catalog.json")), before.catalog);
  await refresh.commitRefresh(token, approval(refresh, token));
});

for (const mutation of ["catalog", "body", "group", "destination", "source metadata"] as const) {
  test(`R6 prepared refresh rejects concurrent ${mutation} change and preserves external state`, async t => {
    const refresh = await api(), box = await refreshFixture(t);
    await writeFile(box.sourceFile, "pending replacement\n");
    const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate);
    if (mutation === "body") await writeFile(box.file, "external body\n");
    else if (mutation === "catalog") await writeFile(path.join(box.libraryDir, "catalog.json"), ` ${await readFile(path.join(box.libraryDir, "catalog.json"), "utf8")}`);
    else { const catalog = await loadCatalog(box.libraryDir);
      if (mutation === "group") catalog.groups[0]!.name = "External group";
      else if (mutation === "destination") catalog.items[0]!.destination = { kind: "global-only" };
      else catalog.items[0]!.source = "external source";
      await saveCatalog(box.libraryDir, catalog);
    }
    const before = await refreshCustody(box);
    await assert.rejects(refresh.commitRefresh(token, approval(refresh, token)), /changed|checksum|revision/i);
    assert.deepEqual(await refreshCustody(box), before);
  });
}

test("R1/R5 registered npm origin must pass live declared-package discovery; manual cloned package metadata cannot grant authority", async t => {
  const refresh = await api(), box = await packageRefreshFixture(t);
  await writeFile(box.sourceFile, "declared replacement\n");
  await assert.rejects(refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate), /excluded|declared|package/i);
  const source = await refresh.discoverRefreshOrigin(box.item, box.options); assert.ok(source);
  await assert.rejects(refresh.prepareRefresh(box.libraryDir, box.item.id, structuredClone(source)), /excluded/i);
  const token = await refresh.prepareRefresh(box.libraryDir, box.item.id, source);
  await refresh.commitRefresh(token, approval(refresh, token));
  assert.equal(await readFile(box.file, "utf8"), "declared replacement\n"); assert.equal(await readFile(box.sourceFile, "utf8"), "declared replacement\n");
  await writeFile(path.join(box.agentDir, "settings.json"), "{}");
  assert.equal(await refresh.discoverRefreshOrigin(box.item, box.options), undefined);
  const before = await refreshCustody(box);
  await assert.rejects(refresh.discoverRefreshOrigin(box.item, { ...box.options, scopes: { home: false, project: false } }), /scope/i);
  assert.deepEqual(await refreshCustody(box), before);
});

for (const checkpoint of ["stage-write", "old-renamed", "before-catalog", "catalog-renamed"] as const) {
  test(`R6 real refresh kernel failure at ${checkpoint} restores exact old bytes/catalog with checked reader`, async t => {
    const refresh = await api(), box = await refreshFixture(t); await writeFile(box.sourceFile, "proposed replacement\n");
    const before = await refreshCustody(box), token = await refresh.prepareRefresh(box.libraryDir, box.item.id, box.candidate);
    let reached = false;
    const kernel = new StorageTransactions({ checkpoint(point) { if (point === checkpoint) { reached = true; throw new Error(`Refresh injected ${checkpoint}`); } } });
    // Real instance-scoped kernel injection, no mock saver or altered approval validation.
    const injected = t.mock.method(storageTransactions, "run", kernel.run.bind(kernel));
    await assert.rejects(refresh.commitRefresh(token, approval(refresh, token)), /Refresh injected/); injected.mock.restore();
    assert.ok(reached); assert.deepEqual(await refreshCustody(box), before);
    assert.deepEqual((await readSnapshotFiles(box.libraryDir, box.item))[0]!.bytes, before.file);
    await assert.rejects(lstat(path.join(box.libraryDir, ".copi-transaction")), { code: "ENOENT" });
    console.log(`R6 refresh ${checkpoint}: reached=true exact old custody restored`);
  });
}

for (const error of ["wrong kind", "wrong shape", "outside boundary", "source link", "ancestor link", "interior link", "saved link", "private ancestor", "node_modules", "checksum", "unknown physical file"] as const) {
  test(`R5/R6 ${error} stops refresh without source/copy writes`, async t => {
    const refresh = await api(), box = await refreshFixture(t), candidate = structuredClone(box.candidate);
    if (error === "wrong kind") candidate.kind = "instruction";
    if (error === "wrong shape") candidate.sourcePath = box.sourceFile;
    if (error === "outside boundary") candidate.sourceRoot = box.projectDir;
    if (error === "source link") { candidate.sourcePath = path.join(box.sourceRoot, "link"); await symlink(box.item.sourcePath, candidate.sourcePath); }
    if (error === "ancestor link") { await symlink(box.sourceRoot, path.join(box.root, "linked")); candidate.sourceRoot = path.join(box.root, "linked"); candidate.sourcePath = path.join(candidate.sourceRoot, "bundle"); }
    if (error === "private ancestor" || error === "node_modules") {
      const parent = path.join(box.sourceRoot, error === "node_modules" ? "node_modules" : "auth"), sourcePath = path.join(parent, "bundle");
      await mkdir(sourcePath, { recursive: true }); await writeFile(path.join(sourcePath, "SKILL.md"), "do not read\n");
      candidate.sourceRoot = parent; candidate.sourcePath = sourcePath; candidate.source = "package:npm:forged"; candidate.scope = "package";
    }
    if (error === "interior link") await symlink(box.sourceFile, path.join(box.item.sourcePath, "linked.md"));
    if (error === "saved link") {await rename(box.file, `${box.file}.old`); await symlink(box.sourceFile, box.file);}
    if (error === "checksum") await writeFile(box.file, "corrupted\n");
    if (error === "unknown physical file") await writeFile(path.join(path.dirname(box.file), "unknown.md"), "do not remove\n");
    const before = await refreshCustody(box);
    await assert.rejects(refresh.prepareRefresh(box.libraryDir, box.item.id, candidate));
    assert.deepEqual(await refreshCustody(box), before);
    if (error === "unknown physical file") assert.equal(await readFile(path.join(path.dirname(box.file), "unknown.md"), "utf8"), "do not remove\n");
  });
}

// Regression target: a genuine mutable discovery result must not move its
// declared-package authority to a different capture via serialization/accessors.
// Retain these new fixtures/evidence; existing helpers' own t.after remains unchanged.
async function originTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (target: string, relative: string): Promise<void> => {
    const stat = await lstat(target), mode = (stat.mode & 0o777).toString(8);
    if (stat.isSymbolicLink()) entries[relative] = `link:${await readlink(target)};mode:${mode}`;
    else if (stat.isDirectory()) {
      entries[relative] = `directory:${mode}`;
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), path.posix.join(relative, name));
    } else entries[relative] = `file:${mode};hex:${(await readFile(target)).toString("hex")}`;
  };
  await visit(root, ".");
  return entries;
}
async function originFixture() {
  const assigned = await realpath(process.env.TMPDIR!);
  assert.ok(assigned === "/private/tmp/copi-issue1-coder4.G6vORm/tmp" ||
    assigned === "/private/tmp/copi-issue1-tester4.G7sT9W/tmp", "Origin fixtures require an exactly approved canonical TMPDIR.");
  const root = await realpath(await mkdtemp(path.join(assigned, "copi-origin-fix1-")));
  const homeDir = path.join(root, "home"), agentDir = path.join(homeDir, ".pi/agent"), projectDir = path.join(root, "project");
  const packageRoot = path.join(agentDir, "npm/node_modules/declared-origin"), sourcePath = path.join(packageRoot, "skills/declared");
  const outsideRoot = path.join(root, "not-in-approved-home-or-project"), forbidden = path.join(outsideRoot, "node_modules/undeclared/skill");
  await Promise.all([mkdir(sourcePath, { recursive: true }), mkdir(projectDir), mkdir(forbidden, { recursive: true })]);
  const sourceFile = path.join(sourcePath, "SKILL.md");
  await writeFile(sourceFile, "declared original\n", { mode: 0o644 });
  await writeFile(path.join(forbidden, "SKILL.md"), "UNDECLARED outside approved roots bytes\n", { mode: 0o751 });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "declared-origin", pi: { skills: ["skills/declared"] } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:declared-origin"] }));
  const candidate: ResourceCandidate = { id: "origin-fixture", kind: "skill", source: "package:npm:declared-origin", scope: "package", sourceRoot: packageRoot, sourcePath, name: "Retained name", destination: { kind: "project", path: ".pi/skills/retained" } };
  const prepared = await prepareResource(candidate), inspection = await inspectPreparedResource(prepared), libraryDir = path.join(homeDir, ".copi");
  const item = await importPreparedResource(libraryDir, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths }); assert.ok(item);
  const options: DiscoveryOptions = { homeDir, agentDir, projectDir, scopes: { home: true, project: false } };
  const refresh = await api(), origin = await refresh.discoverRefreshOrigin(item, options); assert.ok(origin);
  const file = path.join(libraryDir, "items", item.id, "files/SKILL.md");
  const custody = async () => ({ library: await originTree(libraryDir), approvedSource: await originTree(agentDir), outside: await originTree(outsideRoot), project: await originTree(projectDir) });
  console.log(`origin retained fixture=${root}`);
  return { root, libraryDir, item, origin, refresh, file, sourceFile, agentDir, outsideRoot, forbidden, options, custody };
}
async function originEvidence(box: Awaited<ReturnType<typeof originFixture>>, label: string, details: unknown) {
  const bytes = Buffer.from(JSON.stringify(details, null, 2));
  const filename = path.join(box.root, `${label}.json`); await writeFile(filename, bytes);
  console.log(`origin evidence=${filename} bytes=${bytes.length} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
}

for (const attack of ["prototype-toJSON", "nonenumerable-own-toJSON"] as const) {
  test(`origin-fix1 R5 ${attack} refuses actual prepare/commit of outside undeclared bytes`, async () => {
    const box = await originFixture(), initial = structuredClone(box.origin), before = await box.custody();
    const forged = { ...initial, sourcePath: box.forbidden, sourceRoot: path.dirname(box.forbidden) };
    await assert.rejects(box.refresh.prepareRefresh(box.libraryDir, box.item.id, forged), /private|excluded/i);
    assert.deepEqual(await box.custody(), before, "plain forged control must preserve all FS");
    if (attack === "prototype-toJSON") Object.setPrototypeOf(box.origin, { toJSON: () => initial });
    else Object.defineProperty(box.origin, "toJSON", { enumerable: false, value: () => initial });
    Object.assign(box.origin, { sourcePath: box.forbidden, sourceRoot: path.dirname(box.forbidden) });
    let outcome = "rejected", error = "";
    try {
      const token = await box.refresh.prepareRefresh(box.libraryDir, box.item.id, box.origin);
      await box.refresh.commitRefresh(token, approval(box.refresh, token));
      outcome = "COMMITTED outside undeclared bytes";
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const after = await box.custody();
    await originEvidence(box, attack, { outcome, error, initial, forbidden: box.forbidden, before, after, savedHex: (await readFile(box.file)).toString("hex") });
    assert.deepEqual(after.approvedSource, before.approvedSource);
    assert.deepEqual(after.outside, before.outside);
    assert.deepEqual(after.project, before.project);
    assert.equal(outcome, "rejected", "declared authority must not authorize mutated/serialized outside source");
    assert.deepEqual(after.library, before.library);
  });
}

for (const attack of ["clone", "manual-label", "mutation", "proxy", "prototype-derived", "custom-prototype", "accessor-switch", "accessor-same", "nonenumerable-field", "extra-symbol", "nested-mutation", "nested-prototype", "nested-toJSON", "nested-accessor", "nested-proxy"] as const) {
  test(`origin-fix1 R5 ${attack} rejects at prepare with full FS custody`, async () => {
    const box = await originFixture(), initial = structuredClone(box.origin);
    await writeFile(box.sourceFile, "current declared replacement\n");
    let source = box.origin, invoked = 0;
    const outside = { sourcePath: box.forbidden, sourceRoot: path.dirname(box.forbidden) };
    if (attack === "clone") source = Object.assign(structuredClone(initial), outside);
    if (attack === "manual-label") source = { ...initial, ...outside };
    if (attack === "mutation") Object.assign(source, outside);
    if (attack === "proxy") source = new Proxy(source, { get(target, key, receiver) { invoked++; return Reflect.get(target, key, receiver); } });
    if (attack === "prototype-derived") source = Object.create(source) as ResourceCandidate;
    if (attack === "custom-prototype") Object.setPrototypeOf(source, { marker: "different prototype" });
    if (attack === "accessor-switch" || attack === "accessor-same") {
      Object.defineProperty(source, "sourcePath", { enumerable: true, get: () => { invoked++; return attack === "accessor-switch" && invoked > 1 ? box.forbidden : initial.sourcePath; } });
    }
    if (attack === "nonenumerable-field") Object.defineProperty(source, "sourcePath", { enumerable: false, value: initial.sourcePath });
    if (attack === "extra-symbol") Object.defineProperty(source, Symbol("hidden"), { value: initial });
    if (attack === "nested-mutation" && source.destination.kind === "project") source.destination.path = ".pi/skills/unreviewed";
    if (attack === "nested-prototype") Object.setPrototypeOf(source.destination, { marker: "nested prototype" });
    if (attack === "nested-toJSON") Object.defineProperty(source.destination, "toJSON", { enumerable: false, value: () => initial.destination });
    if (attack === "nested-accessor") Object.defineProperty(source.destination, "path", { enumerable: true, get: () => { invoked++; return ".pi/skills/unreviewed"; } });
    if (attack === "nested-proxy") source.destination = new Proxy(source.destination, { get(target, key, receiver) { invoked++; return Reflect.get(target, key, receiver); } });
    const before = await box.custody();
    let outcome = "rejected", error = "";
    try { await box.refresh.prepareRefresh(box.libraryDir, box.item.id, source); outcome = "PREPARED tampered origin"; }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const after = await box.custody(); await originEvidence(box, attack, { outcome, error, invoked, before, after });
    assert.equal(outcome, "rejected", "altered origin must reject, not silently prepare the internal original");
    assert.deepEqual(after, before);
    assert.equal(invoked, 0, "authority capture must not invoke caller accessors or proxy traps");
  });
}

test("origin-fix1 R5 genuine declared source binds invocation capture and fixed secret bytes", async () => {
  const box = await originFixture(), expected = Buffer.from("apiKey=sk_live_originFIXED123456789\n");
  await writeFile(box.sourceFile, expected); await chmod(box.sourceFile, 0o751);
  const before = await loadCatalog(box.libraryDir), initial = structuredClone(box.origin);
  // Invocation synchronously captures before any lock/read await. Later caller
  // mutations must not redirect the same prepare; its source bytes then freeze.
  const pending = box.refresh.prepareRefresh(box.libraryDir, box.item.id, box.origin);
  Object.assign(box.origin, { sourcePath: box.forbidden, sourceRoot: path.dirname(box.forbidden) });
  box.origin.destination = { kind: "global-only" };
  const token = await pending, view = box.refresh.readRefresh(token);
  assert.deepEqual(view.source, initial);
  assert.deepEqual(view.sensitivePaths, ["SKILL.md"]);
  assert.ok(!JSON.stringify(view.diffs).includes("sk_live_"));
  const unchanged = await box.custody();
  await assert.rejects(box.refresh.commitRefresh(token, { reviewId: token.reviewId, confirmed: true, approvedSensitivePaths: [] }), /approval/i);
  assert.deepEqual(await box.custody(), unchanged);
  await writeFile(box.sourceFile, "later unapproved original bytes\n");
  const originals = await box.custody();
  const saved = await box.refresh.commitRefresh(token, approval(box.refresh, token));
  const after = await box.custody();
  assert.deepEqual(after.approvedSource, originals.approvedSource); assert.deepEqual(after.outside, originals.outside); assert.deepEqual(after.project, originals.project);
  assert.deepEqual(await readFile(box.file), expected);
  assert.deepEqual((await readSnapshotFiles(box.libraryDir, saved))[0]!.bytes, expected);
  assert.equal(saved.files[0]!.sha256, createHash("sha256").update(expected).digest("hex"));
  assert.equal(saved.files[0]!.mode, 0o751); assert.equal((await lstat(box.file)).mode & 0o777, 0o600);
  assert.deepEqual({ ...saved, files: [] }, { ...box.item, files: [] });
  assert.deepEqual((await loadCatalog(box.libraryDir)).groups, before.groups);
  await assert.rejects(box.refresh.commitRefresh(token, approval(box.refresh, token)), /already/i);
  await originEvidence(box, "genuine-positive", { before, after, fixedHex: expected.toString("hex"), descriptorMode: saved.files[0]!.mode, physicalMode: (await lstat(box.file)).mode & 0o777 });
});
