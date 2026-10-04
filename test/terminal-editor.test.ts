import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers/sandbox.ts";
import { runTerminalPty, type TerminalAction } from "./helpers/terminal-editor.ts";

async function editor(t: test.TestContext, initial: string, actions: TerminalAction[], extra = "", allowPendingInput = false, canonicalCheck = false) {
  const box = await sandbox(t);
  const input = path.join(box.root, "input.txt");
  const resultPath = path.join(box.root, "result.json");
  await writeFile(input, initial);
  const moduleUrl = new URL("../src/terminal-editor.js", import.meta.url).href;
  const code = `import { readFile, writeFile } from 'node:fs/promises';
const module = await import(${JSON.stringify(moduleUrl)}).catch(() => ({}));
const input = await readFile(${JSON.stringify(input)}, 'utf8');
const counts = () => ['data','end','close','error'].map(e => process.stdin.listenerCount(e)).concat(['SIGTERM','SIGINT','SIGHUP'].map(e => process.listenerCount(e)), process.stdout.listenerCount('resize'));
const before = counts(); if (typeof module.editTerminalText === 'function') { ${extra} }
const result = typeof module.editTerminalText === 'function' ? await module.editTerminalText(input) : {kind:'missing'};
let canonical;
if (${canonicalCheck}) {
  process.stdout.write('AFTER_EDITOR_CANONICAL_READY');
  canonical = await new Promise(resolve => {
    process.stdin.once('data', chunk => { process.stdin.pause(); resolve(chunk.toString()); });
    process.stdin.resume();
  });
}
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({result, before, after:counts(), raw:process.stdin.isRaw, canonical}));`;
  const pty = await runTerminalPty(box, [process.execPath, "--input-type=module", "-e", code], actions, [12,60], "tty", allowPendingInput);
  assert.equal(pty.code, 0, pty.output);
  const saved = JSON.parse(await readFile(resultPath, "utf8")) as { result: { kind: string; text?: string }; before: number[]; after: number[]; raw: boolean; canonical?: string };
  assert.ok(saved.result.kind === "submitted" || saved.result.kind === "cancelled", "editor must implement the text/cancel API");
  assert.deepEqual(saved.after, saved.before, "editor listeners must be released");
  assert.equal(saved.raw, false);
  assert.match(pty.output, /PTY_TERMIOS_RESTORED=True/);
  return { ...pty, ...saved };
}

test("U3 editor API returns submitted text only and no-op preserves BOM/CRLF/NFD/emoji bytes", async (t) => {
  const initial = "\ufeffe\u0301\r\n日本語🙂\r\n\r\n";
  const run = await editor(t, initial, [{waitFor:"Ctrl-S", send:"\u0013"}]);
  assert.deepEqual(run.result, {kind:"submitted", text:initial});
  assert.match(run.output, /Esc|Ctrl-C/);
  assert.ok(run.output.includes("\u001b[?1049h") && run.output.includes("\u001b[?1049l"));
  console.log(`no-op bytes=${Buffer.from(initial).toString("hex")}`);
});

test("U3 Enter and bracketed multiline paste with blank lines never submit; arrows edit by grapheme", async (t) => {
  const run = await editor(t, "日本\nAB\n", [
    {waitFor:"Ctrl-S", send:"\u001b[C\u001b[C\u001b[D語\u001b[B\u001b[H"},
    {send:"\u001b[200~e\u0301🙂\n\n貼付\r\n\u001b[201~"},
    {send:"\r\r\u0013"},
  ]);
  assert.equal(run.result.kind, "submitted");
  assert.equal(run.result.text, "日語本\ne\u0301🙂\n\n貼付\r\n\n\nAB\n");
});

test("U3 split UTF-8 input is not replaced; backspace/left never bisect combining/astral characters", async (t) => {
  const run = await editor(t, "", [
    {waitFor:"Ctrl-S", hex:"e697"}, {hex:"a5e69c"}, {hex:"ac"},
    {send:"e\u0301🙂"}, {send:"\u001b[D\u007f!\u0013"},
  ]);
  assert.deepEqual(run.result, {kind:"submitted", text:"日本!🙂"});
  assert.ok(!run.result.text?.includes("�"));
});

test("U3 viewport scrolls to caret, wraps Japanese width, and resize redraws only visible rows", async (t) => {
  const initial = Array.from({length:300}, (_,i) => `行${i} 日本語 long text`).join("\n");
  const run = await editor(t, initial, [
    {waitFor:"Ctrl-S", send:"\u001b[1;5F"},
    {resize:[8, 24]},
    {send:"\u001b[A\u001b[H!\u0013"},
  ]);
  const lines = initial.split("\n"); lines[298] = `!${lines[298]}`;
  assert.deepEqual(run.result, {kind:"submitted", text:lines.join("\n")});
  assert.ok(run.output.includes("行298"), "caret row must be in viewport");
  assert.ok(!run.output.includes("行150"), "off-screen body must not be dumped");
  assert.ok(Buffer.byteLength(run.output) < 15_000, `bounded rendering: ${Buffer.byteLength(run.output)} bytes`);
});

