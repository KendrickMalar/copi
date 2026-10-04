import path from "node:path";
import { prepareResource, readPreparedResource, type PreparedResource, type PreparedInspection, type PreparedResourceContents } from "./catalog.ts";
import type { InspectionResult, InspectionWarning, ResourceCandidate } from "./types.ts";

const inspections = new WeakSet<PreparedInspection>();

const maxInspectionBytes = 1_000_000;
const relativePathReference = /(?:^|[\s"'`])(?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:$|[\s"'`),;!?])/m;

function addWarning(warnings: InspectionWarning[], code: string, message: string, relativePath?: string): void {
  const warning = relativePath === undefined ? { code, message } : { code, message, path: relativePath };
  if (!warnings.some((item) => item.code === code && item.path === relativePath)) warnings.push(warning);
}

function containsInlineSecret(text: string): boolean {
  const namedValue = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?(?!\s*(?:\$|!|<|placeholder|example|changeme|your[_-]))[A-Za-z0-9_./+=:-]{8,}/i;
  const recognizableToken = /\b(?:sk_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/;
  const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
  return namedValue.test(text) || recognizableToken.test(text) || bearer.test(text);
}

export function inspectFixedResource({ candidate, files, excludedPaths }: PreparedResourceContents): InspectionResult {
  const warnings: InspectionWarning[] = [];
  const sensitivePaths: string[] = [];
  addWarning(warnings, "secret-detection-limited", "Secret detection is heuristic and cannot guarantee completeness.");
  for (const relativePath of excludedPaths) {
    if (relativePath.split("/").some((part) => part.toLowerCase() === "auth")) {
      addWarning(warnings, "auth-directory-excluded", "An auth path was excluded; copied resources may be missing authentication-specific code.", relativePath);
    }
  }
  for (const file of files) {
    if (file.bytes.length > maxInspectionBytes) {
      addWarning(warnings, "large-file-skipped", "Content inspection is limited to files no larger than 1 MB.", file.path);
      continue;
    }
    if (file.bytes.includes(0)) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      continue;
    }
    if (containsInlineSecret(text)) {
      sensitivePaths.push(file.path);
      addWarning(warnings, "sensitive-content", "This file may contain a secret; detection is heuristic and cannot guarantee completeness.", file.path);
    }
    if (/\$\{?[A-Z_][A-Z0-9_]*\}?/.test(text)) addWarning(warnings, "environment-reference", "This resource refers to environment variables that may need to be configured separately.", file.path);
    if (/(?:\/Users\/|\/home\/|[A-Za-z]:\\\\|~\/)[^\s"']+/.test(text)) addWarning(warnings, "absolute-path", "This resource contains a path that may not exist in another project.", file.path);
    if (relativePathReference.test(text)) addWarning(warnings, "relative-path-portability", "This resource contains relative paths that may resolve differently after it is copied to another project.", file.path);
    if (candidate.kind === "pi-settings" && ["defaultProjectTrust", "httpProxy", "cacheWarming"].some((key) => text.includes(`\"${key}\"`))) {
      addWarning(warnings, "project-setting-restricted", "This Pi setting is user-only and may not work in a project; copi preserves its bytes without rewriting it.", file.path);
    }
    if (path.basename(file.path) === "package.json") {
      try {
        const manifest = JSON.parse(text) as Record<string, unknown>;
        const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some((value) => typeof value === "object" && value !== null && Object.keys(value).length > 0);
        if (dependencies) addWarning(warnings, "dependency-requirement", "This resource declares dependencies; copi does not install them automatically.", file.path);
      } catch {
        addWarning(warnings, "invalid-package-manifest", "This package manifest could not be parsed for dependency warnings.", file.path);
      }
    }
  }
  if (candidate.destination.kind === "global-only") addWarning(warnings, "global-only", "This resource is saved for reference and cannot be applied to a project.");
  return { warnings, sensitivePaths: [...new Set(sensitivePaths)].sort((left, right) => left.localeCompare(right)), excludedPaths: [...new Set(excludedPaths)].sort((left, right) => left.localeCompare(right)) };
}

export async function inspectPreparedResource(prepared: PreparedResource): Promise<PreparedInspection> {
  const result = inspectFixedResource(readPreparedResource(prepared));
  const inspection: PreparedInspection = Object.freeze({
    warnings: Object.freeze(result.warnings.map((warning) => Object.freeze({ ...warning }))),
    sensitivePaths: Object.freeze(result.sensitivePaths),
    excludedPaths: Object.freeze(result.excludedPaths),
    preparedResource: prepared,
  });
  inspections.add(inspection);
  return inspection;
}

export function assertPreparedInspection(inspection: PreparedInspection, prepared: PreparedResource): void {
  if (!inspections.has(inspection) || inspection.preparedResource !== prepared) throw new Error("Inspection does not match the prepared resource or is not an authentic inspection.");
}

export async function inspectResource(candidate: ResourceCandidate): Promise<InspectionResult> {
  const prepared = await prepareResource(candidate);
  const inspection = await inspectPreparedResource(prepared);
  return {
    warnings: [...inspection.warnings],
    sensitivePaths: [...inspection.sensitivePaths],
    excludedPaths: [...inspection.excludedPaths],
  };
}

export function maskSensitiveText(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?)(?!\$\{?[A-Z_][A-Z0-9_]*\}?)([^"'\s,}]{8,})/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]");
}
