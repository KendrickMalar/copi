import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCatalog, readSnapshotFiles, saveCatalog } from "../src/catalog.ts";
import { commitRefresh, discoverRefreshOrigin, prepareRefresh, readRefresh, resolveRefreshPath, type PreparedRefresh } from "../src/refresh.ts";
import { StorageTransactions, storageTransactions, type StorageCheckpoint } from "../src/storage-transaction.ts";
import type { ResourceCandidate } from "../src/types.ts";
import { approval, at, contract, down, enter, evidence, finish, fixture, hash, manage, packageFixture, plain, tree } from "./helpers/issue4-acceptance.ts";

// Independent acceptance oracles fixed BEFORE execution: full snapshot replacement,
// exact prepared bytes/modes, identity+all memberships preserved, fail closed on
// unauthorized provenance/tamper, and byte-for-byte old/external state on rejection.
test("R1/R3 fixed whole snapshot, all separated hunks/add/delete/binary/mode; preserve identity and original", async () => {
  const oldText = Array.from({length: 90}, (_, i) => `old line ${i}`).join("\n") + "\n";
  const b = await fixture({ "SKILL.md": oldText, "remove.md": "copi-only\n", "asset.bin": Buffer.from([0,1,2,3]) });
  const lines = oldText.split("\n"); for (const n of [0,35,78]) lines[n] = `new independent line ${n}`;
  const expected = Buffer.from(lines.join("\n"));
  const source = await b.replacement({ "SKILL.md": expected, "add.md": "# Original embedded name\n", "asset.bin": Buffer.from([0,9,8]) }); await chmod(path.join(source.sourcePath,"add.md"),0o751);
  const before = await loadCatalog(b.library), p = await prepareRefresh(b.library,b.item.id,source), v = readRefresh(p);
  assert.deepEqual(v.diffs.map(d=>d.path), ["SKILL.md","add.md","asset.bin","remove.md"]);
  for(const n of [0,35,78]) { assert.ok(v.diffs[0]!.diff.includes(`-old line ${n}`)); assert.ok(v.diffs[0]!.diff.includes(`+new independent line ${n}`)); }
  assert.match(v.diffs.find(d=>d.path==="asset.bin")!.summary,/4 → 3 bytes/);
  assert.match(v.diffs.find(d=>d.path==="add.md")!.summary,/absent → 751/);
  assert.match(v.diffs.find(d=>d.path==="remove.md")!.summary,/→ 0 bytes; mode .* → absent/);
  await writeFile(path.join(source.sourcePath,"SKILL.md"),"later unapproved original bytes\n");
  const originals = await tree(b.source); const returned = await commitRefresh(p,approval(p));
  const c = await loadCatalog(b.library), item = c.items[0]!;
  for(const key of contract.preserve) assert.deepEqual(item[key as keyof typeof item], b.item[key as keyof typeof b.item]);
  assert.deepEqual(c.groups,before.groups); assert.equal(item.source,"explicit-refresh-path"); assert.equal(item.scope,"shared");
  assert.deepEqual((await readSnapshotFiles(b.library,item)).find(f=>f.path==="SKILL.md")!.bytes,expected);
  assert.equal((await lstat(b.saved("add.md"))).mode&0o777,0o600); assert.equal(await lstat(b.saved("remove.md")).then(()=>true,()=>false),false);
  for(const descriptor of [v.item,returned,item]) assert.equal(descriptor.files.find(f=>f.path==="add.md")!.mode,0o751);
  assert.equal((await readSnapshotFiles(b.library,item)).find(f=>f.path==="add.md")!.mode,0o751);
  await executeApply(b.library,await planApply(b.library,"alpha",b.cwd),{});
  const applied=await appliedFiles(b,{"add.md":{bytes:Buffer.from("# Original embedded name\n"),mode:0o751}});
  for(const file of await readSnapshotFiles(b.library,item)) assert.equal(file.sha256,hash(file.bytes));
  assert.deepEqual(await tree(b.source), originals); await evidence(b,"fixed-whole-snapshot",{expectedHash:hash(expected),diffs:v.diffs,privateMode:0o600,descriptorMode:0o751,applied});
});

for(const variant of ["masked-same", "mode-only", "metadata-only"] as const) test(`R1 ${variant} cannot disappear as no-op; must commit only approved fixed snapshot`,async()=>{
  const b=await fixture({"SKILL.md":"apiKey: sk_live_OLDindependentsecret12345\n"});
  const content=variant==="masked-same"?"apiKey: sk_live_NEWindependentsecret67890\n":"apiKey: sk_live_OLDindependentsecret12345\n";
  const source=await b.replacement({"SKILL.md":content}); if(variant==="mode-only") await chmod(path.join(source.sourcePath,"SKILL.md"),0o700);
  const before=await tree(b.library), p=await prepareRefresh(b.library,b.item.id,source), v=readRefresh(p);
  assert.ok(!JSON.stringify(v.diffs).includes("sk_live_")); assert.deepEqual(v.sensitivePaths,["SKILL.md"]);
  if(variant!=="masked-same") assert.equal(v.bytesChanged,false); else assert.equal(v.bytesChanged,true);
  await assert.rejects(commitRefresh(p,{...approval(p),confirmed:false})); assert.deepEqual(await tree(b.library),before);
  const originals=variant==="mode-only"?await tree(b.source):undefined;
  const returned=await commitRefresh(p,approval(p)); assert.equal(await readFile(b.saved("SKILL.md"),"utf8"),content);
  assert.equal((await loadCatalog(b.library)).items[0]!.sourcePath,source.sourcePath);
  if(variant==="mode-only") {
    assert.equal((await lstat(b.saved("SKILL.md"))).mode&0o777,0o600);
    const expected={"SKILL.md":{bytes:Buffer.from(content),mode:0o700}},layers=await modeLayers(b,expected,v,returned);
    await executeApply(b.library,await planApply(b.library,"alpha",b.cwd),{secretApprovals:[".pi/skills/retained/SKILL.md"]});
    const applied=await appliedFiles(b,expected); assert.deepEqual(await tree(b.source),originals);
    await evidence(b,variant,{diffs:v.diffs,layers,applied});
  } else await evidence(b,variant,{diffs:v.diffs});
});

test("R5 detached every view, metadata/arrays/warnings/diffs, candidate mutation cannot replace fixed bytes",async()=>{
  const b=await fixture(), source=await b.replacement({"SKILL.md":"apiKey: sk_live_IndependentAAA123456\n","two.md":"password: IndependentBBB123456\n","auth/blocked.md":"blocked\n"});
  const p=await prepareRefresh(b.library,b.item.id,source), v=readRefresh(p), stable=readRefresh(p);
  source.sourcePath=b.sourcePath; source.destination={kind:"global-only"}; source.name="tampered";
  v.item.name="tampered"; v.item.files.splice(0); v.originalCatalog.groups.splice(0); v.source.sourcePath=b.sourcePath;
  (v.sensitivePaths as string[]).splice(0); (v.excludedPaths as string[]).splice(0); (v.warnings as unknown[]).splice(0); (v.diffs as unknown[]).splice(0);
  assert.deepEqual(readRefresh(p),stable); const before=await tree(b.library);
  await assert.rejects(commitRefresh(p,{reviewId:p.reviewId,confirmed:true,approvedSensitivePaths:[]})); assert.deepEqual(await tree(b.library),before);
  await commitRefresh(p,approval(p)); assert.match(await readFile(b.saved("SKILL.md"),"utf8"),/IndependentAAA/); assert.equal((await loadCatalog(b.library)).items[0]!.name,b.item.name);
  await assert.rejects(commitRefresh(p,approval(p)),/already/); await evidence(b,"detached-views");
});

for(const kind of ["false","string","number","missing","wrong-review","missing-secret","one-secret","duplicate","extra"])
 test(`R5 rejection ${kind} retains exact FS`,async()=>{
  const b=await fixture(), source=await b.replacement({"SKILL.md":"token: sk_live_Independent111111111\n","b.md":"password: Independent222222222\n"}), p=await prepareRefresh(b.library,b.item.id,source);
  assert.deepEqual([...readRefresh(p).sensitivePaths].sort(),["SKILL.md","b.md"]);
  const a:any=approval(p); if(kind==="false")a.confirmed=false;if(kind==="string")a.confirmed="true";if(kind==="number")a.confirmed=1;if(kind==="missing")delete a.confirmed;
  if(kind==="wrong-review")a.reviewId="fake";if(kind==="missing-secret")delete a.approvedSensitivePaths;if(kind==="one-secret")a.approvedSensitivePaths=["SKILL.md"];if(kind==="duplicate")a.approvedSensitivePaths=["SKILL.md","SKILL.md"];if(kind==="extra")a.approvedSensitivePaths.push("other.md");
  const before=await tree(b.library), originals=await tree(b.source);await assert.rejects(commitRefresh(p,a));assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);
 });

