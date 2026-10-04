import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPreparedResource, loadCatalog, prepareResource, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { duplicateFixture, sandbox, type Sandbox } from "./helpers/sandbox.ts";
import { runTerminalPty, type TerminalAction } from "./helpers/terminal-editor.ts";

const cli = new URL("../src/cli.js", import.meta.url).pathname;
const down = "\u001b[B";
async function fixture(t: test.TestContext, bytes: string | Buffer = "\ufeffold\r\ne\u0301 日本語\r\n", name = "Friendly resource") {
  const box = await sandbox(t);
  const sourcePath = path.join(box.sourceRoot, "skill");
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, "SKILL.md"), bytes);
  const prepared = await prepareResource({id:"source",name,kind:"skill",source:"local",scope:"project",sourceRoot:box.sourceRoot,sourcePath,destination:{kind:"project",path:".pi/skills/friendly"}});
  const inspection = await inspectPreparedResource(prepared);
  const item = await importPreparedResource(box.libraryDir, prepared, {confirmed:true,groupIds:[],inspection,approvedSensitivePaths:inspection.sensitivePaths});
  assert.ok(item);
  const catalog = await loadCatalog(box.libraryDir);
  catalog.groups.push({id:"a124842e-1872-4cc0-a267-935c6b8a19f1",name:"Friendly group",itemIds:[item.id]});
  await saveCatalog(box.libraryDir, catalog);
  return {...box,item,file:path.join(box.libraryDir,"items",item.id,"files","SKILL.md"),sourceFile:path.join(sourcePath,"SKILL.md")};
}
async function custody(box: Awaited<ReturnType<typeof fixture>>) {
  return {catalog:await readFile(path.join(box.libraryDir,"catalog.json")),file:await readFile(box.file),source:await readFile(box.sourceFile)};
}
async function manage(box: Sandbox, actions: TerminalAction[]) {
  return runTerminalPty(box, [process.execPath,cli,"manage"], actions);
}
function editActions(): TerminalAction[] {
  return [
    {waitFor:"Manage saved resources",send:"\r"},
    {waitFor:"Select saved resource",send:"\r"},
    {waitFor:"Resource action",send:`${down}\r`},
    {waitFor:"Select saved file",send:"\r"},
  ];
}
const finish: TerminalAction = {waitFor:"Manage saved resources",send:"\u0003"};

test("U1 real manage selects resource by name/kind/group/destination and masked file view never exposes IDs", async (t) => {
  const secret = "sk_live_syntheticsecret12345";
  const box = await fixture(t, `apiKey: ${secret}\n`);
  const before = await custody(box);
  const run = await manage(box, [
    {waitFor:"Manage saved resources",send:"\r"}, {waitFor:"Select saved resource",send:"\r"},
    {waitFor:"Resource action",send:"\r"}, {waitFor:"Select saved file",send:"\r"}, finish,
  ]);
  assert.equal(run.code,0,run.output);
  assert.match(run.output, /Friendly resource|skill/);
  assert.match(run.output, /Friendly group/);
  assert.match(run.output, /\.pi\/skills\/friendly/);
  assert.match(run.output, /REDACTED/);
  assert.ok(!run.output.includes(secret));
  for (const id of [box.item.id,"a124842e-1872-4cc0-a267-935c6b8a19f1"]) assert.ok(!run.output.includes(id));
  assert.deepEqual(await custody(box),before);
});

