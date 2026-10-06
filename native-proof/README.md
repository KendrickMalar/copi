# P1a exclusive placement prototype

This is a macOS-only, isolated proof under `native-proof/`; it is not product code and is not connected to the library, CLI, or package build. P1a covers the three empty-destination races and one vacant placement path; P1b adds selected collision, parent/source-name, flag, and helper-termination boundaries. This is not the full P1 matrix: real cross-volume `EXDEV`, unsupported writable filesystems, other OS/architecture combinations, and all P2 recovery/cleanup work remain out of scope.

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
- This prototype does not test cleanup/unlink, journal-based recovery, helper distribution/ABI, or filesystem aliases. It provides no product-level safety or adoption claim.

## P1b boundary extension (synthetic fixtures only)

`placement-boundary.test.mjs` supplements, but does not repeat or replace, the original three empty-directory race proofs. Each collision hook creates its object after the vacancy and identity checks and immediately before the helper's single real `renameatx_np` call; the source comment and each JSON record explicitly identify this interposition point. The driver uses `shell: false` and fixed argv. Test hooks are prototype-only and do not add an ordinary-rename fallback. Only trailing horizontal whitespace was stripped from `evidence/P1b-red.log` for a clean diff check; test IDs, assertion text, and failure/pass counts were retained.

| Boundary | Observed result on this synthetic volume | Classification |
| --- | --- | --- |
| Empty directory, nonempty directory, file, symlink, same-bytes/different-inode directory at destination | Real `RENAME_EXCL` returned `EEXIST`; target dev/inode/mode and contents/children were unchanged; staged source inode and bytes were unchanged. The same-bytes collision also had distinct directory and payload-file inodes. | Observed for this volume only |
| Symlink destination ancestor | Component-wise `openat(..., O_NOFOLLOW)` rejected the symlink (`ENOTDIR` here); source and referent destination stayed unchanged. | Observed rejection at open time only |
| Parent path replaced after opening its dirfd | The fd continued to name the renamed original parent; placement landed beneath that moved parent while the replacement at the old path remained unchanged. | **LIMIT, not a safety pass** |
| Opened parent moved outside the synthetic root | The fd still placed the stage beneath the parent's new sibling path outside the root; the replacement parent remained untouched. | **LIMIT: dirfd does not confine namespace movement** |
| Final source basename replaced after source identity check | The real syscall moved the replacement inode; the old source was retained under a synthetic holding name. The post-placement check noticed the mismatch and exited nonzero, but only after the replacement was moved. | **LIMIT: `RENAME_EXCL` protects the destination from replacement, not the source identity** |
| Unsupported flag bit combined with `RENAME_EXCL` | The real syscall refused with `EINVAL`; staged source and vacant destination were unchanged. No ordinary rename fallback occurred. | Observed for this OS/volume only |
| Unknown-errno branch | A test-only `EACCES` injection took the generic stop path without making a filesystem syscall; source and destination stayed unchanged. | Control-flow check only; **not filesystem evidence** |
| Helper killed before syscall | `SIGKILL`, no destination, original source inode/bytes intact. | Observed at this synthetic boundary |
| Helper killed after successful syscall but before receipt | `SIGKILL`, source name absent, destination held the original inode/bytes. A caller would have an indeterminate receipt and must preserve state and stop rather than infer failure or clean up. | Observed outcome; no journal/recovery proof |
| Real cross-volume `EXDEV` / unsupported filesystem | Not tested: inventory found no other writable mount; alternate listed mounts were read-only for this process. No mount/OS changes were made and no errno was fabricated as filesystem proof. | **UNVERIFIED** |

The current synthetic volume advertised a valid `VOL_CAP_INT_RENAME_EXCL` capability and the real collision calls returned `EEXIST`. This says nothing about another volume or filesystem. Ancestor-symlink rejection does not prove an opened directory cannot be moved concurrently. The two parent-movement tests are explicit counterexamples to treating dirfds as namespace confinement. Source-name replacement likewise remains outside the syscall's conditional guarantees. No automatic adopt, delete, or cleanup policy is proved here.

The helper was compiled on the current arm64 host with `/usr/bin/clang -std=c11 -Wall -Wextra -Werror -O2 -arch arm64 -isysroot /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -mmacosx-version-min=10.12`. The observed SDK is 26.2 and the host is Darwin 27.0 arm64. This records the compile target only: x64 was not built/tested, no older runtime was tested, and the minimum supported macOS version is **unconfirmed** despite the compile-time deployment-target flag. Other OS releases, volumes, and unsupported-capability behavior remain unverified.