for(const token of ["clone","view","fake","proxy","prototype"])
 test(`R5 opaque refresh token ${token} rejected at actual API/FS`,async()=>{
  const b=await fixture(),p=await prepareRefresh(b.library,b.item.id,await b.replacement({"SKILL.md":"new\n"}));
  const forged=token==="clone"?structuredClone(p):token==="view"?readRefresh(p):token==="proxy"?new Proxy(p,{}):token==="prototype"?Object.create(p):{reviewId:p.reviewId};
  const before=await tree(b.library);await assert.rejects(commitRefresh(forged as PreparedRefresh,approval(p)),/token/);assert.deepEqual(await tree(b.library),before);
 });

test("R5 review cannot be reused across different preparations",async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"first\n"}),a=await prepareRefresh(b.library,b.item.id,s);await writeFile(path.join(s.sourcePath,"SKILL.md"),"second\n");const c=await prepareRefresh(b.library,b.item.id,s),before=await tree(b.library);assert.notEqual(a.reviewId,c.reviewId);await assert.rejects(commitRefresh(c,approval(a)),/review/);assert.deepEqual(await tree(b.library),before);
});

for(const component of ["auth","auth.json","mcp-auth.json","oauth.json",".env.local","cache","history","sessions","node_modules"])
 test(`R2/R5 manual scope+fake package label cannot authorize ${component}`,async()=>{
  const b=await fixture(),s=await b.replacement({"SKILL.md":"safe\n"});const target=path.join(b.source,component,"selected");await mkdir(target,{recursive:true});await writeFile(path.join(target,"SKILL.md"),"forbidden ancestor bytes\n");s.sourcePath=target;s.sourceRoot=path.dirname(target);s.scope="package";s.source="package:npm:declared-r4";
  const before=await tree(b.library);await assert.rejects(prepareRefresh(b.library,b.item.id,s),/private|excluded/);assert.deepEqual(await tree(b.library),before);
 });

test("R5 nested exclusion applies to full skill; auth/.env/cache/node_modules never stored",async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"safe\n","auth/a.md":"private",".env.dev":"private","cache/x":"private","node_modules/x":"private"}),p=await prepareRefresh(b.library,b.item.id,s);
 assert.deepEqual([...readRefresh(p).excludedPaths].sort(),[".env.dev","auth","cache","node_modules"]);await commitRefresh(p,approval(p));assert.deepEqual((await loadCatalog(b.library)).items[0]!.files.map(f=>f.path),["SKILL.md"]);await evidence(b,"excluded-files");
});

for(const location of ["ancestor","leaf","interior"]) test(`R2/R5 symlink ${location} cannot gain OS-prefix exception`,async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"safe\n"}),before=await tree(b.library);
 if(location==="interior")await symlink(b.sourcePath,path.join(s.sourcePath,"linked"));else {const link=path.join(b.source,"alias");await symlink(location==="leaf"?s.sourcePath:b.source,link);s.sourcePath=location==="leaf"?link:path.join(link,path.basename(s.sourcePath));s.sourceRoot=b.source;}
 await assert.rejects(prepareRefresh(b.library,b.item.id,s),/symbolic/i);assert.deepEqual(await tree(b.library),before);
});

test("R2 physical OS prefix resolves exactly; unsafe/relative/escaped/kind/shape fail",async()=>{
 const b=await fixture();assert.equal(await resolveRefreshPath(b.sourcePath),b.sourcePath);
 for(const input of ["relative",`${b.sourcePath}\\bad`,`${b.sourcePath}\0bad`]) await assert.rejects(resolveRefreshPath(input));
 const s=await b.replacement({"SKILL.md":"new\n"}),before=await tree(b.library);
 for(const bad of [{...s,sourceRoot:b.cwd},{...s,kind:"subagent" as const},{...s,sourcePath:path.join(s.sourcePath,"SKILL.md")}])await assert.rejects(prepareRefresh(b.library,b.item.id,bad));assert.deepEqual(await tree(b.library),before);
 if(process.platform==="darwin")assert.equal(await resolveRefreshPath(b.sourcePath.replace(/^\/private\/tmp/,"/tmp")),b.sourcePath);
});

for(const kind of ["model-config","keybindings"] as const) test(`R5 reference-only ${kind} rejects candidate project promotion`,async()=>{
 const b=await fixture({"models.json":"{}\n"},kind),s=await b.replacement({"new.json":"{}\n"},{destination:{kind:"project",path:".pi/models.json"}}),before=await tree(b.library);await assert.rejects(prepareRefresh(b.library,b.item.id,s),/Reference/);assert.deepEqual(await tree(b.library),before);
});

test("R2 declared npm positive, explicit scopes and current declaration absence",async()=>{
 const b=await packageFixture();await assert.rejects(discoverRefreshOrigin(b.originItem,{...b.options,scopes:{home:false,project:false}}),/explicit/);
 const s=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(s);assert.equal(s.sourcePath,b.skill);await writeFile(path.join(b.skill,"SKILL.md"),"current declared bytes\n");const p=await prepareRefresh(b.library,b.item.id,s);await commitRefresh(p,approval(p));assert.equal(await readFile(b.saved("SKILL.md"),"utf8"),"current declared bytes\n");
 await writeFile(path.join(b.pkg,"package.json"),JSON.stringify({name:"declared-r4",pi:{skills:[]}}));assert.equal(await discoverRefreshOrigin(b.originItem,b.options),undefined);await evidence(b,"npm-positive-declaration");
});

for(const attack of ["clone","mutation","proxy","prototype-toJSON","accessor-switch"] as const) test(`R5 declared origin ${attack} cannot redirect authority into undeclared node_modules`,async()=>{
 const b=await packageFixture(),origin=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(origin);const initial=structuredClone(origin);
 const forbidden=path.join(b.agent,"npm/node_modules/UNDECLARED/secret-skill");await mkdir(forbidden,{recursive:true});await writeFile(path.join(forbidden,"SKILL.md"),"UNDECLARED unauthorized original bytes\n");
 let candidate:ResourceCandidate=origin;
 if(attack==="clone")candidate=structuredClone(origin);if(attack==="proxy")candidate=new Proxy(origin,{});
 if(attack==="prototype-toJSON")Object.setPrototypeOf(origin,{toJSON:()=>initial});
 if(attack==="accessor-switch") { let calls=0;Object.defineProperty(origin,"sourcePath",{enumerable:true,configurable:true,get:()=>++calls===1?initial.sourcePath:forbidden});Object.defineProperty(origin,"sourceRoot",{enumerable:true,configurable:true,get:()=>calls===1?initial.sourceRoot:path.dirname(forbidden)}); }
 else {candidate.sourcePath=forbidden;candidate.sourceRoot=path.dirname(forbidden);}
 const before=await tree(b.library),originals=await tree(b.agent);let outcome="rejected";
 try {const p=await prepareRefresh(b.library,b.item.id,candidate);await commitRefresh(p,approval(p));outcome="COMMITTED undeclared bytes";}catch{/* Required fail closed before FS changes. */}
 await evidence(b,`origin-${attack}`,{outcome,initial,forbidden,before});assert.deepEqual(await tree(b.agent),originals,"original npm tree must be preserved");
 assert.equal(outcome,"rejected","declared candidate tamper must not authorize arbitrary node_modules source");assert.deepEqual(await tree(b.library),before);
});

for(const conflict of ["group","name","source-metadata","destination","catalog-bytes","body","unregistered"] as const) test(`R3/R6 ${conflict} conflict preserves external state`,async()=>{
 const b=await fixture(),p=await prepareRefresh(b.library,b.item.id,await b.replacement({"SKILL.md":"new\n"}));
 if(conflict==="body")await writeFile(b.saved("SKILL.md"),"external body\n");else if(conflict==="unregistered")await writeFile(b.saved("unknown.md"),"user unknown\n");else if(conflict==="catalog-bytes")await writeFile(path.join(b.library,"catalog.json"),(await readFile(path.join(b.library,"catalog.json"))).toString()+" ");else {const c=await loadCatalog(b.library);if(conflict==="group")c.groups[0]!.itemIds=[];if(conflict==="name")c.items[0]!.name="external name";if(conflict==="source-metadata")c.items[0]!.source="external source";if(conflict==="destination")c.items[0]!.destination={kind:"project",path:"OTHER.md"};await saveCatalog(b.library,c);}
 const external=await tree(b.library),originals=await tree(b.source);await assert.rejects(commitRefresh(p,approval(p)),/changed|checksum|registered/);assert.deepEqual(await tree(b.library),external);assert.deepEqual(await tree(b.source),originals);await evidence(b,`conflict-${conflict}`);
});