test("U1 rename is confirmed separately and preserves identity/reference/body/destination/saved paths", async (t) => {
  const box = await fixture(t); const before = await custody(box); const catalog = await loadCatalog(box.libraryDir);
  const run = await manage(box, [
    {waitFor:"Manage saved resources",send:"\r"}, {waitFor:"Select saved resource",send:"\r"},
    {waitFor:"Resource action",send:`${down.repeat(2)}\r`}, {waitFor:"New display name",send:"New friendly name\r"},
    {waitFor:"Save display name",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  const after = await loadCatalog(box.libraryDir);
  assert.deepEqual(after.items,[{...box.item,name:"New friendly name"}]);
  assert.deepEqual(after.groups,catalog.groups);
  assert.deepEqual(await readFile(box.file),before.file);
  assert.deepEqual(await readFile(box.sourceFile),before.source);
});

test("U1 destination changes separately without renaming or rewriting the body", async (t) => {
  const box = await fixture(t); const before = await custody(box);
  const run = await manage(box, [
    {waitFor:"Manage saved resources",send:"\r"}, {waitFor:"Select saved resource",send:"\r"},
    {waitFor:"Resource action",send:`${down.repeat(3)}\r`},
    {waitFor:"Destination kind",send:"\r"}, {waitFor:"New project-relative destination",send:".pi/skills/new-place\r"},
    {waitFor:"Save destination",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  assert.deepEqual((await loadCatalog(box.libraryDir)).items,[{...box.item,destination:{kind:"project",path:".pi/skills/new-place"}}]);
  assert.deepEqual(await readFile(box.file),before.file);
  assert.deepEqual(await readFile(box.sourceFile),before.source);
});

test("U2 manage group manager saves membership/name through the existing revision-bound API", async (t) => {
  const box = await fixture(t);
  const run = await manage(box, [
    {waitFor:"Manage saved resources",send:`${down}\r`},
    {waitFor:"Manage saved groups",send:`${down}\r`}, {waitFor:"Select group",send:"\r"},
    {waitFor:"New name for",send:"Renamed group\r"},
    {waitFor:"Manage saved groups",send:`${down.repeat(3)}\r`}, {waitFor:"Save these group changes",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  const group = (await loadCatalog(box.libraryDir)).groups[0]!;
  assert.equal(group.name,"Renamed group"); assert.deepEqual(group.itemIds,[box.item.id]);
  assert.ok(!run.output.includes(group.id));
});

test("U2 manage apply chooses group and target without ID input and retains secret approval", async (t) => {
  const box = await fixture(t,"apiKey: sk_live_syntheticsecret12345\n");
  const run = await manage(box, [
    {waitFor:"Manage saved resources",send:`${down.repeat(2)}\r`},
    {waitFor:"Select group to apply",send:"\r"}, {waitFor:"Apply target directory",send:"\r"},
    {waitFor:"Apply suspected sensitive file",send:"y\r"}, {waitFor:"Apply the selected snapshots",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  assert.deepEqual(await readFile(path.join(box.projectDir,".pi/skills/friendly/SKILL.md")),await readFile(box.file));
  assert.ok(!run.output.includes(box.item.id)); assert.ok(!run.output.includes("sk_live_syntheticsecret12345"));
});

test("U1/U7 empty manage can enter existing setup scope consent without creating a library", async (t) => {
  const box = await sandbox(t);
  const run = await manage(box,[
    {waitFor:"Manage saved resources",send:`${down.repeat(2)}\r`},
    {waitFor:"Choose the locations",send:"\u0003"}, finish,
  ]);
  assert.equal(run.code,0,run.output);
  await assert.rejects(readFile(path.join(box.libraryDir,"catalog.json")),{code:"ENOENT"});
});

test("U1 duplicate gate offers only masked view and explicit resolution, never ordinary changes/apply", async (t) => {
  const box = await sandbox(t); const {first} = await duplicateFixture(box);
  const before = await readFile(path.join(box.libraryDir,"catalog.json"));
  const run = await manage(box,[
    {waitFor:"Manage saved resources",send:"\r"}, {waitFor:"Select saved resource",send:"\r"},
    {waitFor:"Resource action",send:"\r"}, {waitFor:"Select saved file",send:"\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  assert.match(run.output,/Duplicate names/);
  for (const label of ["Edit saved text","Rename display name","Change destination","Setup copied resources","Apply group","Manage groups"]) assert.ok(!run.output.includes(label),label);
  assert.ok(!run.output.includes(first.id)); assert.ok(!run.output.includes("sk_live_syntheticsecret12345"));
  assert.deepEqual(await readFile(path.join(box.libraryDir,"catalog.json")),before);
});

test("U1 manage explicit conflict resolution preserves saved body and group references", async (t) => {
  const box = await sandbox(t); const {first,catalog} = await duplicateFixture(box);
  const before = await readSnapshotFiles(box.libraryDir,first);
  const run = await manage(box,[
    {waitFor:"Manage saved resources",send:`${down}\r`},
    {waitFor:"Select a conflicting name",send:"\r"},{waitFor:"New name",send:"Distinct item\r"},
    {waitFor:"Select a conflicting name",send:"\r"},{waitFor:"New name",send:"Distinct group\r"},
    {waitFor:"Save these name changes",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  const after = await loadCatalog(box.libraryDir);
  assert.deepEqual(after.items,catalog.items.map(item=>item.id===first.id?{...item,name:"Distinct item"}:item));
  assert.deepEqual(after.groups,catalog.groups.map(g=>g.id==="daily"?{...g,name:"Distinct group"}:g));
  assert.deepEqual(await readSnapshotFiles(box.libraryDir,first),before);
});

for (const stage of ["raw denied","raw cancelled","editor Ctrl-C","editor EOF key","editor SIGTERM","diff denied","save denied","secret save denied"] as const) {
  test(`U5/U6 ${stage} keeps raw catalog, all snapshot and source bytes unchanged`, async (t) => {
    const secret = "sk_live_syntheticsecret12345";
    const box = await fixture(t,`apiKey: ${secret}\r\n`); const before = await custody(box);
    const actions = editActions();
    actions.push({waitFor:"Expose raw text",send:stage==="raw denied"?"n\r":stage==="raw cancelled"?"\u0003":"y\r"});
    if (!stage.startsWith("raw")) {
      actions.push({waitFor:"Ctrl-S",send:stage==="editor Ctrl-C"?"changed\u0003":stage==="editor EOF key"?"changed\u0004":stage==="editor SIGTERM"?"changed":"new\r\u0013"});
      if(stage==="editor SIGTERM") actions.push({signal:"SIGTERM"});
      if(!stage.startsWith("editor")) {
        actions.push({waitFor:"Approve this masked diff",send:stage==="diff denied"?"n\r":"y\r"});
        if(stage!=="diff denied") {
          actions.push({waitFor:"Save suspected sensitive file",send:stage==="secret save denied"?"n\r":"y\r"});
          if(stage!=="secret save denied") actions.push({waitFor:"Save edited",send:"n\r"});
        }
      }
    }
    if(stage.endsWith("denied")) actions.push(finish);
    const run = await manage(box,actions);
    assert.equal(run.code,0,run.output); assert.match(run.output,/PTY_TERMIOS_RESTORED=True/);
    assert.deepEqual(await custody(box),before);
    if(stage.startsWith("raw")) {assert.ok(!run.output.includes("Ctrl-S"));assert.ok(!run.output.includes(secret));}
  });
}

test("U5/U6 fixed diff and new secret approval precede real commit; bytes/hash/source consistency", async (t) => {
  const box = await fixture(t,"old\n"); const source = await readFile(box.sourceFile);
  const text = "apiKey: sk_live_newsecret123456\n日本語\n\n";
  const run = await manage(box,[...editActions(),
    {waitFor:"Ctrl-S",send:`\u001b[1;5F\u001b[200~${text}\u001b[201~\u0013`},
    {waitFor:"Approve this masked diff",send:"y\r"},
    {waitFor:"Save suspected sensitive file",send:"y\r"}, {waitFor:"Save edited",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  assert.ok(run.output.indexOf("Bytes changed") < run.output.indexOf("Save suspected sensitive file"));
  assert.match(run.output,/REDACTED/);
  const expected = Buffer.from(`old\n${text}`);
  assert.deepEqual(await readFile(box.file),expected);
  assert.equal((await loadCatalog(box.libraryDir)).items[0]!.files[0]!.sha256,createHash("sha256").update(expected).digest("hex"));
  assert.deepEqual(await readFile(box.sourceFile),source);
  console.log(`saved bytes=${expected.toString("hex")}`);
});

test("U6 no-op preserves exact raw bytes including BOM/CRLF/NFD with no save prompt", async (t) => {
  const box = await fixture(t); const before = await custody(box);
  const run = await manage(box,[...editActions(),{waitFor:"Ctrl-S",send:"\u0013"},finish]);
  assert.equal(run.code,0,run.output); assert.match(run.output,/No byte changes/);
  assert.ok(!run.output.includes("Save edited")); assert.deepEqual(await custody(box),before);
});

for(const [name,bytes,reason] of [
  ["NUL",Buffer.from([65,0]),/binary|NUL/i], ["invalid encoding",Buffer.from([0xff]),/encoding|UTF-8/i],
  ["too large",Buffer.alloc(1_000_001,65),/1_000_000|1 MB|limit/i],
] as const) {
  test(`U4 ${name} is selectable but rejected with a reason before editor/raw exposure`,async(t)=>{
    const box=await fixture(t,bytes); const before=await custody(box);
    const run=await manage(box,editActions());
    assert.equal(run.code,1,run.output); assert.match(run.output,reason); assert.ok(!run.output.includes("Ctrl-S"));
    assert.deepEqual(await custody(box),before);
  });
}

test("U4 edited content over 1MB is rejected before review and preserves bytes",async(t)=>{
  const box=await fixture(t,Buffer.alloc(1_000_000,65)); const before=await custody(box);
  const run=await manage(box,[...editActions(),{waitFor:"Ctrl-S",send:"B\u0013"}]);
  assert.equal(run.code,1,run.output); assert.match(run.output,/1_000_000|1 MB|limit/i);
  assert.deepEqual(await custody(box),before);
});

test("U4 saved symlink is refused with safe reason and no editor",async(t)=>{
  const box=await fixture(t);
  const {rename}=await import("node:fs/promises"); await rename(box.file,`${box.file}.original`); await symlink(box.sourceFile,box.file);
  const catalog=await readFile(path.join(box.libraryDir,"catalog.json"));
  const run=await manage(box,editActions());
  assert.equal(run.code,1,run.output); assert.match(run.output,/symbolic|symlink/i);
  assert.ok(!run.output.includes(box.item.id)); assert.ok(!run.output.includes("Ctrl-S"));
  assert.deepEqual(await readFile(path.join(box.libraryDir,"catalog.json")),catalog);
});

test("U5 labels/paths/body mask secrets and escape OSC/control sequences without rewriting saved data",async(t)=>{
  const box=await fixture(t,"hello\u001b]52;c;CLIPBOARD_ATTACK\u0007\napiKey: sk_live_syntheticsecret12345\n","name sk_live_labelsecret123456\u001b]0;TITLE_ATTACK\u0007");
  const before=await custody(box);
  const run=await manage(box,[{waitFor:"Manage saved resources",send:"\r"},{waitFor:"Select saved resource",send:"\r"},{waitFor:"Resource action",send:"\r"},{waitFor:"Select saved file",send:"\r"},finish]);
  assert.equal(run.code,0,run.output); assert.ok(!run.output.includes("\u001b]52")); assert.ok(!run.output.includes("\u001b]0;TITLE_ATTACK"));
  assert.ok(!run.output.includes("sk_live_labelsecret123456")); assert.ok(!run.output.includes("sk_live_syntheticsecret12345"));
  assert.deepEqual(await custody(box),before);
});

for (const mode of ["stdin-pipe", "stdout-pipe"] as const) {
  test(`U7 ${mode} manage refuses before reading/creating/searching the library`,async(t)=>{
    const box=await sandbox(t);
    const run=await runTerminalPty(box,[process.execPath,cli,"manage"],[],[12,60],mode);
    assert.equal(run.code,1,run.output); assert.match(run.output,/TTY/);
    await assert.rejects(readFile(path.join(box.libraryDir,"catalog.json")),{code:"ENOENT"});
    assert.ok(!run.output.includes("Manage saved resources"));
  });
}

test("U4 empty registered UTF-8 file opens and submits no-op without creating content",async(t)=>{
  const box=await fixture(t,""); const before=await custody(box);
  const run=await manage(box,[...editActions(),{waitFor:"Ctrl-S",send:"\u0013"},finish]);
  assert.equal(run.code,0,run.output); assert.deepEqual(await custody(box),before);
});

test("U5 changed secrets with identical masked diff still show byte change and require new individual save approval",async(t)=>{
  const box=await fixture(t,"apiKey: sk_live_oldsecret123456\n"); const before=await custody(box);
  const next="apiKey: sk_live_newsecret123456\n";
  const run=await manage(box,[...editActions(),{waitFor:"Expose raw text",send:"y\r"},
    {waitFor:"Ctrl-S",send:`\u001b[1;5H\u001b[3~`.repeat(32)+`\u001b[200~${next}\u001b[201~\u0013`},
    {waitFor:"Approve this masked diff",send:"y\r"},{waitFor:"Save suspected sensitive file",send:"n\r"},finish,
  ]);
  assert.equal(run.code,0,run.output); assert.match(run.output,/Bytes changed/); assert.match(run.output,/new approval/);
  assert.deepEqual(await custody(box),before);
  const afterEditor=run.output.slice(run.output.indexOf("\u001b[?1049l"));
  assert.ok(!afterEditor.includes("sk_live_oldsecret123456")); assert.ok(!afterEditor.includes("sk_live_newsecret123456"));
});

test("U6 every separated masked diff hunk including the last is shown before any save approval",async(t)=>{
  const original=Array.from({length:120},(_,i)=>`line ${i}\n`).join("");
  const box=await fixture(t,original); const before=await custody(box);
  const next=original.replace("line 0\n","FIRST_CHANGE\n").replace("line 60\n","MIDDLE_CHANGE\n").replace("line 119\n","LAST_CHANGE\n");
  const run=await manage(box,[...editActions(),{waitFor:"Ctrl-S",send:"\u001b[1;5H"+"\u001b[3~".repeat(original.length)+`\u001b[200~${next}\u001b[201~\u0013`},
    {waitFor:"Approve this masked diff",send:"n\r"},finish,
  ]);
  assert.equal(run.code,0,run.output);
  const diff=run.output.slice(run.output.indexOf("Full masked saved diff"),run.output.indexOf("Approve this masked diff"));
  for(const line of ["+FIRST_CHANGE","+MIDDLE_CHANGE","+LAST_CHANGE"]) assert.ok(diff.includes(line),line);
  assert.equal((diff.match(/@@ /g)??[]).length,3); assert.deepEqual(await custody(box),before);
});

for(const mutation of ["catalog", "body"] as const) {
  test(`U6 external ${mutation} change while editor waits rejects stale save and preserves external bytes`,async(t)=>{
    const box=await fixture(t,"old\n"); const before=await custody(box);
    const changed=mutation==="catalog"?` ${before.catalog.toString()}`:"external body\n";
    const run=await manage(box,[...editActions(),{waitFor:"Ctrl-S",replaceFile:{path:mutation==="catalog"?path.join(box.libraryDir,"catalog.json"):box.file,text:changed},send:"new\u0013"},
      {waitFor:"Approve this masked diff",send:"y\r"},{waitFor:"Save edited",send:"y\r"},
    ]);
    assert.equal(run.code,1,run.output); assert.match(run.output,/changed|checksum|revision/i); assert.ok(!run.output.includes(box.item.id));
    assert.deepEqual(await readFile(box.file),mutation==="body"?Buffer.from(changed):before.file);
    assert.deepEqual(await readFile(path.join(box.libraryDir,"catalog.json")),mutation==="catalog"?Buffer.from(changed):before.catalog);
    assert.deepEqual(await readFile(box.sourceFile),before.source);
  });
}

for(const stop of ["Ctrl-C", "Ctrl-D", "SIGTERM"] as const) {
  test(`U6 ${stop} at final save prompt cannot commit and restores TTY`,async(t)=>{
    const box=await fixture(t,"old\n"); const before=await custody(box);
    const action:TerminalAction=stop==="SIGTERM"?{waitFor:"Save edited",signal:"SIGTERM"}:{waitFor:"Save edited",send:stop==="Ctrl-C"?"\u0003":"\u0004"};
    const run=await manage(box,[...editActions(),{waitFor:"Ctrl-S",send:"new\u0013"},{waitFor:"Approve this masked diff",send:"y\r"},action]);
    assert.equal(run.code,0,run.output); assert.match(run.output,/PTY_TERMIOS_RESTORED=True/); assert.deepEqual(await custody(box),before);
  });
}

for (const operation of ["rename", "placement"] as const) {
  test(`F1/F2 ${operation} approval is bound to original raw catalog revision even for whitespace-only external changes`,async(t)=>{
    const box=await fixture(t); const before=await custody(box);
    const external=` ${before.catalog.toString()}`;
    const actions:TerminalAction[]=[
      {waitFor:"Manage saved resources",send:"\r"},{waitFor:"Select saved resource",send:"\r"},
      {waitFor:"Resource action",send:`${down.repeat(operation==="rename"?2:3)}\r`},
      ...(operation==="rename"?[{waitFor:"New display name",send:"Pending name\r"}]:[
        {waitFor:"Destination kind",send:"\r"},{waitFor:"New project-relative destination",send:".pi/skills/pending\r"},
      ]),
      {waitFor:operation==="rename"?"Save display name":"Save destination",replaceFile:{path:path.join(box.libraryDir,"catalog.json"),text:external},send:"y\r"},
    ];
    const run=await manage(box,actions);
    assert.equal(run.code,1,run.output); assert.match(run.output,/changed|revision|reload/i);
    assert.deepEqual(await readFile(path.join(box.libraryDir,"catalog.json")),Buffer.from(external));
    assert.deepEqual(await readFile(box.file),before.file); assert.deepEqual(await readFile(box.sourceFile),before.source);
    assert.match(run.output,/PTY_TERMIOS_RESTORED=True/);
  });
}

test("F3 literal pasted control bytes survive manage review/commit while standalone control cancellation remains separate",async(t)=>{
  const box=await fixture(t,"old\n"); const before=await custody(box);
  const pasted="literal\u0004\u0003\u0013\n\n日本語\n";
  const run=await manage(box,[...editActions(),
    {waitFor:"Ctrl-S",send:`\u001b[200~${pasted}\u001b[201~\u0013`},
    {waitFor:"Approve this masked diff",send:"y\r"},{waitFor:"Save edited",send:"y\r"},finish,
  ]);
  assert.equal(run.code,0,run.output); assert.match(run.output,/PTY_TERMIOS_RESTORED=True/);
  assert.deepEqual(await readFile(box.file),Buffer.from(`${pasted}old\n`));
  assert.deepEqual(await readFile(box.sourceFile),before.source);
  assert.match(run.output,/\\u0004/); assert.match(run.output,/\\u0003/); assert.match(run.output,/\\u0013/);
});
