# copi

`copi` is a macOS CLI for copying supported Pi coding-agent resources into a private local library, grouping them by project use, reviewing a masked plan, and applying selected files to a project. It does not use AI classification.

## Status and requirements

- Package: `@papillon6814/copi`; command: `copi`.
- macOS only; Node.js 22.19.0 or newer.
- The package is not published yet. Do not rely on the npm install command below until publication is announced.
- If published, install with `npm install --global @papillon6814/copi`.
- An older, unrelated tool may already provide a `copi` command. Check `command -v copi` before installing globally; resolve any command-name conflict deliberately.

For a local checkout, run `npm install --ignore-scripts`, `npm run build`, then `node dist/src/cli.js help`.

## Commands

```text
copi setup
copi groups
copi list
copi apply <group> [target]
copi apply <group> [target] --dry-run
copi help
```

`setup` requires an interactive terminal. It asks which locations may be searched and asks for explicit authorization before searching. Selecting the entire `HOME` is broad: it can inspect supported resources throughout that directory, including Pi profiles and the configured Pi agent directory. Selecting the current project scopes discovery to that project. The wizard then lets you choose individual resources, review masked previews, assign each saved resource to one or more groups, and confirm before anything is copied into the library. Declining authorization performs no search.

`groups` lists groups in a non-interactive terminal; group changes require a TTY and are saved only after confirmation. `list` is read-only. `apply --dry-run` prints the planned paths, masked text diffs, and warnings without changing the target. A real apply requires a TTY and confirmation.

Groups contain resource IDs, not merged documents. The same saved resource may belong to multiple groups. `copi` copies files byte-for-byte; it does not split, rewrite, merge, or run resource contents. It does not install dependencies or apply global-only resources to a project. Review every proposed change.

## Private storage and sensitive data

Snapshots and the catalog are stored under `~/.copi/` with owner-only directory/file permissions. `copi` copies the selected source into its library; it does not modify or delete the original. Snapshots remain available if the original is later removed. The copied content retains its original license and ownership; the MIT license for `copi` does not apply to imported resources.

Entire directories named `auth` (authentication-specific code may be missing), files named `auth.json`, `mcp-auth.json`, or `oauth.json`, `.env*` files, and repository/dependency/cache/history paths such as `.git`, `node_modules`, `.cache`, `.npm`, `cache`, `caches`, `history`, and `sessions` are excluded by the current resource filters. Do not use `copi` as a substitute for reviewing the files selected for copying.

Secret detection is heuristic and cannot guarantee completeness. Text previews and apply diffs are masked by default. Each detected potentially sensitive file requires its own explicit approval before saving and again before applying; other file contents may still contain secrets that detection misses. Review the masked preview and do not approve a file unless you have verified it yourself.

`copi` does not automatically transform resources for other AI tools, merge conflicting files, install dependencies, or apply global settings. Project placement of Pi user settings and MCP configuration preserves file contents; user-specific settings may not work in a project. `models.json` and `keybindings.json` are stored as reference-only resources and are not applied to projects.

Project subagent definitions require a compatible Pi setup; for Pi subagents, install and configure the `pi-subagents` package in the target environment yourself. `copi` does not install it.

## Development checks

```sh
npm run check
```

This performs the strict TypeScript build, Node.js test suite, and npm package dry run.