test("R6 checksum and unknown physical elements reject during prepare without repairing/deleting",async()=>{
 for(const unknown of [false,true]) {const b=await fixture();await writeFile(b.saved(unknown?"unknown.md":"SKILL.md"),"external changes\n");const before=await tree(b.library);await assert.rejects(prepareRefresh(b.library,b.item.id,await b.replacement({"SKILL.md":"new\n"})),/checksum|registered/);assert.deepEqual(await tree(b.library),before);}
});

for(const boundary of ["stage-write","stage-sync","journal","old-renamed","new-renamed","before-catalog","catalog-held","catalog-renamed","directory-sync","committed"] as StorageCheckpoint[]) test(`R6 actual commitRefresh failure ${boundary} rolls back exact snapshot+catalog`,async()=>{
 const b=await fixture({"SKILL.md":"old1\n","old.md":"old2\n"}),p=await prepareRefresh(b.library,b.item.id,await b.replacement({"SKILL.md":"new1\n","new.md":"new2\n","asset.bin":Buffer.from([0,3,4])}));
 const before=await tree(b.library),originals=await tree(b.source),realRun=storageTransactions.run;const reached:string[]=[];let count=0;
 const kernel=new StorageTransactions({checkpoint:(point)=>{reached.push(point);if(point===boundary && ++count===(boundary.startsWith("stage-")?2:1))throw new Error(`independent injected ${boundary}`);}});
 storageTransactions.run=kernel.run.bind(kernel);
 try {await assert.rejects(commitRefresh(p,approval(p)),new RegExp(`independent injected ${boundary}`));}finally{storageTransactions.run=realRun;}
 assert.ok(reached.includes(boundary));assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);assert.deepEqual((await loadCatalog(b.library)).items[0],b.item);await evidence(b,`fault-${boundary}`,{reached,count});
});

// Real source / CLI / clack / TTY, no prompt mocks.
for(const stage of ["permission","diff","secret-first","secret-second","final"] as const) test(`R1/R4/R5/R6 real CLI No at ${stage} preserves all bytes and restores TTY`,async()=>{
 const b=await fixture({"SKILL.md":"old copy\n"});await writeFile(path.join(b.sourcePath,"SKILL.md"),"token: sk_live_IndependentCLIAAA123456\n");await writeFile(path.join(b.sourcePath,"second.md"),"password: IndependentCLIBBB123456\n");const before=await tree(b.library),originals=await tree(b.source);
 const steps=[...enter,at(contract.permission,stage==="permission"?"n\r":"y\r")];
 if(stage!=="permission")steps.push(at(contract.diff,stage==="diff"?"n\r":"y\r"));
 if(!["permission","diff"].includes(stage)) {
  const paths=[...readRefresh(await prepareRefresh(b.library,b.item.id,b.candidate)).sensitivePaths];
  assert.deepEqual([...paths].sort(),["SKILL.md","second.md"]);
  steps.push(at(`Save suspected sensitive file ${paths[0]} from`,stage==="secret-first"?"n\r":"y\r"));
  if(["secret-second","final"].includes(stage))steps.push(at(`Save suspected sensitive file ${paths[1]} from`,stage==="secret-second"?"n\r":"y\r"));
 }
 if(stage==="final")steps.push(at(contract.final,"n\r"));steps.push(finish);
 const r=await manage(b,steps);assert.equal(r.code,0,r.output);assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);assert.ok(!r.output.includes("sk_live_")&&!r.output.includes("IndependentCLIBBB"));
 if(stage!=="permission"){const warning=renderedWarning(r.output);for(const text of ["All copi-only edits will be lost","no history, restore or automatic merge","Original files will not be changed"])assert.ok(warning.includes(text),text);assert.ok(r.output.indexOf("All copi-only edits will be lost")<r.output.indexOf(contract.diff));if(stage==="final")assert.ok(r.output.indexOf("Replacement warning")<r.output.indexOf(contract.final));}
 await evidence(b,`cli-no-${stage}`,{pty:r.log,exit:r.code});
});

for(const interrupt of ["ctrl-c","escape","eof","SIGINT","SIGTERM","SIGHUP"] as const) test(`R6 real CLI ${interrupt} at final confirmation preserves snapshot and natural exit`,async()=>{
 const b=await fixture();await writeFile(path.join(b.sourcePath,"SKILL.md"),"approved source new bytes\n");const before=await tree(b.library),originals=await tree(b.source);
 const stop=interrupt==="ctrl-c"?{wait:contract.final,text:"\x03"}:interrupt==="escape"?{wait:contract.final,text:"\x1b"}:interrupt==="eof"?{wait:contract.final,text:"\x04"}:{wait:contract.final,signal:interrupt};
 const r=await manage(b,[...enter,at(contract.permission),at(contract.diff),stop]);assert.ok(r.code===0||r.code===130,r.output);assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);await evidence(b,`cli-${interrupt}`,{pty:r.log,exit:r.code});
});

test("R2/R3 real CLI missing file reselects regular same-kind source; no wide search, no body rewrite",async()=>{
 const b=await fixture({"original.md":"old body\n"},"subagent");await rm(b.sourcePath);const s=await b.replacement({"new.md":"# Keep embedded body name\nnew original body\n"});const originals=await tree(b.source);
 const r=await manage(b,[...enter,at("New source path",`${s.sourcePath}\r`),at("Source scope","\r"),at(contract.permission),at(contract.diff),at(contract.final),finish]);assert.equal(r.code,0,r.output);
 assert.ok(r.output.includes("sourceRoot was not stored"));assert.ok(r.output.includes("No HOME or parent tree will be searched implicitly"));assert.ok(r.output.includes(path.dirname(s.sourcePath)));assert.ok(r.output.indexOf("Source read permission")<r.output.indexOf(contract.permission));
 const item=(await loadCatalog(b.library)).items[0]!;for(const k of contract.preserve)assert.deepEqual(item[k as keyof typeof item],b.item[k as keyof typeof b.item]);assert.equal(item.sourcePath,s.sourcePath);assert.equal(await readFile(b.saved("new.md"),"utf8"),"# Keep embedded body name\nnew original body\n");assert.deepEqual(await tree(b.source),originals);await evidence(b,"cli-reselection",{pty:r.log});
});

for(const stage of ["source-path","source-scope"] as const)test(`R2/R6 real CLI missing directory cancellation ${stage}`,async()=>{
 const b=await fixture();await rename(b.sourcePath,`${b.sourcePath}-gone`);const s=await b.replacement({"SKILL.md":"new source\n"}),before=await tree(b.library),originals=await tree(b.source);
 const steps=[...enter,at("New source path",stage==="source-path"?"\x03":`${s.sourcePath}\r`)];if(stage==="source-scope")steps.push(at("Source scope","\x03"));const r=await manage(b,steps);assert.equal(r.code,0,r.output);assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);
});

test("R1/R4 actual CLI multi-file replacement reaches all diff hunks/binary/add/delete/modes before final Yes",async()=>{
 const b=await fixture({"SKILL.md":"copi-only old\n","deleted.md":"will delete\n","asset.bin":Buffer.from([0,1,2])});await writeFile(path.join(b.sourcePath,"SKILL.md"),"new source\n");await rm(path.join(b.sourcePath,"deleted.md"));await writeFile(path.join(b.sourcePath,"added.md"),"new addition\n");await chmod(path.join(b.sourcePath,"added.md"),0o751);await writeFile(path.join(b.sourcePath,"asset.bin"),Buffer.from([0,7]));const originals=await tree(b.source);
 const r=await manage(b,[...enter,at(contract.permission),at(contract.diff),at(contract.final),finish]);assert.equal(r.code,0,r.output);
 const out=plain(r.output);for(const term of ["-copi-only old","+new source","added.md","deleted.md","asset.bin","3 → 2 bytes","absent → 751","→ absent"])assert.ok(out.includes(term),term);assert.ok(out.indexOf("Replacement warning")<out.indexOf(contract.final));assert.equal(await readFile(b.saved("SKILL.md"),"utf8"),"new source\n");assert.deepEqual(await tree(b.source),originals);await evidence(b,"cli-complete-diff",{pty:r.log});
});

