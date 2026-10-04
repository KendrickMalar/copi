import { confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { loadCatalog, readSnapshotFiles, saveCatalog, saveNameChanges } from "./catalog.ts";
import { assertNameAvailable, assertNoNameConflicts, findNameConflicts } from "./names.ts";
import { commitSavedChange, prepareSavedChange, prepareSavedEdit, readSavedChange, readSavedEdit } from "./resource-mutations.ts";
import { editTerminalText } from "./terminal-editor.ts";
import { commitRefresh, discoverRefreshOrigin, prepareRefresh, readRefresh, resolveRefreshPath } from "./refresh.ts";
import { resolveNameConflicts, runApplyWizard, runGroupManager, runSetup, safeDisplay, withEditorInput, withWizardLifecycle, type SearchRoots } from "./wizard.ts";
import type { Catalog, ResourceCandidate, ResourceDestination, ResourceScope, SavedItem } from "./types.ts";

class Cancelled extends Error {}
function checked<T>(value: T, signal: AbortSignal): Exclude<T, symbol> {
  if (isCancel(value) || signal.aborted) throw new Cancelled();
  return value as Exclude<T, symbol>;
}
async function choose<T extends string>(message: string, options: Array<{value:T;label:string;hint?:string}>, signal: AbortSignal): Promise<T> {
  return checked(await select<string>({message,signal,options:options.map(option=>({...option,label:safeDisplay(option.label),...(option.hint===undefined?{}:{hint:safeDisplay(option.hint)})}))}),signal) as T;
}
async function yes(message: string, signal: AbortSignal): Promise<boolean> {
  return checked(await confirm({message:safeDisplay(message),initialValue:false,signal}),signal) === true;
}
function show(body: string, title: string): void { note(safeDisplay(body),safeDisplay(title)); }
function hint(catalog: Catalog, item: SavedItem, order: number): string {
  const groups = catalog.groups.filter(group=>group.itemIds.includes(item.id)).map(group=>group.name).join(", ") || "no groups";
  return `${groups} · ${item.destination.kind === "project" ? item.destination.path : "saved only"} · ${item.source} · saved ${item.savedAt} · entry ${order + 1}`;
}
async function savedFile(item: SavedItem, signal: AbortSignal): Promise<string | undefined> {
  if (item.files.length === 0) {show("No registered saved files.",item.name);return undefined;}
  return choose("Select saved file",item.files.map(file=>({value:file.path,label:file.path})),signal);
}
async function view(libraryDir: string, item: SavedItem, signal: AbortSignal): Promise<void> {
  const filePath = await savedFile(item,signal);
  if (filePath === undefined) return;
  const file = (await readSnapshotFiles(libraryDir,item)).find(file=>file.path===filePath);
  if (!file) throw new Error("Selected saved file is no longer registered; reload the library.");
  if (file.bytes.length > 1_000_000 || file.bytes.includes(0)) {
    show(`${file.path}: [binary or large file, ${file.bytes.length} bytes; content not displayed]`,"Masked saved view"); return;
  }
  try {
    const content = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(file.bytes);
    // Full text, not a silently truncated preview. Display safety never alters stored bytes.
    process.stdout.write(`\nMasked saved view: ${safeDisplay(item.name)} · ${safeDisplay(file.path)}\n${safeDisplay(content)}\n`);
  } catch {show(`${file.path}: [unsupported encoding, ${file.bytes.length} bytes; content not displayed]`,"Masked saved view");}
}
async function edit(libraryDir: string, item: SavedItem, signal: AbortSignal): Promise<void> {
  const filePath = await savedFile(item,signal);
  if (filePath === undefined) return;
  const prepared = await prepareSavedEdit(libraryDir,item.id,filePath);
  const original = readSavedEdit(prepared);
  show(original.warnings.map(w=>`${w.path?`${w.path}: `:""}${w.message}`).join("\n"),"Editing warnings · original files will not be changed");
  if (original.sensitivePaths.includes(filePath) && !await yes(
    `Expose raw text of ${filePath} from ${item.name} in the editor? Suspected secrets may be exposed on the screen, scrollback or terminal recordings. Detection is heuristic. This individual approval is not approval to save.`,signal)) {
    outro("Raw text was not exposed; nothing was saved.");return;
  }
  if(signal.aborted) throw new Cancelled();
  const initial = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(original.file.bytes);
  const result = await withEditorInput(()=>editTerminalText(initial));
  if(result.kind==="cancelled" || signal.aborted) throw new Cancelled();
  const change = await prepareSavedChange(prepared,Buffer.from(result.text,"utf8"));
  const review = readSavedChange(change);
  if(!review.bytesChanged) {outro("No byte changes; nothing was saved.");return;}
  process.stdout.write(`\n${safeDisplay(`Full masked saved diff: ${item.name}`)}\n`);
  for(const diff of review.diffs) process.stdout.write(`${safeDisplay(diff.path)}\n${safeDisplay(diff.summary)}\n${safeDisplay(diff.diff)}\n`);
  show(review.warnings.map(w=>`${w.path?`${w.path}: `:""}${w.message}`).join("\n"),"Save warnings · masked text can hide byte changes");
  if(!await yes("Approve this masked diff for saving? All hunks and byte summaries are shown above.",signal)) {outro("Diff was not approved; nothing was saved.");return;}
  const approvedSensitivePaths: string[] = [];
  for(const file of review.sensitivePaths) {
    if(!await yes(`Save suspected sensitive file ${file} from ${item.name}? This is a new approval for the prepared edited bytes, separate from raw text exposure. Detection is heuristic.`,signal)) {
      outro("Sensitive saved bytes were not approved; nothing was saved.");return;
    }
    approvedSensitivePaths.push(file);
  }
  if(!await yes(`Save edited copy of ${filePath}? Original files stay unchanged; no history or restore is provided.`,signal)) {outro("Nothing was saved.");return;}
  if(signal.aborted) throw new Cancelled();
  await commitSavedChange(change,{reviewId:change.reviewId,confirmed:true,approvedSensitivePaths});
  outro("Edited saved copy committed with matching checksums.");
}
async function rename(libraryDir: string, catalog: Catalog, item: SavedItem, signal: AbortSignal): Promise<void> {
  const name = checked(await text({message:`New display name for ${safeDisplay(item.name)}`,signal,validate:value=>{
    try {assertNameAvailable(catalog,"item",value??"",item.id);return undefined;}
    catch(error) {return safeDisplay(error instanceof Error?error.message:"Choose a unique non-empty name.");}
  }}),signal);
  show(`${item.name} → ${name}\nSaved contents, file names, group references and destination remain unchanged.`,"Display name change");
  if(await yes("Save display name only?",signal)) {
    const after = structuredClone(catalog);
    after.items.find(entry=>entry.id===item.id)!.name = name.trim();
    // Keep the UI's original object/revision; never reload and overwrite a newer name.
    await saveNameChanges(libraryDir,catalog,after);outro("Display name saved; contents and destination unchanged.");
  } else outro("Display name was not changed.");
}
async function placement(libraryDir: string, catalog: Catalog, item: SavedItem, signal: AbortSignal): Promise<void> {
  const kind = await choose("Destination kind",[
    ...(item.destination.kind === "project" ? [{value:"project",label:"Project-relative path"}] : []),
    {value:"global-only",label:"Saved only (cannot later become project-applicable)"},
  ],signal);
  let destination: ResourceDestination = {kind:"global-only"};
  if(kind==="project") {
    const destinationPath = checked(await text({message:"New project-relative destination (separate from display name)",signal,validate:value=>value?.trim()?undefined:"Enter a project-relative path."}),signal);
    destination = {kind:"project",path:destinationPath};
  }
  show(`${item.destination.kind==="project"?item.destination.path:"saved only"} → ${destination.kind==="project"?destination.path:"saved only"}\nDisplay name and saved contents remain unchanged.`,"Destination change");
  if(await yes("Save destination only?",signal)) {
    item.destination = destination;
    // saveCatalog verifies this original loadCatalog object's revision under its commit lock.
    await saveCatalog(libraryDir,catalog);outro("Destination saved; display name and contents unchanged.");
  }
  else outro("Destination was not changed.");
}
async function refresh(libraryDir: string, catalog: Catalog, item: SavedItem, roots: SearchRoots, signal: AbortSignal): Promise<void> {
  show("sourceRoot was not stored in the saved catalog. No HOME or parent tree will be searched implicitly. Select only a same-kind source; a skill uses a directory tree, other kinds use one regular file. Private/auth/.env*/cache/history paths remain excluded.","Refresh source boundary");
  let requested = item.sourcePath;
  let exists: boolean;
  try { await lstat(requested); exists = true; }
  catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; exists = false; }
  let source: ResourceCandidate | undefined;
  if(exists && (item.source.startsWith("package:") || requested.split(path.sep).some(part=>part.toLowerCase()==="node_modules"))) {
    const route = await choose("Registered package source",[{value:"discover",label:"Rediscover declared origin in explicitly permitted locations"},{value:"manual",label:"Choose a different non-excluded source path"}],signal);
    if(route==="discover") {
      const scopes = await choose("Select origin search scope",[{value:"project",label:`Current project: ${roots.projectDir}`},{value:"home",label:`HOME and Pi agent directory: ${roots.homeDir} · ${roots.agentDir}`},{value:"both",label:"HOME, Pi agent directory and current project"}],signal);
      const home = scopes!=="project", project = scopes!=="home";
      show(`Original path: ${requested}\nHOME: ${home?roots.homeDir:"not selected"}\nPi agent: ${home?roots.agentDir:"not selected"}\nProject: ${project?roots.projectDir:"not selected"}\nDiscovery uses existing declarations, exclusions and package checks; no arbitrary node_modules exception is granted.`,"Explicit origin discovery");
      if(!await yes("Authorize origin discovery only in these selected locations?",signal)) {outro("Origin discovery not authorized; nothing was saved.");return;}
      const options = {...roots,scopes:{home,project}};
      if(home) {options.homeDir=await resolveRefreshPath(roots.homeDir);options.agentDir=await resolveRefreshPath(roots.agentDir);}
      if(project) options.projectDir=await resolveRefreshPath(roots.projectDir);
      source = await discoverRefreshOrigin(item,options);
      if(!source) show("Declared origin is no longer available in the approved locations. Choose another non-excluded source explicitly, or cancel; the saved copy remains available.","Origin unavailable");
    }
    exists = Boolean(source);
  }
  if(!exists) {
    show("The original source is unavailable or was not selected. The old saved copy can still be viewed. Choose a new source path explicitly, or Esc / Ctrl-C to cancel.","Source selection");
    requested = checked(await text({message:"New source path (absolute; same resource kind)",signal,validate:value=>value && path.isAbsolute(value)?undefined:"Enter an absolute source path."}),signal);
    const scope = await choose("Source scope (metadata only; does not authorize wider searches)",[{value:"project",label:"Project"},{value:"user",label:"User"},{value:"shared",label:"Shared"},{value:"package",label:"Package (no private path exception)"}],signal) as ResourceScope;
    const physical = await resolveRefreshPath(requested);
    source = {id:item.id,kind:item.kind,name:item.name,source:"explicit-refresh-path",scope,sourcePath:physical,sourceRoot:path.dirname(physical),destination:{...item.destination}};
  }
  if(!source) {
    const physical = await resolveRefreshPath(requested);
    source = {id:item.id,kind:item.kind,name:item.name,source:item.source,scope:item.scope,sourcePath:physical,sourceRoot:path.dirname(physical),destination:{...item.destination}};
  }
  show(`Requested path: ${requested}\nPhysical source: ${source.sourcePath}\nValidation boundary: ${source.sourceRoot}\nRead only: ${item.kind==="skill"?"selected directory tree":"selected regular file"}\nKind: ${source.kind}; source: ${source.source}; scope: ${source.scope}\nNo parent-tree search. Existing exclusions and symlink checks apply.`,"Source read permission");
  if(!await yes("Authorize reading only this selected source file or directory tree now?",signal)) {outro("Source reading not authorized; nothing was saved.");return;}
  if(signal.aborted) throw new Cancelled();
  const prepared = await prepareRefresh(libraryDir,item.id,source), review = readRefresh(prepared);
  if(JSON.stringify(review.originalCatalog)!==JSON.stringify(catalog)) throw new Error("Saved metadata, memberships or copy state changed since selection; reload and review again.");
  const original = review.originalCatalog.items.find(entry=>entry.id===item.id)!;
  show(`${original.name} · ${hint(review.originalCatalog,original,review.originalCatalog.items.indexOf(original))}\nSource: ${original.sourcePath} → ${review.item.sourcePath}\nSource metadata: ${original.source} / ${original.scope} → ${review.item.source} / ${review.item.scope}\nID, display name, all memberships, savedAt and destination are retained.`,"Prepared refresh identity and source");
  process.stdout.write(`\n${safeDisplay(`Full masked refresh diff: ${review.item.name}`)}\n`);
  for(const diff of review.diffs) process.stdout.write(`${safeDisplay(diff.path)}\n${safeDisplay(diff.summary)}\n${safeDisplay(diff.diff)}\n`);
  show(review.warnings.map(w=>`${w.path?`${w.path}: `:""}${w.message}`).join("\n"),"Fixed source inspection warnings · masking can hide byte changes");
  if(review.excludedPaths.length) show(review.excludedPaths.join("\n"),"Fixed source excluded paths");
  show("All copi-only edits will be lost when this source snapshot replaces the saved copy, including added/removed bundle files and mode changes shown above. Original files will not be changed or written back. There is no history, restore or automatic merge.","Replacement warning");
  if(!await yes("Approve this refresh diff and source metadata? All masked hunks and byte/mode summaries are shown above.",signal)) {outro("Refresh diff not approved; nothing was saved.");return;}
  const approvedSensitivePaths: string[] = [];
  for(const file of review.sensitivePaths) {
    if(!await yes(`Save suspected sensitive file ${file} from ${review.item.name}? This individual approval covers only the fixed prepared source bytes. Detection is heuristic; raw source is not displayed.`,signal)) {outro("Sensitive source bytes not approved; nothing was saved.");return;}
    approvedSensitivePaths.push(file);
  }
  if(!await yes("Replace saved copy with this approved source snapshot? Copi edits will be lost; originals stay unchanged; no history, restore or automatic merge.",signal)) {outro("Refresh cancelled; nothing was saved.");return;}
  if(signal.aborted) throw new Cancelled();
  await commitRefresh(prepared,{reviewId:prepared.reviewId,confirmed:true,approvedSensitivePaths});
  outro("Refreshed saved copy committed with matching checksums; originals unchanged.");
}
async function resource(libraryDir: string, catalog: Catalog, conflict: boolean, roots: SearchRoots, signal: AbortSignal): Promise<void> {
  const id = await choose("Select saved resource",catalog.items.map((item,index)=>({value:item.id,label:`[${item.kind}] ${item.name}`,hint:hint(catalog,item,index)})),signal);
  const item = catalog.items.find(item=>item.id===id);
  if(!item) throw new Error("Selected resource is unavailable; reload the library.");
  const action = await choose("Resource action",[
    {value:"view",label:"View saved file (masked)"},
    ...(!conflict?[
      {value:"edit",label:"Edit saved text"},{value:"rename",label:"Rename display name"},{value:"placement",label:"Change destination"},
      {value:"refresh",label:"Refresh from source (replace saved copy)"},
    ]:[]),{value:"back",label:"Back"},
  ],signal);
  if(action==="view") {await view(libraryDir,item,signal);return;}
  if(action==="back") return;
  assertNoNameConflicts(await loadCatalog(libraryDir));
  if(action==="edit") await edit(libraryDir,item,signal);
  else if(action==="rename") await rename(libraryDir,catalog,item,signal);
  else if(action==="refresh") await refresh(libraryDir,catalog,item,roots,signal);
  else await placement(libraryDir,catalog,item,signal);
}

