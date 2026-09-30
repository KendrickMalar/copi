import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { InspectionResult, InspectionWarning, ResourceCandidate } from "./types.ts";

const excludedNames = new Set([".git", ".cache", ".npm", "node_modules", "cache", "caches", "history", "sessions"]);
const maxInspectionBytes = 1_000_000;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isExcluded(relative: string): boolean {
  return relative.split(path.sep).some((part) => {
    const lower = part.toLowerCase();
    return excludedNames.has(lower) || lower === "auth.json" || lower === "mcp-auth.json" || lower === "oauth.json" || lower === ".env" || lower.startsWith(".env.");
  });
}

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

async function inspectFiles(candidate: ResourceCandidate): Promise<{ files: Array<{ relative: string; text?: string }>; excluded: string[]; warnings: InspectionWarning[] }> {
  const files: Array<{ relative: string; text?: string }> = [];
  const excluded: string[] = [];
  const warnings: InspectionWarning[] = [];
  const rootInput = path.resolve(candidate.sourceRoot);
  const sourceInput = path.resolve(candidate.sourcePath);
  if (!isWithin(rootInput, sourceInput)) {
    addWarning(warnings, "resource-outside-root", "The resource is outside its declared search root.");
    return { files, excluded, warnings };
  }
  const canonicalRoot = await realpath(rootInput).catch(() => undefined);
  const canonicalSource = await realpath(sourceInput).catch(() => undefined);
  if (!canonicalRoot || !canonicalSource || !isWithin(canonicalRoot, canonicalSource)) {
    addWarning(warnings, "resource-outside-root", "The resource could not be resolved inside its declared search root.");
    return { files, excluded, warnings };
  }
  const sourceStat = await lstat(sourceInput).catch(() => undefined);
  if (!sourceStat || sourceStat.isSymbolicLink()) {
    addWarning(warnings, "symlink-skipped", "The resource is unavailable or is a symbolic link.");
    return { files, excluded, warnings };
  }
  const sourceIsDirectory = sourceStat.isDirectory();
  const visit = async (target: string): Promise<void> => {
    const relativeToSource = sourceIsDirectory ? path.relative(sourceInput, target) : path.basename(target);
    if (isExcluded(relativeToSource)) {
      excluded.push(relativeToSource);
      return;
    }
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      addWarning(warnings, error.code === "EACCES" ? "permission-denied" : "read-error", error.code === "EACCES" ? "Permission denied while inspecting this resource." : "Unable to inspect this resource.", relativeToSource);
      return undefined;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      addWarning(warnings, "symlink-skipped", "Symbolic links are not followed while inspecting resources.", relativeToSource);
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = await readdir(target, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        addWarning(warnings, code === "EACCES" ? "permission-denied" : "read-error", code === "EACCES" ? "Permission denied while inspecting this resource." : "Unable to inspect this directory.", relativeToSource);
        return;
      }
      for (const entry of entries) await visit(path.join(target, entry.name));
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > maxInspectionBytes) {
      addWarning(warnings, "large-file-skipped", "Content inspection is limited to files no larger than 1 MB.", relativeToSource);
      files.push({ relative: relativeToSource });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      addWarning(warnings, code === "EACCES" ? "permission-denied" : "read-error", code === "EACCES" ? "Permission denied while inspecting this file." : "Unable to read this file.", relativeToSource);
      return;
    }
    if (bytes.includes(0)) {
      files.push({ relative: relativeToSource });
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      files.push({ relative: relativeToSource });
      return;
    }
    files.push({ relative: relativeToSource, text });
  };
  await visit(sourceInput);
  return { files, excluded, warnings };
}

export async function inspectResource(candidate: ResourceCandidate): Promise<InspectionResult> {
  const scanned = await inspectFiles(candidate);
  const warnings = [...scanned.warnings];
  addWarning(warnings, "secret-detection-limited", "Secret detection is heuristic and cannot guarantee completeness.");
  const sensitivePaths: string[] = [];
  for (const file of scanned.files) {
    if (file.text === undefined) continue;
    if (containsInlineSecret(file.text)) {
      sensitivePaths.push(file.relative);
      addWarning(warnings, "sensitive-content", "This file may contain a secret; detection is heuristic and cannot guarantee completeness.", file.relative);
    }
    if (/\$\{?[A-Z_][A-Z0-9_]*\}?/.test(file.text)) addWarning(warnings, "environment-reference", "This resource refers to environment variables that may need to be configured separately.", file.relative);
    if (/(?:\/Users\/|\/home\/|[A-Za-z]:\\\\|~\/)[^\s"']+/.test(file.text)) addWarning(warnings, "absolute-path", "This resource contains a path that may not exist in another project.", file.relative);
    if (path.basename(file.relative) === "package.json") {
      try {
        const manifest = JSON.parse(file.text) as Record<string, unknown>;
        const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some((value) => typeof value === "object" && value !== null && Object.keys(value).length > 0);
        if (dependencies) addWarning(warnings, "dependency-requirement", "This resource declares dependencies; copi does not install them automatically.", file.relative);
      } catch {
        addWarning(warnings, "invalid-package-manifest", "This package manifest could not be parsed for dependency warnings.", file.relative);
      }
    }
  }
  if (candidate.destination.kind === "global-only") addWarning(warnings, "global-only", "This resource is saved for reference and cannot be applied to a project.");
  return { warnings, sensitivePaths: [...new Set(sensitivePaths)].sort(), excludedPaths: [...new Set(scanned.excluded)].sort() };
}

export function maskSensitiveText(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?)(?!\$\{?[A-Z_][A-Z0-9_]*\}?)([^"'\s,}]{8,})/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]");
}