test("U3 editor safely displays saved ESC/OSC/control strings without changing the returned buffer", async (t) => {
  const initial = "hello\u001b]52;c;ATTACK\u0007\n\t\ufeff日本\r\n";
  const run = await editor(t, initial, [{waitFor:"Ctrl-S", send:"\u0013"}]);
  assert.deepEqual(run.result, {kind:"submitted", text:initial});
  assert.ok(!run.output.includes("\u001b]52"));
  assert.ok(run.output.includes("\\u001b"));
});

for (const [name, action] of [
  ["Esc", {send:"\u001b"}], ["Ctrl-C", {send:"\u0003"}], ["Ctrl-D", {send:"\u0004"}],
  ["SIGTERM", {signal:"SIGTERM"}], ["SIGINT", {signal:"SIGINT"}], ["SIGHUP", {signal:"SIGHUP"}],
] as const) {
  test(`U3 ${name} discards text and restores raw mode/listeners/alternate screen`, async (t) => {
    const run = await editor(t, "unchanged", [{waitFor:"Ctrl-S", send:"changed"}, action]);
    assert.deepEqual(run.result, {kind:"cancelled"});
    assert.ok(run.output.includes("\u001b[?1049l"));
    assert.ok(run.output.includes("unchanged"), "prefill is visible while editing");
    assert.ok(!run.output.slice(run.output.indexOf("\u001b[?1049l")).includes("unchanged"), "no body is printed after leaving the editor");
  });
}

for (const event of ["EOF", "input error"] as const) {
  test(`U3 ${event} restores editor state without submission`, async (t) => {
    const extra = event === "EOF" ? "setTimeout(() => process.stdin.push(null), 500);" : "setTimeout(() => process.stdin.emit('error', new Error('synthetic input failure')), 500);";
    const run = await editor(t, "unchanged", [], extra);
    assert.deepEqual(run.result, {kind:"cancelled"});
  });
}

test("U3 exactly 1MB long-line no-op emits bounded viewport output", async (t) => {
  const initial = "A".repeat(1_000_000);
  const run = await editor(t, initial, [{waitFor:"Ctrl-S", send:"\u0013"}]);
  assert.deepEqual(run.result, {kind:"submitted", text:initial});
  assert.ok(Buffer.byteLength(run.output) < 5_000);
});

test("U3 narrow resized viewport keeps both review and cancel keys visible",async(t)=>{
  const run=await editor(t,"日本語",[{waitFor:"Ctrl-S",resize:[8,24]},{send:"\u0013"}]);
  const header=run.output.split("\u001b[H\u001b[2K").at(-1)!.split("\u001b[2;1H")[0]!;
  assert.match(header,/Ctrl-S/); assert.match(header,/Esc/);
});

test("U3 orphan combining mark is visibly anchored without changing its saved codepoints",async(t)=>{
  const initial="\u0301A";
  const run=await editor(t,initial,[{waitFor:"Ctrl-S",send:"\u001b[C"},{send:"\u0013"}]);
  assert.deepEqual(run.result,{kind:"submitted",text:initial});
  assert.ok(run.output.includes("◌\u0301"));
});

test("U3 rendering exception releases listeners and restores TTY without submitting",async(t)=>{
  const extra="const originalWrite = process.stdout.write.bind(process.stdout); let writes=0; process.stdout.write = (...args) => { if (++writes===2) throw new Error('synthetic rendering failure'); return originalWrite(...args); };";
  const run=await editor(t,"unchanged",[],extra,true);
  assert.deepEqual(run.result,{kind:"cancelled"});
  // Raw arrays and XOR are always logged; only this zero-input exception allows PENDIN on Darwin.
  assert.match(run.output,/LFLAG_XOR=(0|536870912)\n/);
});

test("U3 after zero-input rendering exception canonical input/echo resumes without leftover text and clears PENDIN",async(t)=>{
  const extra="const originalWrite = process.stdout.write.bind(process.stdout); let writes=0; process.stdout.write = (...args) => { if (++writes===2) throw new Error('synthetic rendering failure'); return originalWrite(...args); };";
  const run=await editor(t,"unchanged",[
    {waitFor:"AFTER_EDITOR_CANONICAL_READY",checkpointTermios:true,send:"next input"}, {send:"\r"},
  ],extra,false,true);
  assert.deepEqual(run.result,{kind:"cancelled"});
  assert.equal(run.canonical,"next input\n", "canonical data arrives as one full line; no editor input carries over");
  assert.match(run.output,/next input\r\n/); // This echo comes from the real PTY, not our child fixture.
  assert.match(run.output,/PTY_TERMIOS_EXACT=True/);
});

test("F4 overlong CSI input cancels safely rather than accumulating or submitting a malformed command",async(t)=>{
  const run=await editor(t,"unchanged",[{waitFor:"Ctrl-S",send:`\u001b[${"2".repeat(1_000)}~\u0013`}]);
  assert.deepEqual(run.result,{kind:"cancelled"});
});
