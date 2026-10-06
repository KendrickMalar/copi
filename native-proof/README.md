# P1a exclusive placement prototype

This is a macOS-only, isolated proof under `native-proof/`; it is not product code and is not connected to the library, CLI, or package build. It covers only the three empty-destination races and one vacant placement path. Remaining P1 path/crash boundaries and all P2 recovery/cleanup work are out of scope for this slice.

## Experiment

`placement.test.mjs` launches the local C helper with `spawnSync(..., { shell: false })` and argv. The helper queries `getattrlist(ATTR_VOL_CAPABILITIES)` on the actual synthetic-root volume and requires both the valid bit and `VOL_CAP_INT_RENAME_EXCL`; unsupported or invalid capability reports fail closed. The tested volume reported valid interfaces `0x01ffffff` and capabilities `0x01af6fc7`, with the rename-exclusive bit set.

For each `file-parent`, `tree-target`, and `absent-sources-root` case, the helper:

1. Opens the canonical synthetic root and each parent path component with `O_NOFOLLOW`/dirfds.
2. Checks root, source-parent, destination-parent, and staged-directory dev/inode identities; requires the source to be a directory on the destination volume.
3. Confirms the final destination basename is absent with `fstatat(..., AT_SYMLINK_NOFOLLOW)`.
4. In race-test mode, inserts an empty competing directory immediately after that vacancy check and immediately before calling `renameatx_np(..., RENAME_EXCL)`.
5. Reports `EEXIST` and leaves the staged source and competing directory in place. The test compares the competitor's dev/inode/mode/empty children before/after and checks source payload bytes.

The vacant case verifies successful placement preserves staged-directory dev/inode and payload bytes. A malformed-argv case verifies nonzero exit without changing either source or destination. The helper has no ordinary-rename fallback.

## RED/GREEN evidence

- `evidence/placement-red.log` / `.exit`: the original three Node `rename()` races failed the preservation assertions (3 tests, 0 pass, 3 fail; exit 1). All roots were newly generated below ignored `native-proof/tmp/`. Each normal rename replaced an empty competitor with the staged directory; the log shows the inode, mode, and child-list change. Trailing horizontal whitespace in TAP formatting was stripped; assertion details, IDs, and counts are unchanged.
- `evidence/placement-capabilities.log` / `.exit`: actual volume capability query, exit 0.
- `evidence/placement-compile.log` / `.exit` and `placement-build-info.txt`: compiler invocation and target details.
- `evidence/placement-green.log` / `.exit`: three deterministic `RENAME_EXCL` collision refusals, vacant placement, and malformed argv (5 tests, 5 pass, 0 fail, 0 skipped; exit 0), with per-case inode/mode evidence.

The race is a deterministic synthetic interposition inside the helper, not a scheduler-stress test with a second process. The artifacts deliberately remain under `native-proof/tmp/` and are ignored by Git; the external competitor and staged source are not cleaned by the tests.

## Guarantee limits

- The syscall's `RENAME_EXCL` behavior is filesystem-capability-gated and was observed only on this current arm64 host/volume. Other volumes, macOS versions, and x64 are unverified.
- `renameatx_np` receives names, not an expected source inode. The helper checks source dev/inode immediately before the syscall and checks the placed inode after success, but the syscall is not conditional on the source basename still naming that inode. A source-name replacement in that interval is not proven safe by this prototype.
- Dirfds and component-wise `O_NOFOLLOW` checks reject symlink path components when opened and anchor the actual directories used. They do not prove that an opened directory cannot be moved elsewhere in the namespace concurrently.
- This slice does not test cleanup/unlink, crash/recovery, helper distribution/ABI, filesystem aliases, or the remaining P1 boundary matrix. It provides no product-level safety or adoption claim.
