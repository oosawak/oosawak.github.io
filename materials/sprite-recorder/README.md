# VRM Sprite Recorder

VRMモデルとVRMAモーション（CC0）から、ゲーム用スプライトの土台になる「方向×アクションのグリッド動画」と「土台シート画像」を作る道具です。切り出しは [FrameCut Studio](https://oosawak.github.io/FramecutStudio/) で行う前提の形になっています。

- ソース: `~/workspace/vrm-viewer/recorder.js`（esbuild で `recorder-bundle.js` に束ねる）
- 既定のモデル: 真ミューズさん v1（`../muse-3d/muse-san.vrm`）
- 既定のモーション置き場: `../vrm-viewer/motions/`（Walk_Loop、Jog_Fwd_Loop、Jump_Loop、Sword_Attack、Idle_Loop、Hit_Chest など）

## 人の使い方

ページを開くとグリッドのプレビューが流れます。

- 「シート画像を作る」: 各セル（方向×アクション）ごとに、1ループを等分したフレームを並べた土台シートPNGを作ります
- 「動画を録画する」: グリッド動画（WebM、歩行1ループ×指定回数ぶん）を録画します
- 作ったものは「シートを保存」「動画を保存」のリンクからダウンロードできます
- セルの対応（どのセルがどの方向・どのモーションか）は、ページ下部のマニフェストJSONに出ます

## AI向けの使い方（URLパラメータ）

操作は全部URLパラメータで指定できます。状態は `document.title` と `window.__recorder`（`ready`、`manifest`、`sheetDataUrl`、`videoUrl`）に出るので、ブラウザを操作するAIが完了を判定できます。

| パラメータ | 意味 | 既定値 |
|---|---|---|
| `model` | VRMのURL | `../muse-3d/muse-san.vrm` |
| `motions` | VRMAの置き場URL | `../vrm-viewer/motions/` |
| `layout` | `2x2`（斜め4方向）／`4x2`（歩行8方向）／`4x4`（歩行8方向＋攻撃4方向＋ジャンプ・待機・やられ・走り） | `4x2` |
| `bg` | 背景色（クロマキー用、16進6桁） | `00ff00` |
| `w` / `h` | 動画の大きさ | `1280` / `720` |
| `frames` | シート1セルあたりのコマ数 | `4` |
| `loops` | 録画する歩行ループ数 | `2` |
| `capture` | `grid`（決めた時刻で1回だけ描いて止まる）／`sheet`（シートまで作って止まる） | なし（プレビュー再生） |
| `t` | 静止画モードの時刻（秒） | `0.4` |
| `front` | モデルの正面に合わせる回転補正（度）。真ミューズさん v1 は `0` で実測済み | `0` |

例: `index.html?layout=4x2&capture=sheet` を開くと、読み込み完了後に土台シートが `window.__recorder.sheetDataUrl` に入り、タイトルが `still-ready ...` になります。

## 方向の並び

- 2x2: 上段＝背面の左上・右上、下段＝正面の左下・右下
- 4x2: 上段＝左上・上（背面）・右上・右、下段＝左・左下・下（正面）・右下（時計回りの順）
- 4x4: 1〜2行目＝4x2と同じ歩行8方向、3行目＝剣攻撃（上・右・下・左）、4行目＝ジャンプ・待機・やられ・走り（いずれも正面）

正確な対応はマニフェストJSON（`cells` の `row`／`col`／`direction`／`motion`）が正本です。

## 次の工程

1. 録画したグリッド動画を FrameCut Studio に読み込み、セルごとにフレームを切り出す
2. 土台シート（または切り出したフレーム）を Codex の組み込み画像生成に参照として渡し、ポーズを保ったままキャラクターと絵柄に変換する
3. 変換済みのフレームをシートに組み、プレイヤーで歩かせて確認する

手順の正本は neta-cho の `tasks/sprite-4dir/2026-11-17-ai-sprite-4dir.md` です。
