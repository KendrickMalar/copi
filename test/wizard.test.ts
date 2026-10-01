import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchOptions, formatApplyOptionPreview, formatMaskedPreview, prepareCandidateForReview, saveReviewedCandidate } from "../src/wizard.ts";
import { readSnapshotFiles } from "../src/catalog.ts";
import { discoverResources } from "../src/discovery.ts";
import type { ResourceCandidate } from "../src/types.ts";

test("project-only setup scopes every discovery root to the explicitly selected project", () => {
  const options = buildSearchOptions(
    { homeDir: "/synthetic/private-home", agentDir: "/synthetic/private-agent", projectDir: "/synthetic/project" },
    { home: false, project: true },
  );
  assert.deepEqual(options, {
    homeDir: "/synthetic/private-home",
    agentDir: "/synthetic/private-agent",
    projectDir: "/synthetic/project",
    scopes: { home: false, project: true },
  });
});

test("explicit HOME scope searches HOME and its configured Pi agent directory, not the current project", () => {
  const options = buildSearchOptions(
    { homeDir: "/synthetic/home", agentDir: "/synthetic/custom-agent", projectDir: "/synthetic/project" },
    { home: true, project: false },
  );
  assert.deepEqual(options, {
    homeDir: "/synthetic/home",
    agentDir: "/synthetic/custom-agent",
    projectDir: "/synthetic/project",
    scopes: { home: true, project: false },
  });
});

test("setup with no authorized search scope performs no discovery", () => {
  assert.equal(
    buildSearchOptions(
      { homeDir: "/synthetic/private-home", agentDir: "/synthetic/private-agent", projectDir: "/synthetic/project" },
      { home: false, project: false },
    ),
    undefined,
  );
});

test("masked previews redact recognized credentials before displaying snapshot text", () => {
  const secret = "sk_live_1234567890abcdef";
  const preview = formatMaskedPreview("settings.json", `apiKey: ${secret}\nAuthorization: Bearer abcdefghijklmnop\n`);
  assert.match(preview, /settings\.json/);
  assert.match(preview, /REDACTED/);
  assert.ok(!preview.includes(secret));
  assert.ok(!preview.includes("abcdefghijklmnop"));
});

test("project-only wizard discovery ignores unrelated roots and generic settings.json", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "synthetic-home");
  const agentDir = path.join(root, "synthetic-agent");
  const projectDir = path.join(root, "synthetic-project");
  await Promise.all([mkdir(homeDir), mkdir(agentDir), mkdir(path.join(projectDir, ".pi"), { recursive: true })]);
  await writeFile(path.join(homeDir, "settings.json"), JSON.stringify({ skills: ["home-only-resource"] }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["agent-only-resource"] }));
  await writeFile(path.join(projectDir, "settings.json"), JSON.stringify({ skills: ["generic-project-settings"] }));
  await writeFile(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ skills: [] }));

  const options = buildSearchOptions({ homeDir, agentDir, projectDir }, { home: false, project: true });
  assert.ok(options);
  const discovery = await discoverResources(options);
  const piSettings = discovery.candidates.filter((candidate) => candidate.kind === "pi-settings");
  assert.equal(piSettings.length, 1);
  const setting = piSettings[0];
  assert.ok(setting);
  assert.ok(setting.sourcePath.endsWith(path.join(".pi", "settings.json")));
});

test("prepared preview excludes auth and env paths while preserving supported files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "skill");
  await mkdir(path.join(sourcePath, "auth"), { recursive: true });
  await mkdir(path.join(sourcePath, "nested", "Auth"), { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "# visible\\n");
  await writeFile(path.join(sourcePath, "auth", "token.json"), "AUTH_FILE_READ_SENTINEL\\n");
  await writeFile(path.join(sourcePath, "nested", "Auth", "token.json"), "NESTED_AUTH_READ_SENTINEL\\n");
  await writeFile(path.join(sourcePath, ".envrc"), "ENVRC_READ_SENTINEL\\n");
  await writeFile(path.join(sourcePath, "env_helper.py"), "env helper source code\\n");
  await writeFile(path.join(sourcePath, ".env-production"), "ENV_READ_SENTINEL\\n");
  const candidate: ResourceCandidate = {
    id: "synthetic-skill",
    kind: "skill",
    source: "synthetic-test",
    scope: "project",
    sourceRoot: root,
    sourcePath,
    name: "sample",
    destination: { kind: "project", path: ".pi/skills/sample" },
  };

  const review = await prepareCandidateForReview(candidate);
  const preview = review.preview.join("\\n");
  assert.ok(preview.includes("SKILL.md:"));
  assert.ok(preview.includes("# visible"));
  assert.ok(!preview.includes("AUTH_FILE_READ_SENTINEL"));
  assert.ok(!preview.includes("NESTED_AUTH_READ_SENTINEL"));
  assert.ok(!preview.includes("ENVRC_READ_SENTINEL"));
  assert.ok(preview.includes("env_helper.py:"));
  assert.ok(preview.includes("env helper source code"));
  assert.ok(!review.inspection.excludedPaths.includes("env_helper.py"));
  assert.ok(!preview.includes("ENV_READ_SENTINEL"));
  assert.ok(review.inspection.excludedPaths.includes("auth"));
  assert.ok(review.inspection.excludedPaths.includes("nested/Auth"));
  assert.ok(review.inspection.excludedPaths.includes(".envrc"));
  assert.ok(review.inspection.excludedPaths.includes(".env-production"));
  assert.ok(review.inspection.warnings.some((warning) => warning.code === "auth-directory-excluded"));
  const libraryDir = path.join(root, "synthetic-home", ".copi");
  const saved = await saveReviewedCandidate(libraryDir, review, [], [], true);
  assert.ok(saved);
  const savedPaths = saved.files.map((file) => file.path);
  assert.ok(savedPaths.includes("SKILL.md"));
  assert.ok(savedPaths.includes("env_helper.py"));
  assert.ok(!savedPaths.includes("auth/token.json"));
  assert.ok(!savedPaths.includes("nested/Auth/token.json"));
  assert.ok(!savedPaths.includes(".envrc"));
  assert.ok(!savedPaths.includes(".env-production"));
  const savedFiles = await readSnapshotFiles(libraryDir, saved);
  const envHelper = savedFiles.find((file) => file.path === "env_helper.py");
  assert.ok(envHelper?.bytes.includes(Buffer.from("env helper source code")));
});

