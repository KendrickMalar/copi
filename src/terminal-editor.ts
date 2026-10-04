import { StringDecoder } from "node:string_decoder";

export type TerminalEditResult = { kind: "cancelled" } | { kind: "submitted"; text: string };
interface Glyph { text: string; shown: string; start: number; end: number; width: number }
interface Row { start: number; end: number; width: number }
interface Line { text: string; ending: string; glyphs?: Glyph[]; rows?: Row[]; columns?: number }
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    lines.push({ text: text.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: text.slice(start), ending: "" });
  return lines;
}
function shownText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\ufeff\u202a-\u202e\u2066-\u2069]/g,
    (char) => char === "\t" ? "    " : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function cellWidth(text: string): number {
  if (/^[\p{Mark}]+$/u.test(text)) return 1;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text)) return 2;
  const point = text.codePointAt(0)!;
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) || (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) || (point >= 0xfe10 && point <= 0xfe19) ||
    (point >= 0xfe30 && point <= 0xfe6f) || (point >= 0xff01 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) || (point >= 0x20000 && point <= 0x3fffd)) ? 2 : 1;
}
function glyphsOf(line: Line): Glyph[] {
  if (line.glyphs) return line.glyphs;
  const glyphs: Glyph[] = [];
  const add = (text: string, start: number) => {
    const shown = /^[\p{Mark}]+$/u.test(text) ? `◌${text}` : shownText(text);
    glyphs.push({ text, shown, start, end: start + text.length, width: /^[\p{Mark}]+$/u.test(text) ? 1 : shown !== text ? shown.length : cellWidth(text) });
  };
  // Avoid invoking the Unicode segmenter a million times for a long ASCII file.
  if (/^[\x20-\x7e]*$/.test(line.text)) {
    for (let i = 0; i < line.text.length; i++) add(line.text[i]!, i);
  } else {
    for (const part of segmenter.segment(line.text)) add(part.segment, part.index);
  }
  line.glyphs = glyphs;
  return glyphs;
}
function rowsOf(line: Line, columns: number): Row[] {
  if (line.rows && line.columns === columns) return line.rows;
  const rows: Row[] = [];
  const glyphs = glyphsOf(line);
  let start = 0, width = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const next = Math.min(columns, glyphs[i]!.width);
    if (width + next > columns) { rows.push({ start, end: i, width }); start = i; width = 0; }
    width += next;
  }
  rows.push({ start, end: glyphs.length, width });
  line.rows = rows; line.columns = columns;
  return rows;
}

