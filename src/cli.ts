#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listSnapshots, loadCatalog } from "./catalog.ts";
import { printGroups, printItems, runApplyDryRun, runApplyWizard, runGroupManager, runSetup } from "./wizard.ts";

function usage(): void {
  process.stdout.write(`copi — copy and organize reusable Pi coding-agent resources

Usage:
  copi setup
  copi groups
  copi list
  copi apply <group> [target]
  copi apply <group> [target] --dry-run
  copi help

Commands:
  setup              Search explicitly selected locations and save copied resources
  groups             Manage groups interactively; without a TTY, list groups only
  list               List saved snapshots without modifying the library
  apply <group>      Review and apply one group to the current directory or target
  apply --dry-run    Show the masked plan without changing project files
  help               Show this help

Interactive changes require a TTY. Setup searches only locations explicitly selected
and confirmed in the wizard. Named authentication files, .env* files, and history/cache
paths are filtered; secret detection is heuristic and cannot guarantee completeness.`);
}

function requireHome(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("HOME must be set to an absolute path to use the copi library.");
  return path.resolve(home);
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function main(args = process.argv.slice(2), environment = process.env, cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    usage();
    return 0;
  }

  const homeDir = environment.HOME && path.isAbsolute(environment.HOME) ? path.resolve(environment.HOME) : "";
  const libraryDir = path.join(requireHome(environment), ".copi");
  const agentDir = environment.PI_CODING_AGENT_DIR
    ? path.resolve(cwd, environment.PI_CODING_AGENT_DIR)
    : path.join(homeDir || requireHome(environment), ".pi", "agent");
  const projectDir = path.resolve(cwd);

  if (command === "setup") {
    if (rest.length > 0) throw new Error("setup does not accept positional arguments.");
    if (!isInteractive()) throw new Error("setup requires an interactive TTY; no search was performed.");
    await runSetup(libraryDir, { homeDir, agentDir, projectDir });
    return 0;
  }
  if (command === "groups") {
    if (rest.length > 0) throw new Error("groups does not accept positional arguments.");
    if (isInteractive()) await runGroupManager(libraryDir);
    else printGroups(await loadCatalog(libraryDir));
    return 0;
  }
  if (command === "list") {
    if (rest.length > 0) throw new Error("list does not accept positional arguments.");
    printItems(await listSnapshots(libraryDir));
    return 0;
  }
  if (command === "apply") {
    const dryRun = rest.includes("--dry-run");
    const positional = rest.filter((argument) => argument !== "--dry-run");
    const [group, target, ...extra] = positional;
    if (!group || extra.length > 0) throw new Error("Usage: copi apply <group> [target] [--dry-run].");
    const resolvedTarget = path.resolve(cwd, target ?? ".");
    if (dryRun) {
      await runApplyDryRun(libraryDir, group, resolvedTarget);
      return 0;
    }
    if (!isInteractive()) throw new Error("apply requires an interactive TTY; use --dry-run for a read-only plan.");
    await runApplyWizard(libraryDir, group, resolvedTarget);
    return 0;
  }
  throw new Error(`Unknown command: ${command}. Run copi help for usage.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    console.error(`copi: ${message}`);
    process.exitCode = 1;
  }
}
