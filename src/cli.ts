#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listSnapshots, loadCatalog } from "./catalog.ts";
import { printGroups, printItems, runApplyDryRun, runApplyWizard, runGroupManager, runSetup, safeDisplay } from "./wizard.ts";
import { parseAddArgs, runAdd } from "./cli-add.ts";
import { runManage } from "./manage.ts";
import { runMigrateCommand, type MigrationCommandRuntime } from "./migrate.ts";

function usage(): void {
  process.stdout.write(`copi — copy and organize reusable Pi coding-agent resources

Usage:
  copi setup
  copi manage
  copi groups
  copi list
  copi add <path>... --group <name> [--name <display name>] [--kind <kind>] [--dry-run] [--json]
  copi apply <group> [target]
  copi apply <group> [target] --dry-run
  copi migrate [--dry-run]
  copi migrate --resolve [--dry-run]
  copi help

Commands:
  setup              Search explicitly selected locations and save copied resources
  manage             Select saved copies by name; masked view, edit, rename, refresh, groups, apply
  groups             Manage groups interactively; without a TTY, list groups only
  list               List saved snapshots without modifying the library
  add <path>...      Save explicit paths without a TTY (for scripts and AI agents); see below
  apply <group>      Review and apply one group to the current directory or target
  apply --dry-run    Show the masked plan without changing project files
  migrate            Review and migrate an eligible legacy library (TTY required)
  migrate --dry-run  Show a read-only masked legacy migration review
  migrate --resolve  Confirm resolution of eligible post-switch migration leftovers
  help               Show this help

Manage requires an interactive stdin/stdout TTY; UUID input is not required.
Resource names and group names are unique in separate library-wide namespaces:
trim, NFKC, Unicode 17 default full case folding, then NFKC. Legacy duplicate
names require manual resolution; only listing, masked viewing and resolution
are allowed until resolved. Display name changes leave contents not rewritten
and are separate from destination changes.

Edit only existing UTF-8 saved files, at most 1_000_000 bytes; binary and unsupported
encodings are rejected. Ctrl-S submits for diff review, not immediate saving;
Esc / Ctrl-C cancels. Enter inserts a newline, arrows move, PgUp/PgDn scroll;
bracketed paste supports multiple lines. Suspected sensitive raw text can expose
secrets on the screen, scrollback or recordings: individual approval to expose
is separate from approval to save. Fixed bytes are inspected before saving;
each suspected sensitive file requires fresh individual approval.

Pi loads only root context files (AGENTS.override.md, AGENTS.md, AGENTS.MD,
CLAUDE.md, CLAUDE.MD) and .pi/SYSTEM.md or .pi/APPEND_SYSTEM.md automatically.
apply warns when another instruction is not mentioned by a root context file and
can add one reference line after a separate default-no approval; --dry-run shows
the same warning and diff without writing.

Refresh can reselect a same-kind source with explicit read permission; the whole
saved copy is replaced after masked diff and individual file approvals. Copi-only edits
will be lost. Originals are not written back. No history, restore or automatic merge
is provided. Private saved files are 0600; apply reproduces the original source mode.
File addition, deletion and internal rename through text editing, and applying
global settings, are outside scope.

Migration dry-runs are read-only and may run without a TTY. Mutating migration and
resolution require both stdin and stdout to be a TTY; every confirmation defaults to no.
Resolution first shows the complete masked diff, then asks about each sensitive path,
then asks for a final confirmation. --resolve never falls back to ordinary migration.
There is no --yes option. Cancellation, blocked
reviews, invalid flags and non-TTY mutation exit with status 1. If an ordinary migration
stops on an internal lock, use copi migrate --resolve --dry-run; never remove a lock by hand.

Resolution only confirms eligible adopted-source edits and cleans up owned migration
artifacts. A v4 journal has no start inventory, so it stays on the existing recovery/
hold-stop path. It does not rewrite catalog, sources or items, distribute resources, or delete
items. Do not use an older copi binary while resolution artifacts remain. v4 journals lack
the start inventory required for this procedure and remain on the existing hold-stop path.
A migration backup is not general history or a restore feature. Migration, items deletion,
main integration and publishing require separate approval.

add saves the given paths into the named group (created if missing) without prompts, so
scripts and AI agents can register resources. It only reads the paths you name. Each path
is inspected first: anything with suspected sensitive content, settings files (settings.json,
mcp.json, models.json, keybindings.json), symbolic links, excluded paths and display-name
conflicts are refused and left for copi setup, where a person reviews them. Kind is detected
(a directory with SKILL.md is a skill, agents/*.md a subagent, AGENTS.md/CLAUDE.md/SYSTEM.md an
instruction) or given with --kind skill|subagent|instruction. --dry-run reports without saving;
--json prints machine-readable results. Exit status is 1 if any path was refused. Secret
detection is heuristic: a secret it misses is saved like any other content.

Interactive changes require a TTY. Setup searches only locations explicitly selected
and confirmed in the wizard. Directories named auth are excluded entirely; copied
authentication-specific code may be missing from copied resources. Named authentication files and .env* paths,
and history/cache paths are filtered; secret detection is heuristic and cannot guarantee
completeness.`);
}

function requireHome(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("HOME must be set to an absolute path to use the copi library.");
  return path.resolve(home);
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function main(
  args = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  migrationRuntime: MigrationCommandRuntime = {},
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  if (command === "migrate" && (rest.includes("--help") || rest.includes("-h"))) {
    if (rest.length === 1) { usage(); return 0; }
    throw new Error("Usage: copi migrate [--dry-run] | copi migrate --resolve [--dry-run].");
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

  if (command === "migrate") return runMigrateCommand(rest, libraryDir, migrationRuntime);
  if (command === "manage") {
    if (rest.length > 0) throw new Error("manage does not accept positional arguments.");
    if (!isInteractive()) throw new Error("manage requires an interactive stdin/stdout TTY; no library was created or searched.");
    await runManage(libraryDir, { homeDir, agentDir, projectDir });
    return 0;
  }
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
  if (command === "add") {
    const options = parseAddArgs(rest);
    const { outcomes, exitCode } = await runAdd(libraryDir, cwd, options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ group: options.group, dryRun: options.dryRun, results: outcomes }, null, 2)}\n`);
    } else {
      for (const outcome of outcomes) {
        const line = outcome.status === "refused"
          ? `refused: ${outcome.path} \u2014 ${outcome.reason}`
          : `${outcome.status === "added" ? "added" : "would add"}: ${outcome.name} [${outcome.kind}] \u2192 ${options.group}`;
        process.stdout.write(`${safeDisplay(line)}\n`);
      }
    }
    return exitCode;
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

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href : "";
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    console.error(`copi: ${safeDisplay(message)}`);
    process.exitCode = 1;
  }
}
