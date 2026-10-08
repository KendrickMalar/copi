import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const macOsExclusiveLock = 0x20;

export interface StorageRootLease {
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

function sameRoot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.isDirectory() && right.isDirectory() && !left.isSymbolicLink() && !right.isSymbolicLink();
}

/** Holds a crash-released macOS O_EXLOCK on the library root directory descriptor. */
export async function acquireRootLease(root: string, waitMilliseconds = 0): Promise<StorageRootLease> {
  if (process.platform !== "darwin") {
    throw new Error("Copi storage mutation requires the macOS root O_EXLOCK lease; no fallback is available.");
  }
  if (!path.isAbsolute(root) || path.resolve(root) !== root || await realpath(root) !== root) {
    throw new Error("Copi storage root must be a canonical absolute directory for its O_EXLOCK lease.");
  }
  const before = await lstat(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Copi storage root is unsafe; refusing to acquire its O_EXLOCK lease.");
  }
  if (!Number.isSafeInteger(waitMilliseconds) || waitMilliseconds < 0) throw new Error("O_EXLOCK wait duration must be a nonnegative safe integer.");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const deadline = Date.now() + waitMilliseconds;
  while (!handle) {
    try { handle = await open(root, constants.O_RDONLY | macOsExclusiveLock | constants.O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EAGAIN" || code === "EWOULDBLOCK") && Date.now() < deadline) {
        await delay(Math.min(10, deadline - Date.now()));
        continue;
      }
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        throw new Error("Copi storage root remained leased by another process until the acquisition deadline; refusing mutation.", { cause: error });
      }
      throw new Error("Copi storage root O_EXLOCK lease is unavailable; refusing mutation without fallback.", { cause: error });
    }
  }
  try {
    const [opened, after, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(root, { bigint: true }),
      realpath(root),
    ]);
    if (canonical !== root || !sameRoot(before, opened) || !sameRoot(opened, after)) {
      throw new Error("Copi storage root identity changed while acquiring its O_EXLOCK lease.");
    }
    const expectedRoot = opened;
    let closed = false;
    return {
      async assertCurrent(): Promise<void> {
        if (closed) throw new Error("Copi storage root O_EXLOCK lease is closed.");
        const [currentHandle, currentPath, currentCanonical] = await Promise.all([
          handle!.stat({ bigint: true }), lstat(root, { bigint: true }), realpath(root),
        ]);
        if (currentCanonical !== root || !sameRoot(expectedRoot, currentHandle) || !sameRoot(expectedRoot, currentPath)) {
          throw new Error("Copi storage root identity changed while its O_EXLOCK lease was held.");
        }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await handle!.close();
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
