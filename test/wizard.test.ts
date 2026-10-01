import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchOptions, formatMaskedPreview } from "../src/wizard.ts";

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
