# instruction 参照導線の確認・追記（Issue #7）設計

- 作成日: 2026-10-11
- 対象 Issue: #7「instruction適用時に、Piが読み込むための参照導線を確認・案内する」
- 状態: 設計承認済み（2026-10-11）、spec レビュー待ち

## 1. 目的

`copi apply` で任意名の instruction（例: `RULES.md`）を配置しても、Pi はそのファイルを自動で読まない。
適用の成功と「Pi が読む状態」を区別し、参照が無い場合は利用者に知らせ、承認があれば参照行を追記できるようにする。

## 2. 前提（事実）

Pi が自動で読む指示ファイル（`@earendil-works/pi-coding-agent` docs/configuration.md）:

- context file: 作業ディレクトリと親ディレクトリの `AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`。同じディレクトリでは `AGENTS.override.md` が `AGENTS.md`・`CLAUDE.md` を置き換える。
- project `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`。

参照行は Pi が展開する仕組みではない。モデルが読んで従うための案内文である。

## 3. 決定事項

| 論点 | 決定 | 理由・補足 |
| --- | --- | --- |
| 対応範囲 | **警告に加え、明示承認があれば参照行を追記する** | ユーザー裁定 |
| 方式 | **apply の計画（`ApplyPlan`）に組み込む** | dry-run と実適用の案内・差分を一致させるため。別コマンド案は不採用 |
| 追記先 | **プロジェクトルートの既存 context file を Pi の優先順で 1 つ選ぶ。無ければ `AGENTS.md` を新規作成** | 優先順: `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD` |
| 参照ありの判定 | **ルートの context file のどれかが配置先の相対パス文字列を含めば参照あり** | 手書きの参照も認める。偶然の一致は許容する |
| 判定の範囲 | **プロジェクトルートのみ** | 親ディレクトリ・agent dir は見ない（仮置き。対象外として README に明記） |
| 参照行の文面 | **`- 作業を始める前に \`<path>\` を読み、その指示に従うこと。`** | ユーザー裁定（日本語）。instruction 1 件につき 1 行 |
| 承認 | **個別の確認、既定 no。no でも apply は続行し警告を残す** | 既存ファイルの無断変更をしない |

## 4. 振る舞い

### 4.1 判定（新規 `src/instruction-reference.ts`、純関数中心）

1. group 内の kind が `instruction` で、destination が project の項目を対象にする。
2. 配置先の basename が context file 名のどれか、または配置先が `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` なら、自動読込として対象外。
3. 残りの配置先それぞれについて、ルートの context file（存在するもの全て）の UTF-8 内容に相対パス文字列が含まれるかを調べる。含まれないものを「参照なし」とする。
4. 参照なしが 1 件以上あれば警告 `instruction-not-loaded`（path ごと）を出す。

### 4.2 追記の提案

- 参照なしがあれば `ApplyPlan.referenceProposal` を作る:
  - `path`（追記先の相対パス）、`status`（`"append"` | `"new"`）、`instructionPaths`、マスク済み `preview`。
  - 内部状態（`planState`）に追記後の bytes・mode・追記前の sha256/mode を保持する。
- 追記内容: 既存内容が改行で終わらなければ `\n` を補い、空行を 1 つ置いてから参照行を並べる。新規作成時は参照行のみ（末尾改行あり）、mode `0o644`。
- 既存ファイルの mode は維持する。

### 4.3 提案しない場合（警告と手動手順のみ）

- 同じ group がルートの context file 自体を配置する場合（大文字小文字を区別せず判定）（2026-10-11 改訂）。配置予定の context file は配置予定の候補 bytes（いずれかの候補）で、配置予定でないものは現在の内容で参照を判定し、参照が無ければ警告に手動で追記する行を含める。
- 追記先が symlink・通常ファイル以外・UTF-8 として読めない・1 MB 超の場合。
- いずれも警告メッセージに追記すべき行をそのまま示す。

### 4.4 dry-run

`formatPlan` に次を出す:

- 警告 `instruction-not-loaded`。
- 提案がある場合: `reference (optional, approval required): <path>` と差分、「実適用で承認した場合のみ追記する」旨。

### 4.5 実適用（ウィザード）

- 通常ファイルの判断の後、最終確認の前に `confirm`（既定 no）: `Add a reference line for <paths> to <path>?`。
- Cancel/Ctrl-C は既存と同じく apply 全体を中止する。no は追記なしで続行する。
- 最終確認後の結果表示に、追記したかを含める。

### 4.6 実行（`executeApply`）

- `ApplyDecisions.addReference === true` のときだけ、追記を通常の `WriteOperation` として加える。
- 既存ファイルは既存の非公開 backup（`createBackupSet`）の対象にする。
- 書込み直前に追記先の sha256/mode が計画時と一致することを確認する。不一致なら既存と同じく `Destination changed ...` で止める。新規作成は存在しないことを確認する。
- `referenceProposal` が無い計画で `addReference` が true なら拒否する。
- `ApplyResult` に `referenceAdded: string | undefined` を加える。

## 5. 対象外

- 親ディレクトリや agent dir の context file の判定・編集。
- 参照行の削除や重複整理。
- instruction 以外の kind。
- 非対話の追記（`--yes` 等は作らない）。

## 6. テスト

`test/` に追加（既存の apply テストの書き方に合わせる）:

1. 任意名・参照なし・既存 `AGENTS.md` あり → 警告と追記提案。承認で末尾に追記、backup あり。
2. 任意名・参照なし・context file なし → `AGENTS.md` 新規作成の提案。
3. 任意名・参照あり（手書き） → 警告なし・提案なし。
4. 配置先が `AGENTS.md` / `.pi/APPEND_SYSTEM.md` → 対象外。
5. `AGENTS.override.md` と `AGENTS.md` が両方ある → 追記先は override。
6. group がルートの `AGENTS.md` も配置する → 提案なし、参照が無ければ手動手順つき警告。
7. 承認しない → 追記されず他は適用される。
8. 計画後に追記先が変わる → 書き込まず失敗。
9. 追記先が symlink → 提案なし・警告のみ。
10. dry-run 出力と実適用前の表示で、警告と差分が一致する。
11. 末尾改行なしの既存ファイルへの追記結果が期待どおり。

README の apply 節と `copi help` に説明を追加する。

## 7. 残論点

- 判定の範囲（ルートのみ）は仮置き。運用で親ディレクトリの context file を使う例が出たら見直す。
