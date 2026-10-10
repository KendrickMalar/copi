import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertModernCatalog, importPreparedResource, loadCatalog as loadStoredCatalog, prepareResource, saveCatalog } from "../../src/catalog.ts";
import { inspectPreparedResource } from "../../src/inspect.ts";

const sourceTypeScript = import.meta.url.endsWith(".ts");
export const sourceNodeFlags = sourceTypeScript ? ["--experimental-transform-types"] : [];
export const cli = new URL(sourceTypeScript ? "../../src/cli.ts" : "../../src/cli.js", import.meta.url).pathname;
export const catalogModule = new URL(sourceTypeScript ? "../../src/catalog.ts" : "../../src/catalog.js", import.meta.url).href;
export const terminalEditorModule = new URL(sourceTypeScript ? "../../src/terminal-editor.ts" : "../../src/terminal-editor.js", import.meta.url).href;
export async function loadCatalog(library: string) {
  const catalog = await loadStoredCatalog(library);
  assertModernCatalog(catalog);
  return catalog;
}
export function storedContentPath(library: string, contentPath: string): string {
  return path.join(library, ...contentPath.split("/"));
}
export const down = "\x1b[B";
export interface Step {
  wait?: string; text?: string; hex?: string; delayMs?: number; signal?: "SIGINT" | "SIGTERM" | "SIGHUP";
  resize?: [number, number]; replace?: { path: string; text: string }; checkpoint?: boolean; probe?: string[];
}
export async function box() {
  const root = await mkdtemp(path.join(os.tmpdir(), "copi-u6-independent-"));
  const home = path.join(root, "home"), agent = path.join(home, ".pi/agent"), cwd = path.join(root, "cwd");
  const source = path.join(root, "source"), tmp = path.join(root, "tmp"), cache = path.join(root, "cache");
  for (const directory of [agent, cwd, source, tmp, cache]) await mkdir(directory, { recursive: true });
  return { root, home, agent, cwd, source, tmp, cache, library: path.join(home, ".copi") };
}
export type Box = Awaited<ReturnType<typeof box>>;
export function environment(b: Box): NodeJS.ProcessEnv {
  return { ...process.env, HOME: b.home, PI_CODING_AGENT_DIR: b.agent, TMPDIR: b.tmp,
    NPM_CONFIG_CACHE: b.cache, NPM_CONFIG_USERCONFIG: "/dev/null", TERM: "xterm-256color", FORCE_COLOR: "0" };
}
export async function add(b: Box, files: Record<string, string | Buffer>, name = "旅程 notes", destination = ".pi/skills/itinerary") {
  const sourcePath = path.join(b.source, randomUUID());
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(sourcePath, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  if (!Object.hasOwn(files, "SKILL.md")) throw new Error("A skill fixture must include root SKILL.md.");
  const prepared = await prepareResource({ id: "independent-source", name, kind: "skill", source: "acceptance-fixture", scope: "project",
    sourceRoot: b.source, sourcePath, destination: { kind: "project", path: destination } });
  const inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(b.library, prepared, { confirmed: true, groupIds: [], inspection, approvedSensitivePaths: inspection.sensitivePaths });
  assert.ok(item);
  if (item.content.kind !== "tree" || item.content.path !== `sources/${item.id}`) throw new Error("Skill fixture must use its UUID-bound sources tree.");
  const contentPath = storedContentPath(b.library, item.content.path);
  return { item, sourcePath, saved: (relative: string) => path.join(contentPath, ...relative.split("/")) };
}
export async function fixture(bytes: string | Buffer = "north\nsouth\n", files: Record<string, string | Buffer> = {}) {
  const b = await box(); const a = await add(b, { "SKILL.md": bytes, ...files });
  const catalog = await loadCatalog(b.library);
  const group = { id: "51013c26-3c16-4e80-aea4-60f77a402911", name: "出張 bundle", itemIds: [a.item.id] };
  catalog.groups.push(group); await saveCatalog(b.library, catalog);
  return { ...b, ...a, group };
}
export async function tree(root: string): Promise<Record<string, { mode: number; hex?: string; link?: string }>> {
  const entries: Record<string, { mode: number; hex?: string; link?: string }> = {};
  async function visit(directory: string, relative: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), key = relative ? `${relative}/${name}` : name, stat = await lstat(file);
      entries[key] = { mode: stat.mode & 0o777 };
      if (stat.isSymbolicLink()) entries[key]!.link = await readlink(file);
      else if (stat.isDirectory()) await visit(file, key);
      else entries[key]!.hex = (await readFile(file)).toString("hex");
    }
  }
  try { await visit(root, ""); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return entries;
}
export async function custody(b: Box) {
  const observed = { library: await tree(b.library), source: await tree(b.source), target: await tree(b.cwd) };
  const bytes = Buffer.from(JSON.stringify(observed)), evidence = path.join(b.root, `custody-${randomUUID()}.json`);
  await writeFile(evidence, bytes); console.log(`raw FS custody sha256=${hash(bytes)} evidence=${evidence}`);
  return observed;
}
export const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function plain(output: string): string { return output.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, ""); }
export function noIds(output: string, ids: string[]) { for (const id of ids) assert.ok(!output.includes(id), `management ID leaked: ${id}`); }
export function runCli(b: Box, args: string[], entry = cli) {
  return spawnSync(process.execPath, [...sourceNodeFlags, entry, ...args], { cwd: b.cwd, env: environment(b), encoding: "utf8", timeout: 15_000 });
}