test("R2/R5 actual CLI declared npm positive shows explicit selected roots before discovery/read",async()=>{
 const b=await packageFixture();const originals=await tree(b.agent);const r=await manage(b,[...enter,at("Registered package source","\r"),at("Select origin search scope",`${down}\r`),at("Authorize origin discovery only in these selected locations?"),at(contract.permission),at(contract.diff),at(contract.final),finish]);assert.equal(r.code,0,r.output);for(const term of ["Explicit origin discovery",`HOME: ${b.home}`,`Pi agent: ${b.agent}`,"Project: not selected","Physical HOME:","Validation boundary:"])assert.ok(r.output.includes(term),term);assert.ok(r.output.indexOf("Physical HOME:")<r.output.indexOf("Authorize origin discovery"));assert.equal(await readFile(b.saved("SKILL.md"),"utf8"),"declared package bytes\n");assert.deepEqual(await tree(b.agent),originals);await evidence(b,"cli-npm-positive",{pty:r.log});
});

test("R3/R6 CLI stale selection/catalog update before prepare stops instead of overwriting current identity",async()=>{
 const b=await fixture();await writeFile(path.join(b.sourcePath,"SKILL.md"),"new\n");const c=await loadCatalog(b.library);c.groups[0]!.name="external group rename";const file=path.join(b.library,"catalog.json"),external=JSON.stringify(c,null,2)+"\n";
 const r=await manage(b,[...enter,{wait:contract.permission,text:"y\r",replace:{path:file,text:external}}]);assert.notEqual(r.code,0,r.output);assert.match(r.output,/changed since selection/);assert.equal(await readFile(file,"utf8"),external);assert.match(await readFile(b.saved("SKILL.md"),"utf8"),/copi-only/);await evidence(b,"cli-old-selection",{pty:r.log});
});

// Retry1 supplements: original 77 cases above are byte-for-byte preserved.
// These independently reach the custody assertions hidden by message casing,
// rendered wrapping, or an unspecified sensitive-path prompt ordering.
for(const location of ["ancestor","leaf","interior"] as const) test(`retry1 R2/R5 symlink ${location} rejects semantically and preserves full custody`,async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"safe\n"});
 const outside=path.join(b.root,"outside-target");await mkdir(outside);await writeFile(path.join(outside,"SKILL.md"),"outside untouched bytes\n");await chmod(path.join(outside,"SKILL.md"),0o751);
 if(location==="interior")await symlink(outside,path.join(s.sourcePath,"linked"));
 else {const link=path.join(b.source,"alias");await symlink(location==="leaf"?outside:b.source,link);s.sourcePath=location==="leaf"?link:path.join(link,path.basename(s.sourcePath));s.sourceRoot=b.source;}
 const before={library:await tree(b.library),source:await tree(b.source),outside:await tree(outside)};
 await assert.rejects(prepareRefresh(b.library,b.item.id,s),/symbolic links.*(not followed|not copied)/i);
 assert.deepEqual(await tree(b.library),before.library);assert.deepEqual(await tree(b.source),before.source);assert.deepEqual(await tree(outside),before.outside);
 assert.ok(!Object.keys(await tree(b.library)).some(p=>p.includes(".copi-transaction")));
 await evidence(b,`retry1-link-${location}`,{outside,before});
});

function renderedWarning(output:string) {
 const begin=output.indexOf("Replacement warning"),end=output.indexOf(contract.diff,begin);
 assert.ok(begin>=0&&end>begin,"warning must precede diff approval");
 // Remove only clack box decorations and display whitespace in this note.
 const displayed=plain(output.slice(begin,end)).split(/\r?\n/).map(line=>line.replace(/^│\s*/,"").replace(/\s*│\s*$/,"").trim()).join(" ").replace(/\s+/g," ");
 for(const phrase of ["All copi-only edits will be lost","including added/removed bundle files and mode changes shown above","Original files will not be changed or written back","There is no history, restore or automatic merge."])assert.ok(displayed.includes(phrase),phrase);
 return displayed;
}
for(const stage of ["diff","first-sensitive","second-sensitive","final"] as const) test(`retry1 R4/R5/R6 real CLI No at ${stage}, concrete paths and rendered warning`,async()=>{
 const b=await fixture({"SKILL.md":"old copy\n"});await writeFile(path.join(b.sourcePath,"SKILL.md"),"token: sk_live_Retry1AAA123456789\n");await writeFile(path.join(b.sourcePath,"second.md"),"password: Retry1BBB123456789\n");
 // Order is obtained from the real fixed review; oracle is the full concrete set,
 // not an assumption about filesystem/locale sorting.
 const inspection=readRefresh(await prepareRefresh(b.library,b.item.id,b.candidate));const paths=[...inspection.sensitivePaths];assert.deepEqual([...paths].sort(),["SKILL.md","second.md"]);
 const before=await tree(b.library),originals=await tree(b.source);
 const steps=[...enter,at(contract.permission),at(contract.diff,stage==="diff"?"n\r":"y\r")];
 if(stage!=="diff")steps.push(at(`Save suspected sensitive file ${paths[0]} from`,stage==="first-sensitive"?"n\r":"y\r"));
 if(stage==="second-sensitive"||stage==="final")steps.push(at(`Save suspected sensitive file ${paths[1]} from`,stage==="second-sensitive"?"n\r":"y\r"));
 if(stage==="final")steps.push(at(contract.final,"n\r"));steps.push(finish);
 const r=await manage(b,steps);assert.equal(r.code,0,r.output);const warning=renderedWarning(r.output);
 assert.ok(!r.output.includes("sk_live_")&&!r.output.includes("Retry1BBB"));
 if(stage!=="diff")assert.ok(r.output.includes(`Save suspected sensitive file ${paths[0]} from`));
 if(stage==="second-sensitive"||stage==="final")assert.ok(r.output.includes(`Save suspected sensitive file ${paths[1]} from`));
 if(stage==="final")assert.ok(r.output.indexOf("Replacement warning")<r.output.indexOf(contract.final));
 assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),originals);await evidence(b,`retry1-no-${stage}`,{pty:r.log,state:r.statePath,paths,warning,exit:r.code});
});

test("retry1 R1/R3/R5 actual CLI each concrete secret approved once; fixed source bytes and all identity retained",async()=>{
 const b=await fixture({"SKILL.md":"old copy\n"});const expected={"SKILL.md":"token: sk_live_Retry1FixedAAA123456789\n","second.md":"password: Retry1FixedBBB123456789\n"};for(const [p,bytes] of Object.entries(expected))await writeFile(path.join(b.sourcePath,p),bytes);
 const inspection=readRefresh(await prepareRefresh(b.library,b.item.id,b.candidate)),paths=[...inspection.sensitivePaths];assert.deepEqual([...paths].sort(),Object.keys(expected).sort());
 const beforeCatalog=await loadCatalog(b.library);const file=path.join(b.sourcePath,"SKILL.md"),later="later unapproved original bytes\n";
 const steps=[...enter,at(contract.permission),at(contract.diff),...paths.map(p=>at(`Save suspected sensitive file ${p} from`)),{wait:contract.final,text:"y\r",replace:{path:file,text:later}},finish];
 const r=await manage(b,steps);assert.equal(r.code,0,r.output);renderedWarning(r.output);
 const prompts=[...plain(r.output).matchAll(/◆\s+Save suspected sensitive file ([^\r\n]+?) from/g)].map(m=>m[1]);assert.deepEqual(prompts,paths);assert.equal(new Set(prompts).size,2);
 assert.ok(!r.output.includes("sk_live_")&&!r.output.includes("Retry1FixedBBB"));
 const c=await loadCatalog(b.library);for(const key of contract.preserve)assert.deepEqual(c.items[0]![key as keyof typeof b.item],b.item[key as keyof typeof b.item]);assert.deepEqual(c.groups,beforeCatalog.groups);
 for(const [p,bytes] of Object.entries(expected)){assert.equal(await readFile(b.saved(p),"utf8"),bytes);assert.equal(c.items[0]!.files.find(f=>f.path===p)!.sha256,hash(Buffer.from(bytes)));}
 assert.equal(await readFile(file,"utf8"),later);assert.equal(await readFile(path.join(b.sourcePath,"second.md"),"utf8"),expected["second.md"]);
 await evidence(b,"retry1-all-secret-fixed",{pty:r.log,state:r.statePath,paths,prompts,expectedHashes:Object.fromEntries(Object.entries(expected).map(([p,v])=>[p,hash(Buffer.from(v))])),originalLaterHash:hash(Buffer.from(later))});
});

