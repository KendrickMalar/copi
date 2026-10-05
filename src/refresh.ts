import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { prepareResource, readPreparedResource, withSavedLibrary } from "./catalog.ts";
import { discoverResources, type DiscoveryOptions } from "./discovery.ts";
import { inspectPreparedResource } from "./inspect.ts";
import { commitSavedChange, prepareSavedReplacement, readSavedChange, type ChangeApproval, type PreparedSavedChange, type SavedChangeView } from "./resource-mutations.ts";
import type { Catalog, ResourceCandidate, SavedItem } from "./types.ts";

declare const refreshBrand: unique symbol;
export interface PreparedRefresh { readonly [refreshBrand]: true; readonly reviewId: string }
export interface RefreshView extends SavedChangeView { readonly originalCatalog: Catalog; readonly source: ResourceCandidate }
interface RefreshState { change: PreparedSavedChange; originalCatalog: Catalog; source: ResourceCandidate }
const refreshes = new WeakMap<PreparedRefresh, RefreshState>();
// Only an actual declared-package discovery result can authorize node_modules, not caller strings.
const discoveredOrigins = new WeakMap<ResourceCandidate, Readonly<ResourceCandidate>>();
const candidateFields = ["id", "kind", "source", "scope", "sourceRoot", "sourcePath", "name", "destination"] as const;

// Capture only plain own data, without executing caller accessors, Proxy traps,
// toJSON or coercion. The same detached capture is checked and later read.
function ownData(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Refresh candidate must contain plain own data without proxies or custom prototypes.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Refresh candidate must not contain accessors, symbols or non-enumerable fields.");
    Object.defineProperty(captured, key, { value: descriptor.value, enumerable: true });
  }
  return captured;
}
function captureCandidate(source: ResourceCandidate): ResourceCandidate {
  const values = ownData(source);
  if (Object.keys(values).length !== candidateFields.length || candidateFields.some(key => !Object.hasOwn(values, key)) || candidateFields.some(key => key !== "destination" && typeof values[key] !== "string")) throw new Error("Invalid refresh candidate fields.");
  const destination = ownData(values.destination);
  let fixedDestination: ResourceCandidate["destination"];
  if (destination.kind === "global-only" && Object.keys(destination).length === 1) fixedDestination = { kind: "global-only" };
  else if (destination.kind === "project" && Object.keys(destination).length === 2 && typeof destination.path === "string") fixedDestination = { kind: "project", path: destination.path };
  else throw new Error("Invalid refresh candidate destination fields.");
  return {
    id: values.id as string, kind: values.kind as ResourceCandidate["kind"], source: values.source as string,
    scope: values.scope as ResourceCandidate["scope"], sourceRoot: values.sourceRoot as string,
    sourcePath: values.sourcePath as string, name: values.name as string, destination: fixedDestination,
  };
}
function matchesOrigin(fixed: ResourceCandidate, origin: Readonly<ResourceCandidate>): boolean {
  return candidateFields.every(key => key === "destination" || fixed[key] === origin[key]) &&
    fixed.destination.kind === origin.destination.kind &&
    (fixed.destination.kind !== "project" || (origin.destination.kind === "project" && fixed.destination.path === origin.destination.path));
}
const excluded = new Set(["auth", "auth.json", "mcp-auth.json", "oauth.json", "cache", "caches", ".cache", ".npm", ".git", "history", "sessions"]);
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Metadata checks only. Never follows arbitrary links, including links above the selected boundary. */
export async function resolveRefreshPath(requested: string): Promise<string> {
  if (!path.isAbsolute(requested) || requested.includes("\0") || requested.includes("\\")) throw new Error("Select an absolute source path without unsafe path characters.");
  let physical = path.resolve(requested);
  for (const [alias, target] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]] as const) {
    if (physical === alias || physical.startsWith(`${alias}/`)) {
      const stat = await lstat(alias);
      if (stat.isSymbolicLink()) {
        if (process.platform !== "darwin" || await realpath(alias) !== target) throw new Error("Unsafe source ancestor symbolic link.");
        physical = target + physical.slice(alias.length);
      }
    }
  }
  let current = path.parse(physical).root;
  for (const component of physical.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links in source or source ancestors are not followed.");
  }
  return physical;
}

