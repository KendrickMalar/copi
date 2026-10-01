import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchOptions, formatMaskedPreview, readPreview } from "../src/wizard.ts";
import type { ResourceCandidate } from "../src/types.ts";

test("project-only setup scopes every discovery root to the explicitly selected project", () => {
  const options = buildSearchOptions(
    { homeDir: "/synthetic/private-home", agentDir: "/synthetic/private-agent", projectDir: "/synthetic/project" },
    { home: false, project: true },
  );
  assert.deepEqual(options, {
    homeDir: "/synthetic/project",
    agentDir: "/synthetic/project",
    projectDir: "/synthetic/project",
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
    projectDir: "/synthetic/home",
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

test("default preview excludes auth directories without losing supported files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "skill");
  await mkdir(path.join(sourcePath, "auth"), { recursive: true });
  await mkdir(path.join(sourcePath, "nested", "Auth"), { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "# visible\n");
  await writeFile(path.join(sourcePath, "auth", "token.json"), "AUTH_FILE_READ_SENTINEL\n");
  await writeFile(path.join(sourcePath, "nested", "Auth", "token.json"), "NESTED_AUTH_READ_SENTINEL\n");
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

  const preview = (await readPreview(candidate)).join("\n");
  assert.match(preview, /SKILL\.md:[\s\S]*# visible/);
  assert.ok(!preview.includes("AUTH_FILE_READ_SENTINEL"));
  assert.ok(!preview.includes("NESTED_AUTH_READ_SENTINEL"));
});