for(const mode of [0o751,0o700])test(`retry1 R1 prepared reviewed catalog and physical mode ${mode.toString(8)} must agree`,async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"fixed reviewed content\n"});await chmod(path.join(s.sourcePath,"SKILL.md"),mode);
 const p=await prepareRefresh(b.library,b.item.id,s),v=readRefresh(p);assert.equal(v.item.files[0]!.mode,mode);assert.ok(v.diffs[0]!.summary.includes(`→ ${mode.toString(8)}.`));
 const originals=await tree(b.source);const saved=await commitRefresh(p,approval(p)),c=await loadCatalog(b.library),physical=(await lstat(b.saved("SKILL.md"))).mode&0o777;
 assert.deepEqual(await tree(b.source),originals);assert.equal(await readFile(b.saved("SKILL.md"),"utf8"),"fixed reviewed content\n");
 assert.equal(saved.files[0]!.mode,mode);assert.equal(c.items[0]!.files[0]!.mode,mode);
 await evidence(b,`retry1-mode-${mode.toString(8)}`,{reviewMode:v.item.files[0]!.mode,summary:v.diffs[0]!.summary,returnedMode:saved.files[0]!.mode,catalogMode:c.items[0]!.files[0]!.mode,physicalMode:physical,sourcePreserved:true});
 assert.equal(physical,0o600,"private storage must remain 0600 independently of approved descriptor mode");
 const expected={"SKILL.md":{bytes:Buffer.from("fixed reviewed content\n"),mode}},layers=await modeLayers(b,expected,v,saved);
 await executeApply(b.library,await planApply(b.library,"alpha",b.cwd),{});const applied=await appliedFiles(b,expected);
 assert.deepEqual(await tree(b.source),originals);await evidence(b,`retry1-mode-${mode.toString(8)}-three-layers`,{layers,applied});
});

test("retry1 R1 whole replacement late mode assertion after all byte identity custody checks",async()=>{
 const b=await fixture({"SKILL.md":"copi edit\n","removed.md":"old copy\n","asset.bin":Buffer.from([0,1,2])}),s=await b.replacement({"SKILL.md":"fixed new bytes\n","added.md":"# Embedded unchanged name\n","asset.bin":Buffer.from([0,7])});await chmod(path.join(s.sourcePath,"added.md"),0o751);
 const beforeCatalog=await loadCatalog(b.library),p=await prepareRefresh(b.library,b.item.id,s),v=readRefresh(p);await writeFile(path.join(s.sourcePath,"SKILL.md"),"later unapproved bytes\n");const originals=await tree(b.source);
 const returned=await commitRefresh(p,approval(p));const c=await loadCatalog(b.library),item=c.items[0]!;for(const key of contract.preserve)assert.deepEqual(item[key as keyof typeof item],b.item[key as keyof typeof b.item]);assert.deepEqual(c.groups,beforeCatalog.groups);
 assert.deepEqual(item.files.map(f=>f.path).sort(),["SKILL.md","added.md","asset.bin"].sort());assert.equal(await lstat(b.saved("removed.md")).then(()=>true,()=>false),false);
 for(const [p,expected] of Object.entries({"SKILL.md":Buffer.from("fixed new bytes\n"),"added.md":Buffer.from("# Embedded unchanged name\n"),"asset.bin":Buffer.from([0,7])})){const actual=await readFile(b.saved(p));assert.deepEqual(actual,expected);assert.equal(item.files.find(f=>f.path===p)!.sha256,hash(actual));}
 assert.deepEqual(await tree(b.source),originals);await evidence(b,"retry1-whole-byte-custody",{diffs:v.diffs,approvedMode:0o751,physicalMode:(await lstat(b.saved("added.md"))).mode&0o777});assert.equal((await lstat(b.saved("added.md"))).mode&0o777,0o600);
 for(const descriptor of [v.item,returned,item])assert.equal(descriptor.files.find(f=>f.path==="added.md")!.mode,0o751);
 assert.equal((await readSnapshotFiles(b.library,item)).find(f=>f.path==="added.md")!.mode,0o751);
 assert.ok(!Object.keys(await tree(b.library)).some(p=>p.includes(".copi-transaction")));
 await executeApply(b.library,await planApply(b.library,"alpha",b.cwd),{});const applied=await appliedFiles(b,{"added.md":{bytes:Buffer.from("# Embedded unchanged name\n"),mode:0o751}});
 assert.deepEqual(await tree(b.source),originals);await evidence(b,"retry1-whole-byte-three-layers",{privateMode:0o600,descriptorMode:0o751,applied});
});

test("retry1 R5 non-enumerable toJSON origin authority cannot reach outside approved HOME/project",async()=>{
 const b=await packageFixture(),origin=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(origin);const initial=structuredClone(origin);
 const outside=path.join(b.root,"not-in-approved-home-or-project/node_modules/undeclared/skill");await mkdir(outside,{recursive:true});await writeFile(path.join(outside,"SKILL.md"),"UNDECLARED outside approved roots bytes\n");
 const before=await tree(b.library),originals=await tree(b.agent),unapproved=await tree(path.join(b.root,"not-in-approved-home-or-project"));
 const forged={...initial,sourcePath:outside,sourceRoot:path.dirname(outside)};await assert.rejects(prepareRefresh(b.library,b.item.id,forged),/private|excluded/);assert.deepEqual(await tree(b.library),before);
 Object.assign(origin,{sourcePath:outside,sourceRoot:path.dirname(outside)});Object.defineProperty(origin,"toJSON",{enumerable:false,value:()=>initial});let outcome="rejected";
 try{const p=await prepareRefresh(b.library,b.item.id,origin);await commitRefresh(p,approval(p));outcome="COMMITTED outside undeclared bytes";}catch{}
 assert.deepEqual(await tree(b.agent),originals);assert.deepEqual(await tree(path.join(b.root,"not-in-approved-home-or-project")),unapproved);
 await evidence(b,"retry1-nonenumerable-origin",{outcome,initial,outside,before,unapproved,after:await tree(b.library),canonicalSourcePreserved:true,unapprovedSourcePreserved:true});
 assert.equal(outcome,"rejected","mutable serialization must not transfer declared package authority");assert.deepEqual(await tree(b.library),before);
});

test("retry1 R1 whole replacement copied path arrays sorted; full fixed byte and identity custody before physical mode negative",async()=>{
 const b=await fixture({"SKILL.md":"copi edit\n","removed.md":"old copy\n","asset.bin":Buffer.from([0,1,2])}),s=await b.replacement({"SKILL.md":"fixed new bytes\n","added.md":"# Embedded unchanged name\n","asset.bin":Buffer.from([0,7])});await chmod(path.join(s.sourcePath,"added.md"),0o751);
 const beforeCatalog=await loadCatalog(b.library),p=await prepareRefresh(b.library,b.item.id,s),v=readRefresh(p);assert.equal(v.item.files.find(f=>f.path==="added.md")!.mode,0o751);assert.match(v.diffs.find(f=>f.path==="added.md")!.summary,/absent → 751/);
 await writeFile(path.join(s.sourcePath,"SKILL.md"),"later unapproved bytes\n");const originals=await tree(b.source),outside=await tree(b.cwd);
 const returned=await commitRefresh(p,approval(p)),c=await loadCatalog(b.library),item=c.items[0]!;for(const key of contract.preserve)assert.deepEqual(item[key as keyof typeof item],b.item[key as keyof typeof b.item]);assert.deepEqual(c.groups,beforeCatalog.groups);
 assert.deepEqual(item.files.map(f=>f.path).sort(),["SKILL.md","added.md","asset.bin"].sort());assert.equal(await lstat(b.saved("removed.md")).then(()=>true,()=>false),false);
 const expected={"SKILL.md":Buffer.from("fixed new bytes\n"),"added.md":Buffer.from("# Embedded unchanged name\n"),"asset.bin":Buffer.from([0,7])};
 for(const [p,bytes] of Object.entries(expected)){const actual=await readFile(b.saved(p));assert.deepEqual(actual,bytes);assert.equal(item.files.find(f=>f.path===p)!.sha256,hash(actual));}
 assert.deepEqual(await tree(b.source),originals);assert.deepEqual(await tree(b.cwd),outside);assert.equal(returned.files.find(f=>f.path==="added.md")!.mode,0o751);assert.equal(item.files.find(f=>f.path==="added.md")!.mode,0o751);
 assert.ok(!Object.keys(await tree(b.library)).some(p=>p.includes(".copi-transaction")));
 await evidence(b,"retry1-whole-copied-sort-custody",{diffs:v.diffs,expectedHashes:Object.fromEntries(Object.entries(expected).map(([p,v])=>[p,hash(v)])),identityAndGroupsPreserved:true,originalAndOutsidePreserved:true,removedAbsent:true,reviewMode:0o751,returnedMode:returned.files.find(f=>f.path==="added.md")!.mode,catalogMode:item.files.find(f=>f.path==="added.md")!.mode,physicalMode:(await lstat(b.saved("added.md"))).mode&0o777});
 assert.equal((await lstat(b.saved("added.md"))).mode&0o777,0o600,"full replacement must keep private storage separate from reviewed mode");
 assert.equal((await readSnapshotFiles(b.library,item)).find(f=>f.path==="added.md")!.mode,0o751);
 await executeApply(b.library,await planApply(b.library,"alpha",b.cwd),{});const applied=await appliedFiles(b,{"added.md":{bytes:expected["added.md"],mode:0o751}});
 assert.deepEqual(await tree(b.source),originals);await evidence(b,"retry1-whole-copied-sort-three-layers",{privateMode:0o600,descriptorMode:0o751,applied});
});

