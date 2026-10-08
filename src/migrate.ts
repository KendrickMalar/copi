import { confirm as clackConfirm } from "@clack/prompts";
import {
  commitMigration,
  prepareMigration,
  readMigration,
} from "./migration.ts";
import type {
  MigrationResolutionView,
  MigrationResult,
  MigrationView,
  PreparedMigration,
  PreparedMigrationResolution,
} from "./migration.ts";
import type { ChangeApproval } from "./resource-mutations.ts";
import { safeDisplay, withWizardLifecycle } from "./wizard.ts";

export interface MigrationCommandApi {
  prepareMigration: typeof prepareMigration;
  readMigration: typeof readMigration;
  commitMigration: typeof commitMigration;
  prepareMigrationResolution(libraryDir: string): Promise<PreparedMigrationResolution>;
  readMigrationResolution(plan: PreparedMigrationResolution): MigrationResolutionView;
  commitMigrationResolution(plan: PreparedMigrationResolution, approval: ChangeApproval): Promise<MigrationResult>;
}

export interface MigrationCommandRuntime {
  api?: MigrationCommandApi;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  confirm?: (message: string, initialValue: false, signal: AbortSignal) => Promise<unknown>;
  withLifecycle?: (operation: (signal: AbortSignal) => Promise<number>) => Promise<number>;
  write?: (text: string) => void;
}

export interface MigrationCommandFlags {
  readonly resolve: boolean;
  readonly dryRun: boolean;
}

const usageError = (): Error => new Error("Usage: copi migrate [--dry-run] | copi migrate --resolve [--dry-run].");

async function runWithWizardLifecycle(operation: (signal: AbortSignal) => Promise<number>): Promise<number> {
  let result = 1;
  await withWizardLifecycle(async (signal) => { result = await operation(signal); });
  return result;
}

export function parseMigrationArgs(args: readonly string[]): MigrationCommandFlags {
  let resolve = false;
  let dryRun = false;
  for (const argument of args) {
    if (argument === "--resolve" && !resolve) resolve = true;
    else if (argument === "--dry-run" && !dryRun) dryRun = true;
    else throw usageError();
  }
  return { resolve, dryRun };
}

function writeSafe(write: (text: string) => void, text: string): void {
  write(safeDisplay(text));
}

function displayReview(
  write: (text: string) => void,
  title: string,
  view: MigrationView | MigrationResolutionView,
): void {
  writeSafe(write, `${title}: ${view.status}\n`);
  if ("backupDir" in view && view.backupDir) writeSafe(write, `Verified backup: ${view.backupDir}\n`);
  for (const item of view.items) {
    writeSafe(write, `Resource: ${item.name} → ${item.target} (${item.selection})\n`);
  }
  for (const diff of view.maskedDiffs) {
    writeSafe(write, `\n${diff.path}\n${diff.summary}\n`);
  }
  for (const warning of view.warnings) {
    writeSafe(write, `Warning${warning.path ? ` (${warning.path})` : ""}: ${warning.message}\n`);
  }
  if (view.conflicts.length > 0) writeSafe(write, `Conflicts:\n${view.conflicts.map((entry: string) => `- ${entry}`).join("\n")}\n`);
  if (view.preservedPaths.length > 0) writeSafe(write, `Preserved paths:\n${view.preservedPaths.map((entry: string) => `- ${entry}`).join("\n")}\n`);
}

function isMigrationLockConflict(view: MigrationView): boolean {
  return view.conflicts.some((conflict) =>
    conflict.includes(".copi-transaction") || conflict.includes(".copi-migration-resolution.json") ||
    conflict.includes(".copi-transaction-recovery"));
}

async function defaultApi(): Promise<MigrationCommandApi> {
  const module = await import("./migration.ts");
  return module;
}

function requireResolutionApi(api: MigrationCommandApi): void {
  if (typeof api.prepareMigrationResolution !== "function" ||
      typeof api.readMigrationResolution !== "function" ||
      typeof api.commitMigrationResolution !== "function") {
    throw new Error("This build does not include the approved migration-resolution API.");
  }
}

