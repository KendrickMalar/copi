# copi

`copi` is a macOS CLI for copying supported Pi coding-agent resources into a private local library, grouping them by project use, reviewing a masked plan, and applying selected files to a project. It never decides for you: the only AI involvement is an optional, per-run suggestion step in `setup` that asks your own Pi for advice.

## Status and requirements

- Package: `@papillon6814/copi`; command: `copi`.
- macOS only (saving resources into the library requires Apple Silicon / arm64); Node.js 22.19.0 or newer.
- Install with `npm install --global @papillon6814/copi`. npm creates the `copi` command.
- Version 0.1.0 predates the catalog v2 `sources` layout. Use 0.2.0 or newer with a migrated library.
- An older, unrelated tool may already provide a `copi` command. Check `command -v copi` before installing globally; resolve any command-name conflict deliberately.

For a local checkout, run `npm install --ignore-scripts`, `npm run build`, then `node dist/src/cli.js help`.

## Commands

```text
copi setup
copi manage
copi groups
copi list
copi apply <group> [target]
copi apply <group> [target] --dry-run
copi migrate [--dry-run]
copi migrate --resolve [--dry-run]
copi help
```

`setup` requires an interactive terminal. It first asks where copi may look: the Pi agent directories (`~/.pi/agent`, `~/.pi/agent-*`, `~/.pi/agent_*` and `~/.agents`; the default), this project only, or both. Settings and packages declared by those Pi profiles are expanded too, so configured paths elsewhere under `HOME` may be read; setup never walks your whole `HOME`. Symbolic links are not followed, and worktree checkout copies (`.worktrees`, `.claude/worktrees`, `.config/superpowers/worktrees`, `.treehouse`) are skipped. Selecting the current project scopes discovery to that project; when the current directory is `HOME` itself, only the Pi agent directories are offered. Candidates with the same kind, name and content are merged into one row marked `(+N identical copies)`; the kept row prefers a source under `~/.pi` or `~/.agents`. Copi then asks for explicit authorization before searching; declining performs no search. Search warnings are summarized (for example, resources found outside the selected roots are counted rather than listed one by one), and missing files are skipped silently. The resource list is split into Skills, Agents, Instructions and Settings tabs (←/→ switch tabs, ↑/↓ move, Tab selects (Space types into the filter), typing filters the current tab, Enter confirms the selection across all tabs); below the list a masked preview of the focused row shows the first lines of the file (or a skill's `SKILL.md`) with size, modification date and destination. Selecting a row only makes it a candidate for review; nothing is saved until the final confirmation. Before the list, if a `pi` command is available (or `COPI_PI_COMMAND` names one, e.g. `pi-kuno`), setup asks whether to request suggestions from Pi (default No). If you agree, each candidate's kind, name, frontmatter description and masked excerpt (at most 40 lines / 4 KiB, no paths) is sent to your Pi model, run with `--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-session --no-approve`; Pi only replies keep or skip with a short reason. Keep suggestions start selected and are marked `★`, skip suggestions are marked `·`, and the focused row shows Pi's reason. Suggestions never save anything, every later review and approval still applies, and if Pi fails, times out (2 minutes) or replies in an unexpected format, setup continues without suggestions. Masking is heuristic, so decline the step if excerpts must not leave your machine.

Candidates are listed with a source label, size and modification date, and entries whose name matches an already saved resource are marked `already saved`. After you select resources, name conflicts are resolved right away, before any preview: keep one of the same-named selections, rename the display name only (the files, body and destination are not changed), skip the resource (keeping the saved copy), or go back to the list.

A group is a named set of saved resources that you later apply together with `copi apply <group> <project>`. If no group exists yet, setup asks you to create the first one. With several resources, setup asks once how to group them: by default all of them go into the same group(s); you can instead choose groups for each resource. Each resource is then reviewed in turn with a masked preview titled with its progress (for example `1/3`) and its source directory. A suspected sensitive file needs its own approval; answering No means that resource is not saved at all. Finally, one confirmation lists everything that will be copied into the library; the original files are never changed. When it is done, setup prints the next step, for example `copi apply <group> <project> --dry-run`.

`manage` requires both stdin and stdout to be an interactive TTY. Choose saved resources and groups by name; UUID input is not required and normal screens identify resources by display name, kind, groups and destination. It provides masked viewing, terminal text editing, display-name changes, separate destination changes, source refresh, group management and apply. Running without arguments, or with `help`, `--help` or `-h`, still shows help.

Resource display names and group names are each unique across the library, in separate namespaces. Comparison uses `trim → NFKC → Unicode 17.0.0 default full case folding → NFKC` (not locale-specific); display names and body text are not automatically normalized or rewritten. For example, `Ａ` and `a`, or `Straße` and `STRASSE`, conflict within one namespace. Legacy duplicate catalogs remain readable: use **Resolve name conflicts** to rename them manually. Until resolved, only listing, masked viewing and conflict resolution are allowed; no automatic renaming occurs.

`groups` lists groups in a non-interactive terminal; group changes require a TTY and are saved only after confirmation. `list` is read-only. `apply --dry-run` prints the planned paths, masked text diffs, and warnings without changing the target. A real apply requires a TTY and confirmation.

Pi automatically loads only context files (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`) and `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md`. When a group applies another instruction (for example `RULES.md`) and no context file at the project root mentions its path, `apply` warns. It offers to append one reference line per instruction (`- 作業を始める前に \`RULES.md\` を読み、その指示に従うこと。`) to the root context file Pi prefers (`AGENTS.override.md` first); if no root context file exists, it offers to create `AGENTS.md`. The offer is a separate default-no approval; declining still applies the other files. An existing file is backed up privately before the append. `--dry-run` prints the same warning and diff. No reference is offered when the file Pi prefers is a symbolic link, not a regular file, not UTF-8, or larger than 1 MB, or when the same group also places a root context file (matched case-insensitively); the warning then shows the line to add yourself. Only the project root is checked; parent directories and the Pi agent directory are not.

`migrate --dry-run` and `migrate --resolve --dry-run` are read-only and may run without a TTY. A mutating `migrate` or `migrate --resolve` requires both stdin and stdout to be a TTY. Reviews print the complete masked diff, then ask for whole-review approval (default no), a separate default-no approval for each sensitive path, and a final default-no confirmation. There is no `--yes` flag. Refusal, EOF, Ctrl-C, blocked state, usage errors, and non-TTY mutation exit with status 1; ready dry-runs, successful operations and a resolution that is not needed exit with status 0.

Ordinary `migrate` adopts only eligible existing `sources` content and keeps a verified backup. If an internal migration lock or resolution record blocks it, the CLI points to `migrate --resolve --dry-run`; do not manually remove internal locks. Resolution is limited to eligible post-switch adopted-source edits: it confirms the reviewed edit, preserves source bytes, retains the verified backup, and removes only owned internal migration leftovers. `migrate --resolve` never falls back to ordinary migration. It does not rewrite the catalog, sources or items, distribute resources, or delete items. A blocked review stops while preserving edits and remaining artifacts; a new review may be needed after a cleanup interruption. Never use an older `copi` binary while resolution artifacts remain. v4 journals do not have the start inventory required for this procedure and remain on the existing recovery/hold-stop path. A migration backup is not general history or a restore feature. Migration, item deletion, main integration and publishing require separate approval. Migration (M) and items deletion (D) each require separate approval from one another.

### Migration support limits and safe-stop guide

R4 migration is adopt-only. `copi migrate --dry-run` may show a `ready` preview for an item backed only by legacy `items`, but items-only content and new `sources` additions are not supported. Commit rejects such a plan before writing; a `ready` preview is not proof that migration can be committed. Migration succeeds only when every selected payload can be adopted from eligible content already in `sources`.

The packaged native source-placement helper is currently built for macOS arm64. Every product entry point that needs exclusive native placement declares that requirement and performs a read-only check for the supported platform, packaged helper, and filesystem capability before creating or changing any library path, transaction lock, stage, or journal. If the platform or helper is unsupported, the filesystem does not advertise the required operation, or its capability cannot be determined, the request stops before the first filesystem write; no ordinary rename or copy fallback is used. For a library that does not yet exist, the filesystem check uses its nearest existing directory ancestor. This placement limit does not by itself prohibit read-only commands.

`StorageTransactions.run` requires TypeScript callers to explicitly declare whether native placement is required. The internal `#commitNewItems` boundary repeats the check so a direct adapter call from JavaScript cannot bypass it by omitting the option or passing `false`. Such an internal misuse may briefly acquire a transaction lock and root lease before rejection; it writes no content payload, stage, or journal, then cleans the lock and releases the lease. Product entry points preflight before that lock or lease is created.

During an operation, do not move, rename, or replace the library root, `sources/`, or a saved item's management directory. This rule is about management directories, not ordinary content edits: editing a regular source file, an editor's file replacement, and skill file additions and removals are supported ordinary-edit cases. Do not treat a managed-directory move or replacement as an ordinary edit.

For a migration stopped by an internal transaction lock or resolution record, first run `copi migrate --resolve --dry-run`. It is read-only. If it reports `ready`, review the complete masked diff; only then may you run `copi migrate --resolve` for the separate default-no whole-review, per-sensitive-path, and final confirmations. If the preview reports `blocked`, leave the edits and remaining artifacts in place. A v4 journal lacks the start inventory; unknown journal versions and incomplete or malformed states that the current build cannot verify remain held. An interrupted cleanup is eligible only when the current build explicitly verifies it and presents a `ready` review.

If rollback leaves an existing `.migration-backups/` namespace, ordinary migration prepare is blocked because the backup is preserved and not adopted automatically. This is not a retry or restore path: never manually remove, move, or restore a migration backup or move the library contents. An offline preservation check of a real library is a separate read-only activity requiring separate explicit approval for that exact scope; neither a dry-run nor an earlier migration approval grants it. Such a check is not authorization to alter, move, restore, or delete anything, and it must not be reported as a successful migration.

Do not hand-edit or remove internal migration-management files: `.copi-transaction` stage/journal files, `.copi-transaction-recovery` claims, or `.copi-migration-resolution.json`. A stage/journal rehash is a known LIMIT, not proof of authorization or custody; same-user manual changes to these internal files and manual edits to a completed resolution record are outside the protection boundary. `privateRevisionHash` is checked only against a same-process issued plan at commit; it is not a durable authentication key. The claim-absent/record-present window after claim removal and before completed-record unlink remains unsafe for older binaries; do not run one until all resolution artifacts are gone.

If ordinary source edits occur during interrupted cleanup, recovery can hold-stop and preserve them. When a further pass is eligible, it requires a fresh review and new generation with fresh whole-review, per-sensitive-path, and final approvals; never replay an earlier approval. Out-of-scope changes remain held rather than overwritten.

Groups contain resource IDs, not merged documents. The same saved resource may belong to multiple groups. Import and apply copy files byte-for-byte; they do not automatically split, rewrite, merge, or run resource contents. It does not install dependencies or apply global-only resources to a project. Review every proposed change.

## Editing and refreshing saved copies

A typical flow is `setup` → `manage` → select a resource by name → **Edit saved text** → **Rename display name** → **Refresh from source** → **Manage groups** → **Apply group**. Each change has its own review/confirmation; selecting a menu entry is not permission to save.

The terminal editor works only on existing registered UTF-8 files inside the saved copy, up to **1_000_000 bytes** (1 MB), including the resulting edited bytes. Binary/NUL content, unsupported encodings and larger files are refused with a reason. It supports Japanese text, multiline bracketed paste, blank lines, cursor movement and scrolling:

- `Ctrl-S`: submit the in-memory text for masked diff review; this does **not** save yet.
- `Esc`, `Ctrl-C` or `Ctrl-D`: cancel; interruption leaves unconfirmed changes unsaved.
- `Enter`: newline; arrow keys: move; `Home` / `End`: line start/end.
- `Ctrl-Home` / `Ctrl-End`: document start/end; `PgUp` / `PgDn`: scroll; Backspace / Delete: remove text.

Saving requires diff approval, fresh approval for each detected sensitive file in the fixed prepared bytes, and final confirmation. Normal views and diffs are masked. Before editing a detected sensitive file, a separate individual approval warns that its **raw text** may expose secrets on the screen, scrollback or terminal recordings. That exposure approval is not save approval. Detection is heuristic and may miss secrets. A checksum mismatch or concurrent change stops saving rather than silently repairing or overwriting the saved copy.

Renaming changes the display name only: the internal ID, file names, body (including embedded agent names), destination and group references stay unchanged. Destination changes are a separate operation. Text editing cannot add/delete files or rename internal files.

Refresh reads an explicitly permitted same-kind source (a directory tree for a skill; a regular file for other kinds). If the original is unavailable, select a new absolute source path or cancel; the saved copy remains available. No HOME or parent tree is searched implicitly. Registered package origins can be rediscovered only in explicitly selected and authorized locations; arbitrary source paths gain no exclusion exception. After masked diff review, inspection and individual sensitive-file approvals, refresh replaces the **whole** saved copy, including bundle file additions/removals and mode changes. All copi-only edits are lost, not merged. ID, display name, savedAt, destination and **all** group memberships are retained. Neither editing nor refresh writes back to the original.

There is **no change history, restore feature or automatic merge**. Private apply backups for replaced project files are not saved-copy version history. Applying global settings, automatic dependency installation and content transformation remain outside scope.

Japanese/paste/caret functionality is covered by automated CLI/PTY tests; real-device IME, paste and visual caret-width verification is outside this acceptance scope and has not been performed. The minimum Node 22.19.0 version itself and other operating systems have not been verified by these checks.

## Private storage and sensitive data

Snapshots and the catalog are stored under `~/.copi/` with owner-only directory/file permissions: saved files are private `0600`. Original source modes are retained separately in snapshot descriptors/catalog reads and reproduced at the apply destination, not on the private saved inode. `copi` copies the selected source into its library; it does not modify or delete the original. Snapshots remain available if the original is later removed. The copied content retains its original license and ownership; the MIT license for `copi` does not apply to imported resources.

Entire directories named `auth` are excluded; authentication-specific code may be missing, but other supported files in the resource are retained. Files named `auth.json`, `mcp-auth.json`, or `oauth.json`, `.env*` paths (including `.envrc` and `.env-production`), and repository/dependency/cache/history paths such as `.git`, `node_modules`, `.cache`, `.npm`, `cache`, `caches`, `history`, and `sessions` are excluded by the current resource filters. Do not use `copi` as a substitute for reviewing the files selected for copying.

Secret detection is heuristic and cannot guarantee completeness. Text previews and apply diffs are masked by default. Each detected potentially sensitive file requires its own explicit approval before saving and again before applying; other file contents may still contain secrets that detection misses. Review the masked preview and do not approve a file unless you have verified it yourself.

`copi` does not automatically transform resources for other AI tools, merge conflicting files, install dependencies, or apply global settings. Project placement of Pi user settings and MCP configuration preserves file contents; user-specific settings may not work in a project. `models.json` and `keybindings.json` are stored as reference-only resources and are not applied to projects.

Project subagent definitions require a compatible Pi setup; for Pi subagents, install and configure the `pi-subagents` package in the target environment yourself. `copi` does not install it.

## Development checks

```sh
npm run check
```

This performs the strict TypeScript build, Node.js test suite, and npm package dry run.