// Approved origin-fix1/mode supplement. All preceding 90 cases remain intact.
import { executeApply, planApply } from "../src/apply.ts";
import { importPreparedResource, prepareResource } from "../src/catalog.ts";
import { inspectPreparedResource } from "../src/inspect.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange } from "../src/resource-mutations.ts";

async function modeLayers(b:Awaited<ReturnType<typeof fixture>>,expected:Record<string,{bytes:Buffer;mode:number}>,review?:ReturnType<typeof readRefresh>,returned?:typeof b.item) {
 const item=(await loadCatalog(b.library)).items.find(i=>i.id===b.item.id)!;const files=await readSnapshotFiles(b.library,item);
 assert.deepEqual(files.map(f=>f.path).sort(),Object.keys(expected).sort());
 for(const [p,want] of Object.entries(expected)) {
  const descriptor=item.files.find(f=>f.path===p)!,read=files.find(f=>f.path===p)!;
  assert.equal(descriptor.mode,want.mode);assert.equal(read.mode,want.mode);assert.deepEqual(read.bytes,want.bytes);assert.equal(read.sha256,hash(want.bytes));
  assert.equal((await lstat(b.saved(p))).mode&0o777,0o600,"private snapshot inode must remain owner-only independently of descriptor");
  if(review)assert.equal(review.item.files.find(f=>f.path===p)!.mode,want.mode);
  if(returned)assert.equal(returned.files.find(f=>f.path===p)!.mode,want.mode);
 }
 for(const dir of [b.library,path.join(b.library,"items"),path.join(b.library,"items",item.id),path.dirname(b.saved("SKILL.md"))])assert.equal((await lstat(dir)).mode&0o777,0o700);
 assert.equal((await lstat(path.join(b.library,"catalog.json"))).mode&0o777,0o600);
 assert.ok(!Object.keys(await tree(b.library)).some(p=>p.includes(".copi-transaction")));
 return files.map(f=>({path:f.path,descriptor:f.mode,privateMode:0o600,hash:f.sha256}));
}
async function appliedFiles(b:Awaited<ReturnType<typeof fixture>>,expected:Record<string,{bytes:Buffer;mode:number}>) {
 const dir=path.join(b.cwd,".pi/skills/retained");const observed=[];
 for(const [p,want] of Object.entries(expected)){const target=path.join(dir,p),bytes=await readFile(target),mode=(await lstat(target)).mode&0o777;assert.deepEqual(bytes,want.bytes);assert.equal(mode,want.mode);observed.push({path:p,applyMode:mode,hash:hash(bytes)});}
 return observed;
}
for(const sourceMode of [0o600,0o644,0o700,0o751,0o755])test(`origincheck mode ${sourceMode.toString(8)} three layers through mode-only, bytes refresh, edit and reapply`,async()=>{
 const initial=Buffer.from("fixed initial text\n"),b=await fixture({"SKILL.md":initial}),s=await b.replacement({"SKILL.md":initial});await chmod(path.join(s.sourcePath,"SKILL.md"),sourceMode);
 let expected={"SKILL.md":{bytes:initial,mode:sourceMode}};const c0=await loadCatalog(b.library);const p=await prepareRefresh(b.library,b.item.id,s),v=readRefresh(p);assert.equal(v.bytesChanged,false);assert.match(v.diffs[0]!.summary,new RegExp(`→ ${sourceMode.toString(8)}\\.`));
 const sourceBefore=await tree(b.source),saved=await commitRefresh(p,approval(p));let layers=await modeLayers(b,expected,v,saved);let c=await loadCatalog(b.library);
 for(const key of contract.preserve)assert.deepEqual(c.items[0]![key as keyof typeof b.item],b.item[key as keyof typeof b.item]);assert.deepEqual(c.groups,c0.groups);
 let plan=await planApply(b.library,"alpha",b.cwd);assert.deepEqual(plan.files.map(f=>f.status),["new"]);let result=await executeApply(b.library,plan,{});assert.equal(result.cancelled,false);assert.equal(result.written.length,1);let applied=await appliedFiles(b,expected);
 plan=await planApply(b.library,"alpha",b.cwd);assert.deepEqual(plan.files.map(f=>f.status),["identical"]);const identicalBefore=await tree(b.cwd);result=await executeApply(b.library,plan,{});assert.deepEqual(result.written,[]);assert.deepEqual(await tree(b.cwd),identicalBefore);
 // Same bytes, different applied inode mode must not be classified identical.
 const target=path.join(b.cwd,".pi/skills/retained/SKILL.md"),changedMode=sourceMode===0o600?0o700:0o600;await chmod(target,changedMode);plan=await planApply(b.library,"alpha",b.cwd);assert.equal(plan.files[0]!.status,"different");
 const targetBefore=await tree(b.cwd),privateBefore=await tree(b.library);await assert.rejects(executeApply(b.library,plan,{}),/Choose keep/);assert.deepEqual(await tree(b.cwd),targetBefore);assert.deepEqual(await tree(b.library),privateBefore);
 result=await executeApply(b.library,plan,{existing:{".pi/skills/retained/SKILL.md":"replace"}});assert.equal(result.backups.length,1);assert.equal(result.backups[0]!.mode,changedMode);assert.equal((await lstat(result.backups[0]!.backupPath)).mode&0o777,0o600);assert.deepEqual(await readFile(result.backups[0]!.backupPath),initial);applied=await appliedFiles(b,expected);
 // A bytes update keeps the source descriptor mode while storage remains 0600.
 const bytes=Buffer.from("new fixed source text\n");await writeFile(path.join(s.sourcePath,"SKILL.md"),bytes);const next=await prepareRefresh(b.library,b.item.id,s),nv=readRefresh(next);assert.equal(nv.bytesChanged,true);await writeFile(path.join(s.sourcePath,"SKILL.md"),"unapproved later source\n");const originals=await tree(b.source);
 const updated=await commitRefresh(next,approval(next));expected={"SKILL.md":{bytes,mode:sourceMode}};layers=await modeLayers(b,expected,nv,updated);plan=await planApply(b.library,"alpha",b.cwd);assert.equal(plan.files[0]!.status,"different");result=await executeApply(b.library,plan,{existing:{".pi/skills/retained/SKILL.md":"replace"}});assert.equal((await lstat(result.backups[0]!.backupPath)).mode&0o777,0o600);assert.equal(result.backups[0]!.mode,sourceMode);applied=await appliedFiles(b,expected);
 const edit=await prepareSavedEdit(b.library,b.item.id,"SKILL.md"),editedBytes=Buffer.from("edited copi-only text\n"),change=await prepareSavedChange(edit,editedBytes),ev=readSavedChange(change);assert.equal(ev.item.files[0]!.mode,sourceMode);const edited=await commitSavedChange(change,{reviewId:change.reviewId,confirmed:true,approvedSensitivePaths:[...ev.sensitivePaths]});expected={"SKILL.md":{bytes:editedBytes,mode:sourceMode}};layers=await modeLayers(b,expected,undefined,edited);
 plan=await planApply(b.library,"alpha",b.cwd);assert.equal(plan.files[0]!.status,"different");result=await executeApply(b.library,plan,{existing:{".pi/skills/retained/SKILL.md":"replace"}});assert.equal(result.backups[0]!.mode,sourceMode);assert.equal((await lstat(result.backups[0]!.backupPath)).mode&0o777,0o600);applied=await appliedFiles(b,expected);
 plan=await planApply(b.library,"alpha",b.cwd);assert.equal(plan.files[0]!.status,"identical");assert.deepEqual((await executeApply(b.library,plan,{})).written,[]);
 assert.deepEqual(await tree(b.source),originals);assert.equal(sourceBefore[path.relative(b.source,path.join(s.sourcePath,"SKILL.md"))]!.mode,sourceMode);assert.equal((await lstat(path.join(s.sourcePath,"SKILL.md"))).mode&0o777,sourceMode);
 c=await loadCatalog(b.library);for(const key of contract.preserve)assert.deepEqual(c.items[0]![key as keyof typeof b.item],b.item[key as keyof typeof b.item]);assert.deepEqual(c.groups,c0.groups);
 await evidence(b,`origincheck-mode-${sourceMode.toString(8)}`,{layers,applied,originalSourceMode:sourceMode,backupPrivateMode:0o600,modeOnlyReviewed:true,identicalThenModeDifferent:true});
});