/** Call only after explicit discovery-root/scope consent; no implicit HOME or parent search. */
export async function discoverRefreshOrigin(item: SavedItem, options: DiscoveryOptions): Promise<ResourceCandidate | undefined> {
  if (!options.scopes || (!options.scopes.home && !options.scopes.project)) throw new Error("Refresh origin discovery requires explicitly selected search scopes.");
  const original = await resolveRefreshPath(item.sourcePath);
  const discovery = await discoverResources(options);
  const candidate = discovery.candidates.find(entry => entry.kind === item.kind && entry.sourcePath === original);
  if (!candidate) return undefined;
  // Discovery validates declarations, authorized package roots and exclusions. Manual paths never inherit this authority.
  if (candidate.scope === "package" && candidate.source.startsWith("package:")) {
    const evidence = captureCandidate(candidate);
    Object.freeze(evidence.destination);
    discoveredOrigins.set(candidate, Object.freeze(evidence));
  }
  return candidate;
}

function stateOf(prepared: PreparedRefresh): RefreshState {
  const state = refreshes.get(prepared);
  if (!state) throw new Error("Invalid or unavailable prepared refresh token.");
  return state;
}
export async function prepareRefresh(libraryDir: string, itemId: string, source: ResourceCandidate): Promise<PreparedRefresh> {
  const fixed = captureCandidate(source); // One capture, before any await.
  const origin = discoveredOrigins.get(source);
  if (origin && !matchesOrigin(fixed, origin)) throw new Error("Declared refresh origin changed after discovery; rediscover and review before reading.");
  const registeredPackage = origin !== undefined;
  const before = await withSavedLibrary(libraryDir, async state => ({ catalog: structuredClone(state.catalog), revision: state.revision }));
  const item = before.catalog.items.find(entry => entry.id === itemId);
  if (!item) throw new Error("Unknown saved resource.");
  if (fixed.kind !== item.kind) throw new Error("Refresh source must have the same resource kind.");
  fixed.sourcePath = await resolveRefreshPath(fixed.sourcePath);
  fixed.sourceRoot = await resolveRefreshPath(fixed.sourceRoot);
  if (!within(fixed.sourceRoot, fixed.sourcePath)) throw new Error("Refresh source escapes its physical boundary.");
  for (const component of fixed.sourcePath.split(path.sep)) {
    const lower = component.toLowerCase();
    if (excluded.has(lower) || lower.startsWith(".env") || (lower === "node_modules" && !registeredPackage)) throw new Error("Selected source is in a private/excluded ancestor; choose a non-excluded path or explicitly rediscover its declared package origin.");
  }
  const stat = await lstat(fixed.sourcePath);
  if (fixed.kind === "skill" ? !stat.isDirectory() : !stat.isFile()) throw new Error("Refresh source shape must match: skill directory, or regular file for other resource kinds.");
  if ((fixed.kind === "model-config" || fixed.kind === "keybindings") && fixed.destination.kind !== "global-only") throw new Error("Reference-only source kind cannot become project-applicable.");
  const preparedSource = await prepareResource(fixed);
  await inspectPreparedResource(preparedSource);
  const change = await prepareSavedReplacement(libraryDir, itemId, preparedSource);
  // Ensure the old state captured here is the state reviewed by the replacement kernel.
  // Sessions never escape their callbacks or remain open across UI prompts.
  await withSavedLibrary(libraryDir, async state => { await state.session.assertRevision(before.revision); });
  const prepared = Object.freeze({ reviewId: change.reviewId }) as PreparedRefresh;
  refreshes.set(prepared, { change, originalCatalog: before.catalog, source: readPreparedResource(preparedSource).candidate });
  return prepared;
}
export function readRefresh(prepared: PreparedRefresh): RefreshView {
  const state = stateOf(prepared);
  return { ...readSavedChange(state.change), originalCatalog: structuredClone(state.originalCatalog), source: structuredClone(state.source) };
}
export async function commitRefresh(prepared: PreparedRefresh, approval: ChangeApproval): Promise<SavedItem> {
  return commitSavedChange(stateOf(prepared).change, approval);
}