test("saved bytes and mode remain bound to preparation when source changes before confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-prepared-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "synthetic-source", "skill");
  const sourceFile = path.join(sourcePath, "SKILL.md");
  const libraryDir = path.join(root, "synthetic-home", ".copi");
  await mkdir(sourcePath, { recursive: true });
  const preparedContent = Buffer.from("# reviewed bytes\\n");
  await writeFile(sourceFile, preparedContent);
  await chmod(sourceFile, 0o640);
  const preparedMode = (await lstat(sourceFile)).mode & 0o777;
  const candidate: ResourceCandidate = {
    id: "synthetic-skill",
    kind: "skill",
    source: "synthetic-test",
    scope: "project",
    sourceRoot: path.dirname(sourcePath),
    sourcePath,
    name: "sample",
    destination: { kind: "project", path: ".pi/skills/sample" },
  };

  const review = await prepareCandidateForReview(candidate);
  assert.equal(review.inspection.sensitivePaths.length, 0);
  const newSecret = "sk_live_newsecret1234567890";
  await writeFile(sourceFile, `apiKey: ${newSecret}\\n`);
  await chmod(sourceFile, 0o755);
  assert.equal(await saveReviewedCandidate(libraryDir, review, [], [], false), null);
  await assert.rejects(lstat(libraryDir), { code: "ENOENT" });

  const saved = await saveReviewedCandidate(libraryDir, review, [], [], true);
  assert.ok(saved);
  assert.equal(saved.files[0]?.mode, preparedMode);
  const snapshot = await readSnapshotFiles(libraryDir, saved);
  assert.deepEqual(snapshot[0]?.bytes, preparedContent);
  assert.ok(!snapshot[0]?.bytes.includes(Buffer.from(newSecret)));
});

test("file-specific secret approval applies to the same prepared bytes shown masked in preview", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-prepared-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "synthetic-source", "skill");
  const secretFile = path.join(sourcePath, "credentials.json");
  const libraryDir = path.join(root, "synthetic-home", ".copi");
  await mkdir(sourcePath, { recursive: true });
  const approvedSecret = "sk_live_approved1234567890";
  const newerSecret = "sk_live_unapproved1234567890";
  const approvedBytes = Buffer.from(`apiKey: ${approvedSecret}\\n`);
  await writeFile(secretFile, approvedBytes);
  const candidate: ResourceCandidate = {
    id: "synthetic-skill",
    kind: "skill",
    source: "synthetic-test",
    scope: "project",
    sourceRoot: path.dirname(sourcePath),
    sourcePath,
    name: "sample",
    destination: { kind: "project", path: ".pi/skills/sample" },
  };

  const review = await prepareCandidateForReview(candidate);
  assert.deepEqual(review.inspection.sensitivePaths, ["credentials.json"]);
  assert.ok(!review.preview.join("\\n").includes(approvedSecret));
  assert.ok(review.preview.join("\\n").includes("[REDACTED]"));
  await writeFile(secretFile, `apiKey: ${newerSecret}\\n`);

  const saved = await saveReviewedCandidate(libraryDir, review, [], ["credentials.json"], true);
  assert.ok(saved);
  const snapshot = await readSnapshotFiles(libraryDir, saved);
  assert.deepEqual(snapshot[0]?.bytes, approvedBytes);
  assert.ok(!snapshot[0]?.bytes.includes(Buffer.from(newerSecret)));
});

test("selected collision preview renders the chosen masked diff or binary summary", () => {
  const rawSecret = "sk_live_1234567890abcdef";
  const textPreview = formatApplyOptionPreview(".pi/agents/review.md", "chosen-resource", {
    itemId: "chosen-item",
    sensitive: true,
    preview: { kind: "text", diff: "-old\\n+apiKey: [REDACTED]" },
  });
  assert.ok(textPreview.includes("chosen-resource"));
  assert.ok(textPreview.includes(".pi/agents/review.md"));
  assert.ok(textPreview.includes("[REDACTED]"));
  assert.ok(!textPreview.includes(rawSecret));

  const binaryPreview = formatApplyOptionPreview("asset.bin", "binary-choice", {
    itemId: "binary-item",
    sensitive: false,
    preview: { kind: "binary", summary: "existing file 4 bytes; snapshot 6 bytes." },
  });
  assert.ok(binaryPreview.includes("binary-choice"));
  assert.ok(binaryPreview.includes("existing file 4 bytes; snapshot 6 bytes."));
});