test("origincheck full bundle five source modes, two individual secrets, binary/add/delete, actual apply and private backups",async()=>{
 const b=await fixture({"SKILL.md":"old copied text\n","obsolete.md":"old only\n"});const expected={"SKILL.md":{bytes:Buffer.from("token: sk_live_IndependentThreeLayer123456\n"),mode:0o751},"second.md":{bytes:Buffer.from("password: IndependentSecondLayer123456\n"),mode:0o755},"private.md":{bytes:Buffer.from("private data\n"),mode:0o600},"note.md":{bytes:Buffer.from("note text\n"),mode:0o644},"asset.bin":{bytes:Buffer.from([0,7,8,255]),mode:0o700}};
 const s=await b.replacement(Object.fromEntries(Object.entries(expected).map(([p,v])=>[p,v.bytes])));for(const [p,v]of Object.entries(expected))await chmod(path.join(s.sourcePath,p),v.mode);
 const before=await tree(b.library),p=await prepareRefresh(b.library,b.item.id,s),v=readRefresh(p);assert.deepEqual([...v.sensitivePaths].sort(),["SKILL.md","second.md"]);assert.deepEqual(v.diffs.map(d=>d.path).sort(),[...Object.keys(expected),"obsolete.md"].sort());assert.ok(!JSON.stringify(v.diffs).includes("sk_live_"));
 await assert.rejects(commitRefresh(p,{...approval(p),approvedSensitivePaths:["SKILL.md"]}),/Individual/);assert.deepEqual(await tree(b.library),before);const originals=await tree(b.source);const returned=await commitRefresh(p,approval(p));const layers=await modeLayers(b,expected,v,returned);assert.equal(await lstat(b.saved("obsolete.md")).then(()=>true,()=>false),false);
 let plan=await planApply(b.library,"alpha",b.cwd);const paths=[".pi/skills/retained/SKILL.md",".pi/skills/retained/second.md"];const targetBefore=await tree(b.cwd),privateBefore=await tree(b.library);await assert.rejects(executeApply(b.library,plan,{secretApprovals:[paths[0]!]}),/secret approval/);assert.deepEqual(await tree(b.cwd),targetBefore);assert.deepEqual(await tree(b.library),privateBefore);
 let result=await executeApply(b.library,plan,{secretApprovals:paths});assert.deepEqual(result.written.slice().sort(),Object.keys(expected).map(p=>`.pi/skills/retained/${p}`).sort());const applied=await appliedFiles(b,expected);
 for(const file of ["SKILL.md","second.md"]){const target=path.join(b.cwd,".pi/skills/retained",file);await writeFile(target,"external project bytes\n");await chmod(target,0o640);}
 plan=await planApply(b.library,"alpha",b.cwd);result=await executeApply(b.library,plan,{existing:Object.fromEntries(paths.map(p=>[p,"replace" as const])),secretApprovals:paths});assert.equal(result.backups.length,2);for(const backup of result.backups){assert.equal(backup.mode,0o640);assert.equal((await lstat(backup.backupPath)).mode&0o777,0o600);assert.equal(await readFile(backup.backupPath,"utf8"),"external project bytes\n");assert.equal((await lstat(path.dirname(backup.backupPath))).mode&0o777,0o700);}
 await appliedFiles(b,expected);await modeLayers(b,expected);assert.deepEqual(await tree(b.source),originals);await evidence(b,"origincheck-full-three-layer",{layers,applied,sensitivePaths:v.sensitivePaths,backupModes:result.backups.map(x=>({original:x.mode,private:0o600}))});
});

test("origincheck same bytes with different source descriptor modes must be apply collision despite both private inodes 0600",async()=>{
 const b=await fixture({"SKILL.md":"identical shared bytes\n"}),s=await b.replacement({"SKILL.md":"identical shared bytes\n"});await chmod(path.join(s.sourcePath,"SKILL.md"),0o755);const preparedSource=await prepareResource({...s,name:"second unique resource",destination:{...b.item.destination}}),inspection=await inspectPreparedResource(preparedSource),second=await importPreparedResource(b.library,preparedSource,{confirmed:true,groupIds:[],inspection,approvedSensitivePaths:inspection.sensitivePaths});assert.ok(second);
 const c=await loadCatalog(b.library);c.groups[0]!.itemIds.push(second.id);await saveCatalog(b.library,c);const secondFile=path.join(b.library,"items",second.id,"files","SKILL.md");assert.equal((await lstat(b.saved("SKILL.md"))).mode&0o777,0o600);assert.equal((await lstat(secondFile)).mode&0o777,0o600);assert.equal(second.files[0]!.mode,0o755);assert.equal((await readSnapshotFiles(b.library,second))[0]!.mode,0o755);
 const originals=await tree(b.source),before=await tree(b.cwd),plan=await planApply(b.library,"alpha",b.cwd);assert.equal(plan.files[0]!.status,"collision");assert.deepEqual(plan.collisions[0]!.itemIds.slice().sort(),[b.item.id,second.id].sort());await assert.rejects(executeApply(b.library,plan,{}),/collision selection/);assert.deepEqual(await tree(b.cwd),before);
 await executeApply(b.library,plan,{collisions:{".pi/skills/retained/SKILL.md":second.id}});assert.equal((await lstat(path.join(b.cwd,".pi/skills/retained/SKILL.md"))).mode&0o777,0o755);assert.equal(await readFile(path.join(b.cwd,".pi/skills/retained/SKILL.md"),"utf8"),"identical shared bytes\n");assert.deepEqual(await tree(b.source),originals);await evidence(b,"origincheck-descriptor-collision",{firstDescriptor:b.item.files[0]!.mode,secondDescriptor:second.files[0]!.mode,bothPrivate:0o600,applyMode:0o755});
});

for(const conflict of ["private-mode-race","apply-mode-race","checksum"] as const)test(`origincheck three-layer ${conflict} stops without clobbering external bytes/mode`,async()=>{
 const b=await fixture(),s=await b.replacement({"SKILL.md":"new fixed source\n"});await chmod(path.join(s.sourcePath,"SKILL.md"),0o755);const p=await prepareRefresh(b.library,b.item.id,s);
 if(conflict==="private-mode-race"){await chmod(b.saved("SKILL.md"),0o700);const before=await tree(b.library),orig=await tree(b.source);await assert.rejects(commitRefresh(p,approval(p)),/changed/);assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),orig);}
 else if(conflict==="checksum"){await writeFile(b.saved("SKILL.md"),"external corrupt bytes\n");const before=await tree(b.library),orig=await tree(b.source);await assert.rejects(commitRefresh(p,approval(p)),/checksum/);await assert.rejects(planApply(b.library,"alpha",b.cwd),/checksum/);assert.deepEqual(await tree(b.library),before);assert.deepEqual(await tree(b.source),orig);}
 else{await commitRefresh(p,approval(p));const plan=await planApply(b.library,"alpha",b.cwd);await executeApply(b.library,plan,{});const next=await b.replacement({"SKILL.md":"other fixed bytes\n"});await chmod(path.join(next.sourcePath,"SKILL.md"),0o751);const q=await prepareRefresh(b.library,b.item.id,next);await commitRefresh(q,approval(q));const apply=await planApply(b.library,"alpha",b.cwd);await chmod(path.join(b.cwd,".pi/skills/retained/SKILL.md"),0o700);const before=await tree(b.cwd),priv=await tree(b.library),orig=await tree(b.source);await assert.rejects(executeApply(b.library,apply,{existing:{".pi/skills/retained/SKILL.md":"replace"}}),/changed after planning/);assert.deepEqual(await tree(b.cwd),before);assert.deepEqual(await tree(b.library),priv);assert.deepEqual(await tree(b.source),orig);}
 await evidence(b,`origincheck-${conflict}`);
});

