import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectResource, maskSensitiveText } from "../src/inspect.ts";
import type { ResourceCandidate } from "../src/types.ts";

function candidate(sourceRoot: string, sourcePath: string): ResourceCandidate {
  return {
    id: "inspection-candidate",
    kind: "skill",
    source: "test",
    scope: "shared",
    sourceRoot,
    sourcePath,
    name: "review-tool",
    destination: { kind: "project", path: ".pi/skills/review-tool" },
  };
}

test("flags inline credential candidates, distinguishes environment references, warns on absolute paths, and excludes private files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "review-tool");
  await mkdir(path.join(sourcePath, "history"), { recursive: true });
  await mkdir(path.join(sourcePath, "references"), { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "Use $DOCS_TOKEN; local config is /Users/example/private/settings.json");
  await writeFile(path.join(sourcePath, "references", "config.json"), JSON.stringify({ apiKey: "sk_live_1234567890abcdef" }));
  await writeFile(path.join(sourcePath, ".env.local"), "TOKEN=sk_live_another_secret");
  await writeFile(path.join(sourcePath, "auth.json"), JSON.stringify({ token: "private" }));
  await writeFile(path.join(sourcePath, "history", "session.jsonl"), "private history");
  await mkdir(path.join(sourcePath, "auth", "scripts"), { recursive: true });
  await writeFile(path.join(sourcePath, "auth", "scripts", "authenticate.ts"), "export const auth = true;");
  await mkdir(path.join(sourcePath, ".cache"), { recursive: true });
  await mkdir(path.join(sourcePath, ".npm"), { recursive: true });
  await writeFile(path.join(sourcePath, ".cache", "private.txt"), "cached content");
  await writeFile(path.join(sourcePath, ".npm", "private.txt"), "package cache content");

  const inspection = await inspectResource(candidate(sourceRoot, sourcePath));
  assert.ok(inspection.sensitivePaths.includes("references/config.json"));
  assert.ok(inspection.warnings.some((warning) => warning.code === "environment-reference"));
  assert.ok(inspection.warnings.some((warning) => warning.code === "absolute-path"));
  assert.ok(inspection.warnings.some((warning) => warning.code === "secret-detection-limited"));
  assert.ok(!inspection.sensitivePaths.includes("SKILL.md"));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith(".env.local")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith("auth.json")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.endsWith(path.join("auth"))));
  assert.ok(inspection.warnings.some((warning) => warning.code === "auth-directory-excluded"));
  assert.ok(inspection.excludedPaths.some((entry) => entry.includes("history")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.includes(".cache")));
  assert.ok(inspection.excludedPaths.some((entry) => entry.includes(".npm")));
  assert.ok(!JSON.stringify(inspection).includes("sk_live_1234567890abcdef"));
});

test("masks inline credentials for default display while preserving environment-variable references", () => {
  const source = '{"apiKey":"sk_live_1234567890abcdef","authorization":"Bearer abcdefghijklmnop","other":"$DOCS_TOKEN"}';
  const masked = maskSensitiveText(source);
  assert.ok(!masked.includes("sk_live_1234567890abcdef"));
  assert.ok(!masked.includes("abcdefghijklmnop"));
  assert.ok(masked.includes("$DOCS_TOKEN"));
  assert.ok(masked.includes("[REDACTED]"));
});

test("inspects bundled binary files without decoding them as text and warns about declared dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-inspect-binary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const sourcePath = path.join(sourceRoot, "binary-skill");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "Binary assets are part of this skill.");
  await writeFile(path.join(sourcePath, "payload.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0x80]));
  await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ dependencies: { "manual-dependency": "1.0.0" } }));

  const inspection = await inspectResource(candidate(sourceRoot, sourcePath));
  assert.ok(inspection.warnings.some((warning) => warning.code === "dependency-requirement"));
  assert.deepEqual(inspection.sensitivePaths, []);
});
