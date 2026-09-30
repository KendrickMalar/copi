export type ResourceKind = "instruction" | "skill" | "subagent" | "pi-settings" | "mcp-config" | "model-config" | "keybindings";
export type ResourceScope = "user" | "project" | "shared" | "package";
export type ResourceDestination = { kind: "project"; path: string } | { kind: "global-only" };

export interface ResourceCandidate {
  id: string;
  kind: ResourceKind;
  source: string;
  scope: ResourceScope;
  sourceRoot: string;
  sourcePath: string;
  name: string;
  destination: ResourceDestination;
}

export interface DiscoveryWarning {
  code: string;
  path: string;
  message: string;
}

export interface DiscoveryResult {
  candidates: ResourceCandidate[];
  warnings: DiscoveryWarning[];
  excludedPaths: string[];
}

export interface InspectionWarning {
  code: string;
  path?: string;
  message: string;
}

export interface InspectionResult {
  warnings: InspectionWarning[];
  sensitivePaths: string[];
  excludedPaths: string[];
}

export interface SnapshotFile {
  path: string;
  mode: number;
  sha256: string;
}

export interface SnapshotFileContents extends SnapshotFile {
  bytes: Buffer;
}

export interface SavedItem {
  id: string;
  kind: ResourceKind;
  source: string;
  scope: ResourceScope;
  sourcePath: string;
  destination: ResourceDestination;
  name: string;
  savedAt: string;
  files: SnapshotFile[];
}

export interface Group {
  id: string;
  name: string;
  itemIds: string[];
}

export interface Catalog {
  version: 1;
  items: SavedItem[];
  groups: Group[];
}