for(const attack of ["prototype-toJSON","nonenumerable-toJSON","clone","manual","mutation","proxy","prototype-derived","accessor","symbol","extra-field","nested-mutation","nested-accessor","nested-proxy","nested-prototype","nested-toJSON"] as const)test(`origincheck authority ${attack} rejects at actual prepare/commit; zero hooks and complete custody`,async()=>{
 const b=await packageFixture(),origin=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(origin);const initial=structuredClone(origin);const outside=path.join(b.root,"outside-approved/node_modules/undeclared/skill");await mkdir(outside,{recursive:true});await writeFile(path.join(outside,"SKILL.md"),"UNAPPROVED independent authority bytes\n");await chmod(path.join(outside,"SKILL.md"),0o751);let calls=0;let candidate=origin;let mutationComplete=false;
 if(attack==="prototype-toJSON"){Object.setPrototypeOf(origin,{toJSON:()=>{calls++;return initial;}});origin.sourcePath=outside;origin.sourceRoot=path.dirname(outside);}
 else if(attack==="nonenumerable-toJSON"){Object.assign(origin,{sourcePath:outside,sourceRoot:path.dirname(outside)});Object.defineProperty(origin,"toJSON",{enumerable:false,value:()=>{calls++;return initial;}});}
 else if(attack==="clone")candidate=structuredClone(origin);
 else if(attack==="manual")candidate={...initial,sourcePath:outside,sourceRoot:path.dirname(outside)};
 else if(attack==="mutation")Object.assign(origin,{sourcePath:outside,sourceRoot:path.dirname(outside)});
 else if(attack==="proxy")candidate=new Proxy(origin,{get:()=>{calls++;throw new Error("trap must not run");},ownKeys:()=>{calls++;throw new Error("trap must not run");},getPrototypeOf:()=>{calls++;throw new Error("trap must not run");}});
 else if(attack==="prototype-derived")candidate=Object.create(origin);
 else if(attack==="accessor")Object.defineProperty(origin,"sourcePath",{enumerable:true,get:()=>{calls++;return outside;}});
 else if(attack==="symbol")Object.defineProperty(origin,Symbol("hidden"),{enumerable:true,value:outside});
 else if(attack==="extra-field")Object.defineProperty(origin,"unapproved",{enumerable:true,value:outside});
 else if(attack==="nested-mutation")origin.destination={kind:"project",path:"DIFFERENT.md"};
 else if(attack==="nested-accessor")Object.defineProperty(origin.destination,"kind",{enumerable:true,get:()=>{calls++;return "project";}});
 else if(attack==="nested-proxy")origin.destination=new Proxy(origin.destination,{ownKeys:()=>{calls++;throw new Error("nested trap must not run");},getPrototypeOf:()=>{calls++;throw new Error("nested trap must not run");}});
 else if(attack==="nested-prototype")Object.setPrototypeOf(origin.destination,{arbitrary:true});
 else if(attack==="nested-toJSON")Object.defineProperty(origin.destination,"toJSON",{enumerable:false,value:()=>{calls++;return initial.destination;}});
 mutationComplete=true;assert.equal(mutationComplete,true,"setup mutation must reach prepare rather than fail with TypeError");
 const before={library:await tree(b.library),source:await tree(b.source),agent:await tree(b.agent),outside:await tree(path.join(b.root,"outside-approved")),project:await tree(b.cwd)};let phase="prepare",outcome="",reason="";
 try{const p=await prepareRefresh(b.library,b.item.id,candidate);phase="commit";await commitRefresh(p,approval(p));outcome="COMMITTED";}catch(e){outcome="rejected";reason=String(e);assert.ok(e instanceof Error);assert.ok(!(e instanceof TypeError));}
 assert.equal(outcome,"rejected","no silent substitution of internally valid origin may succeed");assert.equal(phase,"prepare");assert.match(reason,/plain own data|accessors|symbols|fields|changed after discovery|private\/excluded/);assert.equal(calls,0,"capture must not execute caller hooks");
 assert.deepEqual(await tree(b.library),before.library);assert.deepEqual(await tree(b.source),before.source);assert.deepEqual(await tree(b.agent),before.agent);assert.deepEqual(await tree(path.join(b.root,"outside-approved")),before.outside);assert.deepEqual(await tree(b.cwd),before.project);
 await evidence(b,`origincheck-authority-${attack}`,{phase,outcome,reason,calls,mutationComplete,before,outside,initial});
});

for(const field of ["id","kind","source","scope","sourceRoot","sourcePath","name"] as const)test(`origincheck genuine evidence binds primitive ${field} before read`,async()=>{
 const b=await packageFixture(),o=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(o);const before={library:await tree(b.library),source:await tree(b.agent)};const changed:Record<typeof field,string>={[field]:field==="kind"?"subagent":field==="scope"?"project":`${o[field]}-modified`} as Record<typeof field,string>;
 Object.assign(o,changed);await assert.rejects(prepareRefresh(b.library,b.item.id,o),/changed after discovery/);assert.deepEqual(await tree(b.library),before.library);assert.deepEqual(await tree(b.agent),before.source);await evidence(b,`origincheck-field-${field}`,{before});
});

test("origincheck genuine invocation single capture, detached views, two individual approvals and fixed source bytes",async()=>{
 const b=await packageFixture(),o=await discoverRefreshOrigin(b.originItem,b.options);assert.ok(o);const original=structuredClone(o);const expected={"SKILL.md":Buffer.from("token: sk_live_IndependentCapture111111\n"),"second.md":Buffer.from("password: IndependentCapture222222\n")};for(const [p,bytes] of Object.entries(expected))await writeFile(path.join(b.skill,p),bytes);await chmod(path.join(b.skill,"SKILL.md"),0o751);
 const invocation=prepareRefresh(b.library,b.item.id,o);Object.assign(o,{sourcePath:path.join(b.root,"unapproved-missing"),sourceRoot:b.root,name:"later",scope:"project"});o.destination={kind:"global-only"};const p=await invocation,v=readRefresh(p);assert.equal(v.source.sourcePath,original.sourcePath);assert.deepEqual([...v.sensitivePaths].sort(),["SKILL.md","second.md"]);
 const before=await tree(b.library);v.source.sourcePath=b.root;v.item.files[0]!.mode=0o600;(v.sensitivePaths as string[]).splice(0);await assert.rejects(commitRefresh(p,{reviewId:p.reviewId,confirmed:true,approvedSensitivePaths:["SKILL.md"]}),/Individual/);assert.deepEqual(await tree(b.library),before);
 await writeFile(path.join(b.skill,"SKILL.md"),"later unapproved source bytes\n");const originals=await tree(b.agent),source=await tree(b.source),outside=await tree(b.cwd);const returned=await commitRefresh(p,approval(p));const expectedLayers={"SKILL.md":{bytes:expected["SKILL.md"],mode:0o751},"second.md":{bytes:expected["second.md"],mode:0o644}};const layers=await modeLayers(b,expectedLayers,readRefresh(p),returned);assert.equal(returned.sourcePath,original.sourcePath);
 const c=await loadCatalog(b.library);for(const k of contract.preserve)assert.deepEqual(returned[k as keyof typeof returned],b.item[k as keyof typeof b.item]);assert.deepEqual(c.groups.map(g=>g.itemIds),[[b.item.id],[b.item.id]]);assert.deepEqual(await tree(b.agent),originals);assert.deepEqual(await tree(b.source),source);assert.deepEqual(await tree(b.cwd),outside);await assert.rejects(commitRefresh(p,approval(p)),/already/);await evidence(b,"origincheck-single-capture",{layers,original,lateCallerMutationSucceeded:true,sensitivePaths:readRefresh(p).sensitivePaths});
});