export async function runManage(libraryDir: string, roots: SearchRoots): Promise<void> {
  if(!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("manage requires an interactive stdin/stdout TTY; no library was created or searched.");
  await withWizardLifecycle(async(signal)=>{
    intro("copi manage · names, not IDs · Esc / Ctrl-C cancels");
    try {
      while(!signal.aborted) {
        const catalog = await loadCatalog(libraryDir);
        const conflict = findNameConflicts(catalog).length > 0;
        if(conflict) show("Duplicate names: only listing, masked viewing, and explicit name conflict resolution are allowed.","Duplicate names");
        else if(catalog.items.length===0) show("No saved resources. Setup searches only explicitly selected and approved locations.","Private library");
        const action = await choose("Manage saved resources",[
          ...(catalog.items.length?[{value:"resource",label:"Select resource by name"}]:[]),
          ...(conflict?[{value:"resolve",label:"Resolve name conflicts"}]:[
            {value:"groups",label:"Manage groups"},{value:"apply",label:"Apply group"},{value:"setup",label:"Setup copied resources"},
          ]),{value:"done",label:"Finish"},
        ],signal);
        if(action==="done") break;
        if(action==="resource") await resource(libraryDir,catalog,conflict,roots,signal);
        else if(action==="resolve") await resolveNameConflicts(libraryDir);
        else {
          assertNoNameConflicts(await loadCatalog(libraryDir));
          if(action==="groups") await runGroupManager(libraryDir);
          else if(action==="setup") await runSetup(libraryDir,roots);
          else {
            if(catalog.groups.length===0) {show("No groups to apply. Create a group and assign resources first.","Apply group");continue;}
            const group = await choose("Select group to apply",catalog.groups.map(g=>({value:g.id,label:g.name,hint:`${g.itemIds.length} resources`})),signal);
            const target = checked(await text({message:"Apply target directory",initialValue:roots.projectDir,signal}),signal);
            await runApplyWizard(libraryDir,group,path.resolve(roots.projectDir,target));
          }
        }
      }
      outro("Manage finished.");
    } catch(error) {
      if(error instanceof Cancelled || signal.aborted) {outro("Manage cancelled; unconfirmed changes were not saved.");return;}
      throw new Error(safeDisplay(`${error instanceof Error?error.message:"Management failed."}\nChanges stopped. Inspect the cause and reload before trying again; unknown locks and checksums are not automatically repaired.`),{cause:error});
    }
  });
}