// Independent PTY observer: no stty, no flush, no unconditional PENDIN mask.
const driver = String.raw`import os, pty, select, subprocess, sys, json, time, errno, fcntl, termios, struct, signal
config=json.load(open(sys.argv[1])); master,slave=pty.openpty()
def state():
    a=termios.tcgetattr(slave)
    return a[:6]+[[x if isinstance(x,int) else x.hex() for x in a[6]]]
def resize(size): fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',*size,0,0))
resize(config['size']); before=state(); mode=config['mode']
p=subprocess.Popen(config['argv'],stdin=slave if mode not in ['stdin-pipe','both-pipe'] else subprocess.DEVNULL,stdout=slave if mode not in ['stdout-pipe','both-pipe'] else subprocess.PIPE,stderr=slave,cwd=config['cwd'],env=os.environ.copy())
steps=config['steps']; index=0; out=b''; pending=b''; checkpoints=[]; probes=[]; timeline=[]; started=time.monotonic(); deadline=started+30
while time.monotonic()<deadline:
    if select.select([master],[],[],.025)[0]:
        try: data=os.read(master,65536)
        except OSError as e:
            if e.errno==errno.EIO: break
            raise
        out+=data; pending+=data
    if index<len(steps) and (not steps[index].get('wait') or steps[index]['wait'].encode() in pending):
        s=steps[index]; time.sleep(s.get('delayMs',80)/1000)
        if s.get('checkpoint'): checkpoints.append({'action':index,'raw':state()})
        if 'probe' in s:
            try:
                probe=subprocess.run(s['probe'],cwd=config['cwd'],env=os.environ.copy(),capture_output=True,timeout=5)
                probes.append({'action':index,'code':probe.returncode,'stdout':probe.stdout.decode(),'stderr':probe.stderr.decode()})
            except subprocess.TimeoutExpired: probes.append({'action':index,'code':124})
        if 'replace' in s:
            with open(s['replace']['path'],'wb') as f: f.write(s['replace']['text'].encode())
        if 'resize' in s: resize(s['resize']); p.send_signal(signal.SIGWINCH)
        sent=b''; written=0
        if 'text' in s: sent=s['text'].encode(); written=os.write(master,sent)
        if 'hex' in s: sent=bytes.fromhex(s['hex']); written=os.write(master,sent)
        if 'signal' in s: p.send_signal(getattr(signal,s['signal']))
        timeline.append({'action':index,'elapsedMs':(time.monotonic()-started)*1000,'sentHex':sent.hex(),'written':written})
        index+=1; pending=b''
    if p.poll() is not None:
        while select.select([master],[],[],.03)[0]:
            try: out+=os.read(master,65536)
            except OSError: break
        break
timeout=p.poll() is None
if timeout: p.kill()
code=p.wait(); after=state()
if mode in ['stdout-pipe','both-pipe']: out+=p.stdout.read()
open(config['output'],'wb').write(out)
json.dump({'code':124 if timeout else code,'timeout':timeout,'actions':index,'totalActions':len(steps),'before':before,'after':after,'exact':before==after,'xor':[before[i]^after[i] for i in range(6)],'checkpoints':checkpoints,'probes':probes,'timeline':timeline,'platform':sys.platform},open(config['state'],'w'))
os.close(master); os.close(slave)
`;
export interface PtyState { code: number; timeout: boolean; actions: number; totalActions: number; before: Array<number | Array<string | number>>; after: Array<number | Array<string | number>>; exact: boolean; xor: number[]; checkpoints: Array<{ action: number; raw: PtyState["before"] }>; platform: string; probes: Array<{ action: number; code: number; stdout?: string; stderr?: string }>; timeline: Array<{ action: number; elapsedMs: number; sentHex: string; written: number }> }
export async function pty(b: Box, argv: string[], steps: Step[], mode = "tty", size: [number, number] = [14, 72]) {
  const prefix = path.join(b.root, `pty-${randomUUID()}`), output = `${prefix}.bin`, state = `${prefix}.state.json`, config = `${prefix}.actions.json`;
  await writeFile(config, JSON.stringify({ argv, steps, cwd: b.cwd, mode, size, output, state }));
  const diagnostics = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", ["-c", driver, config], { cwd: b.cwd, env: environment(b) });
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => chunks.push(chunk));
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`PTY driver exit ${code}: ${Buffer.concat(chunks)}`)));
  });
  const raw = await readFile(output), observed = JSON.parse(await readFile(state, "utf8")) as PtyState;
  console.log(`independent PTY bytes=${raw.length} sha256=${hash(raw)} output=${output} state=${state} actions=${config} ${diagnostics}`);
  return { ...observed, output: raw.toString("utf8"), raw, log: output, statePath: state };
}
export function restored(run: PtyState, pendinException = false) {
  assert.equal(run.timeout, false, `timeout at action ${run.actions}/${run.totalActions}`);
  assert.equal(run.actions, run.totalActions, "every required UI checkpoint must be reached");
  if (!pendinException || run.platform !== "darwin") assert.equal(run.exact, true, JSON.stringify(run));
  else {
    for (const index of [0, 1, 2, 4, 5, 6]) assert.deepEqual(run.after[index], run.before[index]);
    assert.ok(run.xor[3] === 0 || run.xor[3] === 0x20000000, JSON.stringify(run));
    assert.equal((run.after[3] as number) & ~0x20000000, (run.before[3] as number) & ~0x20000000);
  }
}
export function editRoute(): Step[] { return [{ wait: "Manage saved resources", text: "\r" }, { wait: "Select saved resource", text: "\r" }, { wait: "Resource action", text: `${down}\r` }, { wait: "Select saved file", text: "\r" }]; }
export const finish: Step = { wait: "◆  Manage saved resources", text: "\x03" };
export const manage = (b: Box, steps: Step[]) => pty(b, [process.execPath, ...sourceNodeFlags, cli, "manage"], steps);

