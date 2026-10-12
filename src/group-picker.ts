import { isCancel as isCoreCancel, Prompt } from "@clack/core";
import { CANCEL_SYMBOL, S_BAR, S_BAR_END, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, symbol } from "@clack/prompts";
import stringWidth from "fast-string-width";
import { styleText } from "node:util";
import { clip } from "./resource-picker.ts";

export interface GroupRow {
  id: string;
  /** Already safe for display. */
  label: string;
  /** Already safe for display, e.g. "4 saved · 1 pending". */
  hint: string;
}

/** `groupIds` is always the current selection, so an action can return to the list with it intact. */
export type GroupPickerResult = { kind: "assign" | "new" | "edit" | "skip"; groupIds: string[]; filter: string };

export interface GroupPickerOptions {
  /** Already safe for display. */
  message: string;
  groups: readonly GroupRow[];
  initialValues?: readonly string[];
  /** Adds a last row that skips this resource (it is not saved). */
  allowSkip?: boolean;
  signal?: AbortSignal;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

type Row = { kind: "group"; group: GroupRow } | { kind: "new" } | { kind: "edit" } | { kind: "skip" };

export const newGroupLabel = "＋ New group…";
export const editGroupsLabel = "✎ Rename or delete groups…";
export const skipLabel = "↷ Skip \u2014 don't save this resource";

/**
 * Multi-select of groups with two action rows at the end. ↑/↓ move, Tab or Space toggles, typing filters groups,
 * Enter on a group row confirms the selection (at least one), Enter on an action row returns that action.
 */
export class GroupPickerPrompt extends Prompt<GroupPickerResult> {
  cursor = 0;
  filter = "";
  readonly selected: Set<string>;

  constructor(private readonly options: GroupPickerOptions) {
    super({
      render() { return (this as unknown as GroupPickerPrompt).draw(); },
      validate(value) {
        return value?.kind === "assign" && value.groupIds.length === 0 ? "Select at least one group (Tab), or create one." : undefined;
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.input ? { input: options.input as never } : {}),
      ...(options.output ? { output: options.output as never } : {}),
    }, false);
    const known = new Set(options.groups.map((group) => group.id));
    this.selected = new Set((options.initialValues ?? []).filter((id) => known.has(id)));
    this.updateValue();
    this.on("key", (char, key) => this.handleKey(char, key.name));
  }

  rows(): Row[] {
    const needle = this.filter.toLowerCase();
    const groups = this.options.groups.filter((group) => !needle || group.label.toLowerCase().includes(needle));
    return [
      ...groups.map((group) => ({ kind: "group" as const, group })),
      { kind: "new" as const },
      ...(this.options.groups.length > 0 ? [{ kind: "edit" as const }] : []),
      ...(this.options.allowSkip ? [{ kind: "skip" as const }] : []),
    ];
  }

  private updateValue(): void {
    const focused = this.rows()[this.cursor];
    const groupIds = this.options.groups.map((group) => group.id).filter((id) => this.selected.has(id));
    this.value = { kind: focused && focused.kind !== "group" ? focused.kind : "assign", groupIds, filter: this.filter.trim() };
  }

  private handleKey(char: string | undefined, name: string | undefined): void {
    const rows = this.rows();
    if (name === "up") this.cursor = (this.cursor + rows.length - 1) % rows.length;
    else if (name === "down") this.cursor = (this.cursor + 1) % rows.length;
    // Space toggles while the search is empty; once typing has started it is part of the search text.
    else if (name === "tab" || (name === "space" && this.filter === "")) {
      const row = rows[this.cursor];
      if (row?.kind === "group") {
        if (this.selected.has(row.group.id)) this.selected.delete(row.group.id);
        else this.selected.add(row.group.id);
      }
    } else if (name === "backspace") {
      this.filter = this.filter.slice(0, -1);
      this.cursor = 0;
    } else if (name !== "return" && char !== undefined && [...char].length === 1 && char >= " " && !/[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(char)) {
      this.filter += char;
      this.cursor = 0;
    }
    this.updateValue();
  }

  draw(): string {
    const width = Math.max(20, (process.stdout.columns ?? 100) - 4);
    const title = `${symbol(this.state)}  ${this.options.message}`;
    const chosen = this.options.groups.filter((group) => this.selected.has(group.id)).map((group) => group.label).join(", ");
    if (this.state === "submit") {
      const summary = this.value?.kind === "assign" ? chosen : this.value?.kind === "new" ? "New group" : this.value?.kind === "skip" ? "Skipped" : "Rename or delete groups";
      return `${styleText("gray", S_BAR)}\n${title}\n${styleText("gray", S_BAR)}  ${styleText("dim", clip(summary, width))}`;
    }
    if (this.state === "cancel") return `${styleText("gray", S_BAR)}\n${title}\n${styleText("gray", S_BAR)}  ${styleText(["strikethrough", "dim"], clip(chosen || "Cancelled", width))}`;
    const color = this.state === "error" ? "yellow" : "cyan";
    const bar = styleText(color, S_BAR);
    const lines: string[] = [styleText("gray", S_BAR), title];
    lines.push(`${bar}  ${styleText("dim", "Search:")} ${clip(this.filter, width - 10)}${styleText("inverse", " ")}`);
    const rows = this.rows();
    if (!rows.some((row) => row.kind === "group") && this.filter) lines.push(`${bar}  ${styleText("yellow", "No matching groups \u2014 Enter on New group uses the search text as its name")}`);
    // Keep the focused row visible when there are more groups than the terminal can show.
    const maxRows = Math.max(4, Math.min(12, (process.stdout.rows ?? 30) - 12));
    const start = Math.min(Math.max(0, this.cursor - Math.floor(maxRows / 2)), Math.max(0, rows.length - maxRows));
    if (start > 0) lines.push(`${bar}  ${styleText("dim", "\u2026")}`);
    for (const [offset, row] of rows.slice(start, start + maxRows).entries()) {
      const focused = start + offset === this.cursor;
      if (row.kind === "group") {
        const box = this.selected.has(row.group.id) ? styleText("green", S_CHECKBOX_SELECTED) : styleText("dim", S_CHECKBOX_INACTIVE);
        const hint = `(${row.group.hint})`;
        const label = clip(row.group.label, Math.max(8, width - 3 - Math.min(stringWidth(hint), 24) - 1));
        const room = width - 3 - stringWidth(label) - 1;
        lines.push(`${bar}  ${box} ${focused ? styleText("underline", label) : label}${room >= 4 ? ` ${styleText("dim", clip(hint, room))}` : ""}`);
      } else {
        const label = row.kind === "new" ? newGroupLabel : row.kind === "edit" ? editGroupsLabel : skipLabel;
        lines.push(`${bar}  ${focused ? styleText(["cyan", "underline"], label) : styleText("dim", label)}`);
      }
    }
    if (start + maxRows < rows.length) lines.push(`${bar}  ${styleText("dim", "\u2026")}`);
    if (this.state === "error") lines.push(`${bar}  ${styleText("yellow", clip(this.error, width))}`);
    lines.push(`${bar}  ${styleText("dim", clip("↑/↓ move • Tab/Space: select • Enter: confirm or run the focused action • Type: to search", width))}`);
    lines.push(styleText(color, S_BAR_END));
    return lines.join("\n");
  }
}

export async function groupPicker(options: GroupPickerOptions): Promise<GroupPickerResult | typeof CANCEL_SYMBOL> {
  const result = await new GroupPickerPrompt(options).prompt();
  if (isCoreCancel(result) || result === undefined) return CANCEL_SYMBOL;
  return result;
}
