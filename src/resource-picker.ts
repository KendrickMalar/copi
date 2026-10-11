import { Prompt, type CANCEL_SYMBOL } from "@clack/core";
import { S_BAR, S_BAR_END, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, symbol } from "@clack/prompts";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import { maskSensitiveText } from "./inspect.ts";
import { truncateMiddle } from "./setup-display.ts";
import type { ResourceCandidate, ResourceKind } from "./types.ts";

export type ResourceTab = "Skills" | "Agents" | "Instructions" | "Settings";
const tabOrder: readonly ResourceTab[] = ["Skills", "Agents", "Instructions", "Settings"];

export function tabOf(kind: ResourceKind): ResourceTab {
  if (kind === "skill") return "Skills";
  if (kind === "subagent") return "Agents";
  if (kind === "instruction") return "Instructions";
  return "Settings";
}

export interface PickerRow {
  candidate: ResourceCandidate;
  /** Already safe for display (callers pass safeDisplay output). */
  label: string;
  /** Already safe for display: size · modified · destination. */
  details: string;
}

export interface PickerOptions {
  message: string;
  rows: readonly PickerRow[];
  initialValues?: readonly string[];
  /** Masks and neutralizes control characters; applied to every preview line. */
  sanitize: (text: string) => string;
  previewLines?: number;
  signal?: AbortSignal;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const previewReadBytes = 64 * 1024;

/** The file whose head the preview shows: the file itself, or a skill's SKILL.md (else its first regular file). */
export function previewFile(candidate: ResourceCandidate): string | undefined {
  try {
    const stat = lstatSync(candidate.sourcePath);
    if (stat.isFile()) return candidate.sourcePath;
    if (!stat.isDirectory()) return undefined;
    const skill = path.join(candidate.sourcePath, "SKILL.md");
    if (lstatSync(skill, { throwIfNoEntry: false })?.isFile()) return skill;
    const first = readdirSync(candidate.sourcePath, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()[0];
    return first === undefined ? undefined : path.join(candidate.sourcePath, first);
  } catch {
    return undefined;
  }
}

/** Masked head of the preview file: at most `lines` lines, plus a "… N more lines" marker when truncated. */
export function previewText(candidate: ResourceCandidate, lines: number, sanitize: (text: string) => string): { title: string; body: string[] } {
  const file = previewFile(candidate);
  if (!file) return { title: "no previewable file", body: [] };
  const title = sanitize(path.relative(path.dirname(candidate.sourcePath), file) || path.basename(file));
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(previewReadBytes);
    const read = readSync(fd, buffer, 0, previewReadBytes, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.includes(0)) return { title, body: ["[binary file]"] };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { title, body: ["[not UTF-8 text]"] }; }
    const all = maskSensitiveText(text).replace(/\r\n/g, "\n").split("\n");
    if (all.at(-1) === "") all.pop();
    const shown = all.slice(0, lines).map(sanitize);
    const more = all.length - lines;
    if (more > 0) shown.push(`… ${more}${read === previewReadBytes ? "+" : ""} more ${more === 1 && read < previewReadBytes ? "line" : "lines"}`);
    return { title, body: shown };
  } catch {
    return { title, body: ["[unreadable]"] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/**
 * A tabbed multi-select for setup: ←/→ switch kind tabs, ↑/↓ move, Tab toggles, typing filters the current tab,
 * Backspace deletes, Enter confirms the selection across all tabs. Shows a masked preview of the focused row.
 */
export class ResourcePickerPrompt extends Prompt<string[]> {
  readonly tabs: ResourceTab[];
  tab = 0;
  cursor = 0;
  filter = "";
  readonly selected: Set<string>;
  private readonly rowsByTab: Map<ResourceTab, PickerRow[]>;
  private readonly previews = new Map<string, { title: string; body: string[] }>();

  constructor(private readonly options: PickerOptions) {
    super({
      render() { return (this as unknown as ResourcePickerPrompt).draw(); },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.input ? { input: options.input as never } : {}),
      ...(options.output ? { output: options.output as never } : {}),
    }, false);
    this.rowsByTab = new Map(tabOrder.map((tab) => [tab, options.rows.filter((row) => tabOf(row.candidate.kind) === tab)]));
    this.tabs = tabOrder.filter((tab) => (this.rowsByTab.get(tab) ?? []).length > 0);
    const known = new Set(options.rows.map((row) => row.candidate.id));
    this.selected = new Set((options.initialValues ?? []).filter((id) => known.has(id)));
    this.value = [...this.selected];
    // Coming back to the list (e.g. "Go back"), open the first tab that holds a previous selection.
    const firstSelectedTab = this.tabs.findIndex((tab) => (this.rowsByTab.get(tab) ?? []).some((row) => this.selected.has(row.candidate.id)));
    if (firstSelectedTab >= 0) this.tab = firstSelectedTab;
    this.on("key", (char, key) => this.handleKey(char, key.name));
  }

  visibleRows(): PickerRow[] {
    const rows = this.rowsByTab.get(this.tabs[this.tab]!) ?? [];
    const needle = this.filter.toLowerCase();
    return needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows;
  }

  private handleKey(char: string | undefined, name: string | undefined): void {
    const rows = this.visibleRows();
    if (name === "left" || name === "right") {
      if (this.tabs.length > 0) this.tab = (this.tab + (name === "left" ? this.tabs.length - 1 : 1)) % this.tabs.length;
      this.cursor = 0;
      this.filter = "";
    } else if (name === "up") {
      this.cursor = rows.length === 0 ? 0 : (this.cursor + rows.length - 1) % rows.length;
    } else if (name === "down") {
      this.cursor = rows.length === 0 ? 0 : (this.cursor + 1) % rows.length;
    } else if (name === "tab") {
      const row = rows[this.cursor];
      if (row) {
        if (this.selected.has(row.candidate.id)) this.selected.delete(row.candidate.id);
        else this.selected.add(row.candidate.id);
      }
    } else if (name === "backspace") {
      this.filter = this.filter.slice(0, -1);
      this.cursor = 0;
    } else if (name !== "return" && char !== undefined && char.length === 1 && char >= " " && char !== "\x7f") {
      this.filter += char;
      this.cursor = 0;
    }
    // Keep the submitted value in canonical row order.
    this.value = this.options.rows.map((row) => row.candidate.id).filter((id) => this.selected.has(id));
  }

  private preview(row: PickerRow): { title: string; body: string[] } {
    let cached = this.previews.get(row.candidate.id);
    if (!cached) {
      cached = previewText(row.candidate, this.options.previewLines ?? 6, this.options.sanitize);
      this.previews.set(row.candidate.id, cached);
    }
    return cached;
  }

  draw(): string {
    const width = Math.max(20, (process.stdout.columns ?? 100) - 4);
    const bar = styleText("cyan", S_BAR);
    const title = `${symbol(this.state)}  ${this.options.message}`;
    if (this.state === "submit") return `${styleText("gray", S_BAR)}\n${title}\n${styleText("gray", S_BAR)}  ${styleText("dim", `${this.selected.size} items selected`)}`;
    if (this.state === "cancel") return `${styleText("gray", S_BAR)}\n${title}\n${styleText("gray", S_BAR)}  ${styleText(["strikethrough", "dim"], `${this.selected.size} items selected`)}`;
    const lines: string[] = [styleText("gray", S_BAR), title];
    const tabLine = this.tabs.map((tab, index) => {
      const rows = this.rowsByTab.get(tab) ?? [];
      const picked = rows.filter((row) => this.selected.has(row.candidate.id)).length;
      const text = `${tab} ${rows.length}${picked ? ` (${picked} selected)` : ""}`;
      return index === this.tab ? styleText(["inverse", "bold"], ` ${text} `) : styleText("dim", ` ${text} `);
    }).join(styleText("gray", "│"));
    lines.push(`${bar}  ${tabLine}`);
    lines.push(`${bar}  ${styleText("dim", "Search:")} ${this.filter}${styleText("inverse", " ")}`);
    const rows = this.visibleRows();
    const maxRows = Math.max(3, Math.min(10, (process.stdout.rows ?? 30) - 20));
    const start = Math.min(Math.max(0, this.cursor - Math.floor(maxRows / 2)), Math.max(0, rows.length - maxRows));
    if (rows.length === 0) lines.push(`${bar}  ${styleText("yellow", "No matches found")}`);
    if (start > 0) lines.push(`${bar}  ${styleText("dim", "…")}`);
    for (const [offset, row] of rows.slice(start, start + maxRows).entries()) {
      const index = start + offset;
      const box = this.selected.has(row.candidate.id) ? styleText("green", S_CHECKBOX_SELECTED) : styleText("dim", S_CHECKBOX_INACTIVE);
      // Middle truncation keeps both the name and trailing markers such as "(+1 identical copy)".
      const text = truncateMiddle(row.label, width - 4);
      lines.push(`${bar}  ${box} ${index === this.cursor ? styleText("underline", text) : text}`);
    }
    if (start + maxRows < rows.length) lines.push(`${bar}  ${styleText("dim", "…")}`);
    const focused = rows[this.cursor];
    if (focused) {
      const preview = this.preview(focused);
      lines.push(bar);
      lines.push(`${bar}  ${styleText("dim", clip(`── Preview: ${preview.title} (masked) · ${focused.details} ──`, width))}`);
      for (const line of preview.body) lines.push(`${bar}  ${styleText("dim", clip(line, width))}`);
    }
    lines.push(`${bar}  ${styleText("dim", "←/→ tabs • ↑/↓ move • Tab: select • Enter: confirm • Type: to search")}`);
    lines.push(styleText("cyan", S_BAR_END));
    return lines.join("\n");
  }
}

export async function resourcePicker(options: PickerOptions): Promise<string[] | typeof CANCEL_SYMBOL> {
  const result = await new ResourcePickerPrompt(options).prompt();
  return result ?? [];
}
