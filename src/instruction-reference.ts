import path from "node:path";

export const contextFileNames: readonly string[] = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const systemPromptPaths = new Set([".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md"]);

export function isAutoLoadedInstruction(destination: string): boolean {
  return contextFileNames.includes(path.posix.basename(destination)) || systemPromptPaths.has(destination);
}

export function referenceLine(instructionPath: string): string {
  return `- 作業を始める前に \`${instructionPath}\` を読み、その指示に従うこと。`;
}

export function unreferencedPaths(instructionPaths: readonly string[], contextTexts: readonly string[]): string[] {
  return [...new Set(instructionPaths)].filter((value) => !contextTexts.some((text) => text.includes(value)));
}

export function chooseReferenceTarget(existingNames: readonly string[]): string {
  return contextFileNames.find((name) => existingNames.includes(name)) ?? "AGENTS.md";
}

export function appendReferenceLines(existing: string | undefined, instructionPaths: readonly string[]): string {
  const lines = `${instructionPaths.map(referenceLine).join("\n")}\n`;
  if (!existing) return lines;
  return `${existing.endsWith("\n") ? existing : `${existing}\n`}\n${lines}`;
}