export async function editor(initial: string, steps: Step[], extra = "", canonical = false, pendinException = false, size: [number, number] = [14, 72]) {
  const b = await box(), initialFile = path.join(b.root, "initial.bin"), resultFile = path.join(b.root, "result.json");
  await writeFile(initialFile, initial);
  const module = terminalEditorModule;
  const code = `import {readFile,writeFile} from 'node:fs/promises';
import {editTerminalText} from ${JSON.stringify(module)};
const counts=()=>['data','end','close','error'].map(e=>process.stdin.listenerCount(e)).concat(['SIGINT','SIGTERM','SIGHUP'].map(e=>process.listenerCount(e)),['resize','error'].map(e=>process.stdout.listenerCount(e)));
const before=counts(); const rawBefore=process.stdin.isRaw; const flowBefore=process.stdin.readableFlowing; const timersBefore=process.getActiveResourcesInfo().filter(r=>r==='Timeout').length;
const initial=await readFile(${JSON.stringify(initialFile)},'utf8');
${extra}
const result=await editTerminalText(initial); const after=counts(); const flowAfter=process.stdin.readableFlowing;
let canonical;
if(${canonical}) { process.stdout.write('CANONICAL_READY'); canonical=await new Promise(resolve=>{process.stdin.once('data',chunk=>{process.stdin.pause();resolve(chunk.toString())});process.stdin.resume()}); process.stdout.write('CANONICAL_DONE'); }
await new Promise(resolve=>setTimeout(resolve,150));
await writeFile(${JSON.stringify(resultFile)},JSON.stringify({result,before,after,rawBefore,rawAfter:process.stdin.isRaw,flowBefore,flowAfter,canonical,timersBefore,timersAfter:process.getActiveResourcesInfo().filter(r=>r==='Timeout').length}));`;
  const run = await pty(b, [process.execPath, ...sourceNodeFlags, "--input-type=module", "-e", code], steps, "tty", size);
  restored(run, pendinException); assert.equal(run.code, 0, run.output);
  const saved = JSON.parse(await readFile(resultFile, "utf8")) as { result: { kind: string; text?: string }; before: number[]; after: number[]; rawBefore: boolean; rawAfter: boolean; flowBefore: boolean | null; flowAfter: boolean | null; canonical?: string; timersBefore: number; timersAfter: number };
  assert.deepEqual(saved.after, saved.before, "all editor listeners restored"); assert.equal(saved.rawAfter, Boolean(saved.rawBefore));
  assert.notEqual(saved.flowAfter, true, "editor must restore nonflowing input");
  assert.equal(saved.timersAfter, saved.timersBefore, "editor redraw/Esc timers must not remain");
  assert.ok(run.output.includes("\x1b[?2004l\x1b[?1049l\x1b[?25h"), "paste/alternate/cursor cleanup");
  assert.ok(!run.output.slice(run.output.indexOf("\x1b[?1049l")).includes(initial) || initial === "", "no body dump after leaving editor");
  return { ...saved, ...run, resultFile, b };
}