async function promptForApproval(
  view: MigrationView | MigrationResolutionView,
  resolve: boolean,
  confirm: (message: string, initialValue: false, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<ChangeApproval | undefined> {
  const approvedSensitivePaths: string[] = [];
  const reviewQuestion = resolve
    ? "この masked diff をすべて確認し、解消手順の対象としてよいですか。"
    : "この masked diff をすべて確認し、移行内容の対象としてよいですか。";
  if (await confirm(reviewQuestion, false, signal) !== true || signal.aborted) return undefined;
  for (const sensitivePath of view.sensitivePaths) {
    const question = `秘密情報候補 ${sensitivePath} を個別に確認しましたか。内容は表示されません。`;
    if (await confirm(question, false, signal) !== true || signal.aborted) return undefined;
    approvedSensitivePaths.push(sensitivePath);
  }
  const finalQuestion = resolve
    ? "確認した sources の編集をそのまま保持し、移行終了を確定しますか。catalog・sources・items は書き換えません。検証済みバックアップを残し、所有を確認できる内部残物だけを片付けます。配布と items の削除は行いません。"
    : "移行を実行しますか。catalog を v2 に切り替え、検証済みバックアップを保持します。";
  if (await confirm(finalQuestion, false, signal) !== true || signal.aborted) return undefined;
  return { reviewId: view.reviewId, confirmed: true, approvedSensitivePaths };
}

function emitBlockedResolution(write: (text: string) => void, view: MigrationResolutionView): void {
  const baselineInsufficient = view.conflicts.some((conflict: string) => /v4|baseline-insufficient/i.test(conflict));
  if (baselineInsufficient) {
    writeSafe(write, "開始時 inventory が無いためこの解消手順では扱えません。従来の復旧／保持停止を維持します。\n");
  } else {
    writeSafe(write, "安全に解消できないため停止しました。編集と残物は保持しています。\n");
  }
  for (const conflict of view.conflicts) writeSafe(write, `- ${conflict}\n`);
  if (view.preservedPaths.length > 0) {
    writeSafe(write, `残している path:\n${view.preservedPaths.map((entry: string) => `- ${entry}`).join("\n")}\n`);
  }
  writeSafe(write, "原因を確認し、新しい検証buildやfresh reviewが必要な場合はその結果を確認してから再実行してください。\n");
}

async function runResolution(
  api: MigrationCommandApi,
  libraryDir: string,
  flags: MigrationCommandFlags,
  runtime: Required<Pick<MigrationCommandRuntime, "confirm" | "withLifecycle" | "write">>,
): Promise<number> {
  requireResolutionApi(api);
  const plan = await api.prepareMigrationResolution(libraryDir);
  const view = api.readMigrationResolution(plan);
  displayReview(runtime.write, "Migration resolution", view);
  if (view.status === "blocked") {
    emitBlockedResolution(runtime.write, view);
    return 1;
  }
  if (view.status === "not-needed") {
    writeSafe(runtime.write, "解消が必要な移行残物はありません。\n");
    return 0;
  }
  if (flags.dryRun) return 0;

  return runtime.withLifecycle(async (signal) => {
    const approval = await promptForApproval(view, true, runtime.confirm, signal);
    if (!approval || signal.aborted) {
      writeSafe(runtime.write, "解消は確定されませんでした。編集と残物は保持しています。\n");
      return 1;
    }
    const result = await api.commitMigrationResolution(plan, approval);
    writeSafe(runtime.write, "確認付き解消が完了しました。catalog・sources・items は書き換えていません。\n");
    if (result.backupDir) writeSafe(runtime.write, `検証済みバックアップ: ${result.backupDir}\n`);
    for (const preserved of result.preservedPaths) writeSafe(runtime.write, `保持: ${preserved}\n`);
    return 0;
  });
}

async function runOrdinaryMigration(
  api: MigrationCommandApi,
  libraryDir: string,
  flags: MigrationCommandFlags,
  runtime: Required<Pick<MigrationCommandRuntime, "confirm" | "withLifecycle" | "write">>,
): Promise<number> {
  const plan: PreparedMigration = await api.prepareMigration(libraryDir);
  const view = api.readMigration(plan);
  displayReview(runtime.write, "Legacy migration", view);
  if (view.status === "blocked") {
    if (isMigrationLockConflict(view)) {
      writeSafe(runtime.write, "移行終了確認が未完了です。編集とバックアップを保持しています。`copi migrate --resolve --dry-run` で確認してください。内部 lock を手で削除しないでください。\n");
    }
    return 1;
  }
  if (view.status === "already-v2") {
    writeSafe(runtime.write, "catalog はすでに v2 です。移行は必要ありません。\n");
    return 0;
  }
  if (flags.dryRun) return 0;

  return runtime.withLifecycle(async (signal) => {
    const approval = await promptForApproval(view, false, runtime.confirm, signal);
    if (!approval || signal.aborted) {
      writeSafe(runtime.write, "移行は確定されませんでした。library は変更していません。\n");
      return 1;
    }
    const result = await api.commitMigration(plan, approval);
    writeSafe(runtime.write, "移行が完了しました。\n");
    if (result.backupDir) writeSafe(runtime.write, `検証済みバックアップ: ${result.backupDir}\n`);
    for (const preserved of result.preservedPaths) writeSafe(runtime.write, `保持: ${preserved}\n`);
    return 0;
  });
}

export async function runMigrateCommand(
  args: readonly string[],
  libraryDir: string,
  runtime: MigrationCommandRuntime = {},
): Promise<number> {
  const flags = parseMigrationArgs(args);
  const stdinIsTTY = runtime.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = runtime.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const write = runtime.write ?? ((text: string) => process.stdout.write(text));
  if (!flags.dryRun && (!stdinIsTTY || !stdoutIsTTY)) {
    writeSafe(write, "migrate の変更には stdin/stdout の interactive TTY が必要です。--dry-run は read-only です。\n");
    return 1;
  }

  const api = runtime.api ?? await defaultApi();
  const confirm = runtime.confirm ?? (async (message: string, initialValue: false, signal: AbortSignal) =>
    clackConfirm({ message: safeDisplay(message), initialValue, signal }));
  const withLifecycle = runtime.withLifecycle ?? runWithWizardLifecycle;
  const dependencies = { confirm, withLifecycle, write };
  return flags.resolve
    ? runResolution(api, libraryDir, flags, dependencies)
    : runOrdinaryMigration(api, libraryDir, flags, dependencies);
}