/** In-memory editor only: no file/catalog access, no body logging on submit or cancel. */
export async function editTerminalText(initialText: string): Promise<TerminalEditResult> {
  const input = process.stdin, output = process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error("Text editing requires an interactive stdin/stdout TTY.");
  const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder("utf8");
  let lines = linesOf(initialText), lineIndex = 0, offset = 0, pending = "", paste = false, pasteText = "";
  let finished = false, frame: ReturnType<typeof setTimeout> | undefined, escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let verticalColumn: number | undefined;
  const newline = lines.find((line) => line.ending)?.ending ?? "\n";
  const dimensions = () => ({ columns: Math.max(1, (output.columns || 80) - 1), height: Math.max(1, (output.rows || 24) - 2) });
  const point = () => {
    const glyphs = glyphsOf(lines[lineIndex]!);
    let index = glyphs.findIndex((glyph) => glyph.end > offset);
    if (index < 0) index = glyphs.length;
    const rows = rowsOf(lines[lineIndex]!, dimensions().columns);
    let rowIndex = rows.findIndex((row, i) => index < row.end || i === rows.length - 1);
    if (rowIndex < 0) rowIndex = rows.length - 1;
    const row = rows[rowIndex]!;
    const column = glyphs.slice(row.start, index).reduce((sum, glyph) => sum + Math.min(dimensions().columns, glyph.width), 0);
    return { index, rowIndex, column };
  };
  const previousRow = (line: number, row: number): [number, number] | undefined => {
    if (row > 0) return [line, row - 1];
    if (line === 0) return undefined;
    return [line - 1, rowsOf(lines[line - 1]!, dimensions().columns).length - 1];
  };
  const nextRow = (line: number, row: number): [number, number] | undefined => {
    if (row + 1 < rowsOf(lines[line]!, dimensions().columns).length) return [line, row + 1];
    return line + 1 < lines.length ? [line + 1, 0] : undefined;
  };
  const render = () => {
    frame = undefined;
    if (finished) return;
    const { columns, height } = dimensions();
    const caret = point();
    let top: [number, number] = [lineIndex, caret.rowIndex], caretRow = 0;
    for (let i = 0; i < height - 1; i++) {
      const previous = previousRow(...top);
      if (!previous) break;
      top = previous; caretRow++;
    }
    const visible: string[] = [];
    let at: [number, number] | undefined = top;
    while (visible.length < height && at) {
      const line = lines[at[0]]!, row = rowsOf(line, columns)[at[1]]!;
      visible.push(glyphsOf(line).slice(row.start, row.end).map((glyph) => glyph.width > columns ? glyph.shown.slice(0, columns) : glyph.shown).join(""));
      at = nextRow(...at);
    }
    const header = (columns >= 52 ? "Edit saved text · Ctrl-S: review · Esc / Ctrl-C: cancel" : "Ctrl-S review/Esc cancel").slice(0, columns);
    const footer = `Line ${lineIndex + 1}/${lines.length} · Enter: newline · arrows: move · PgUp/PgDn: scroll`.slice(0, columns);
    let screen = `\u001b[?25l\u001b[H\u001b[2K${header}`;
    for (let i = 0; i < height; i++) screen += `\u001b[${i + 2};1H\u001b[2K${visible[i] ?? ""}`;
    screen += `\u001b[${height + 2};1H\u001b[2K${footer}\u001b[${caretRow + 2};${Math.min(columns, caret.column) + 1}H\u001b[?25h`;
    output.write(screen);
  };
  const redraw = () => { if (!frame && !finished) frame = setTimeout(() => { try { render(); } catch { cancel(); } }, 16); };
  const insert = (text: string) => {
    if (!text) return;
    const line = lines[lineIndex]!;
    const added = linesOf(line.text.slice(0, offset) + text + line.text.slice(offset));
    const head = linesOf(line.text.slice(0, offset) + text);
    added[added.length - 1]!.ending = line.ending;
    lines.splice(lineIndex, 1, ...added);
    lineIndex += head.length - 1; offset = head[head.length - 1]!.text.length;
    verticalColumn = undefined;
  };
  const horizontal = (direction: -1 | 1) => {
    const glyphs = glyphsOf(lines[lineIndex]!);
    if (direction < 0) {
      let previous: Glyph | undefined;
      for (let i = glyphs.length - 1; i >= 0; i--) if (glyphs[i]!.start < offset) { previous = glyphs[i]; break; }
      if (previous) offset = previous.start;
      else if (lineIndex > 0) { lineIndex--; offset = lines[lineIndex]!.text.length; }
    } else {
      const next = glyphs.find((glyph) => glyph.end > offset);
      if (next) offset = next.end;
      else if (lineIndex + 1 < lines.length) { lineIndex++; offset = 0; }
    }
    verticalColumn = undefined;
  };
  const vertical = (direction: -1 | 1) => {
    const caret = point();
    const target = direction < 0 ? previousRow(lineIndex, caret.rowIndex) : nextRow(lineIndex, caret.rowIndex);
    if (!target) return;
    verticalColumn ??= caret.column;
    lineIndex = target[0];
    const line = lines[lineIndex]!, row = rowsOf(line, dimensions().columns)[target[1]]!, glyphs = glyphsOf(line);
    let width = 0, index = row.start;
    while (index < row.end && width + glyphs[index]!.width <= verticalColumn) width += glyphs[index++]!.width;
    offset = glyphs[index]?.start ?? line.text.length;
  };
  const remove = (backwards: boolean) => {
    const oldLine = lineIndex, oldOffset = offset;
    horizontal(backwards ? -1 : 1);
    if (oldLine === lineIndex) {
      const line = lines[lineIndex]!;
      lines[lineIndex] = { text: line.text.slice(0, Math.min(oldOffset, offset)) + line.text.slice(Math.max(oldOffset, offset)), ending: line.ending };
      offset = Math.min(oldOffset, offset);
    } else {
      const first = Math.min(oldLine, lineIndex), left = lines[first]!, right = lines[first + 1]!;
      lines.splice(first, 2, { text: left.text + right.text, ending: right.ending });
      lineIndex = first; offset = left.text.length;
    }
  };
  let complete: (result: TerminalEditResult) => void;
  const result = new Promise<TerminalEditResult>((resolve) => { complete = resolve; });
  const finish = (value: TerminalEditResult) => {
    if (finished) return;
    finished = true;
    if (frame) clearTimeout(frame);
    if (escapeTimer) clearTimeout(escapeTimer);
    input.off("data", data); input.off("end", cancel); input.off("close", cancel); input.off("error", cancel);
    output.off("resize", redraw); output.off("error", cancel);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, cancel);
    try { input.setRawMode(wasRaw); } finally {
      if (!wasFlowing) input.pause();
      try { output.write("\u001b[?2004l\u001b[?1049l\u001b[?25h"); } finally { complete(value); }
    }
  };
  const cancel = () => finish({ kind: "cancelled" });
  const command = (sequence: string) => {
    switch (sequence) {
      case "\u001b[A": vertical(-1); break;
      case "\u001b[B": vertical(1); break;
      case "\u001b[C": horizontal(1); break;
      case "\u001b[D": horizontal(-1); break;
      case "\u001b[H": case "\u001bOH": case "\u001b[1~": offset = 0; verticalColumn = undefined; break;
      case "\u001b[F": case "\u001bOF": case "\u001b[4~": offset = lines[lineIndex]!.text.length; verticalColumn = undefined; break;
      case "\u001b[1;5H": lineIndex = 0; offset = 0; verticalColumn = undefined; break;
      case "\u001b[1;5F": lineIndex = lines.length - 1; offset = lines[lineIndex]!.text.length; verticalColumn = undefined; break;
      case "\u001b[3~": remove(false); break;
      case "\u001b[5~": for (let i = 0; i < dimensions().height; i++) vertical(-1); break;
      case "\u001b[6~": for (let i = 0; i < dimensions().height; i++) vertical(1); break;
    }
  };
  const consume = () => {
    while (pending && !finished) {
      if (paste) {
        const end = pending.indexOf("\u001b[201~");
        if (end < 0) {
          // Keep a possible split closing delimiter, not the full paste, in the parser.
          const keep = Math.min(5, pending.length);
          pasteText += pending.slice(0, pending.length - keep); pending = pending.slice(-keep);
          return;
        }
        pasteText += pending.slice(0, end); pending = pending.slice(end + 6);
        insert(pasteText); pasteText = ""; paste = false; continue;
      }
      if (pending.startsWith("\u001b[200~")) { paste = true; pending = pending.slice(6); continue; }
      if (pending[0] === "\u001b") {
        const match = /^(?:\u001b\[[0-9;?]*[A-Za-z~]|\u001bO[A-Za-z])/.exec(pending);
        if (match) { command(match[0]); pending = pending.slice(match[0].length); continue; }
        if (pending === "\u001b" || /^\u001b(?:\[[0-9;?]*|O)$/.test(pending)) {
          escapeTimer = setTimeout(cancel, 100); return;
        }
        cancel(); return;
      }
      const control = pending.search(/[\x00-\x08\x0a-\x1f\x7f]/);
      if (control > 0 || control < 0) {
        const end = control < 0 ? pending.length : control;
        insert(pending.slice(0, end)); pending = pending.slice(end); continue;
      }
      const char = pending[0]; pending = pending.slice(1);
      if (char === "\u0013") finish({kind:"submitted",text:lines.map((line) => line.text + line.ending).join("")});
      else if (char === "\u0003" || char === "\u0004") cancel();
      else if (char === "\r") insert(newline);
      else if (char === "\n") insert("\n");
      else if (char === "\u007f" || char === "\b") remove(true);
    }
    redraw();
  };
  const data = (chunk: Buffer | string) => {
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = undefined; }
    try { pending += typeof chunk === "string" ? chunk : decoder.write(chunk); consume(); } catch { cancel(); }
  };
  try {
    input.on("data", data); input.on("end", cancel); input.on("close", cancel); input.on("error", cancel);
    output.on("resize", redraw); output.on("error", cancel);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, cancel);
    input.setRawMode(true); input.resume();
    output.write("\u001b[?1049h\u001b[?2004h");
    render();
  } catch { cancel(); }
  return result;
}
