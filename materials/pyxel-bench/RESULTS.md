# ベンチマーク結果：CubeBoy / LINE BOY を3方式で測る（2026-11-06）

計測環境：ヘッドレス Chrome（SwiftShader ソフトウェア描画）、計測用にローカルサーバーから同一データを配信（ネットワークのぶれを除くため）。各2回計測の平均寄り。

## CubeBoy

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
|---|---|---|---|---|
| 本家 Pyxel（Python/Pyodide） | 約27.4MB | 約5.4秒 | 61.5（上限） | 約0.2% |
| pyxel-rust（Rust/WASM） | 約2.1MB | 約1.0秒 | 61.5（上限） | 約1.5% |
| 素の JavaScript | 約0.14MB | 約2.2秒 | ※下記 | 約0.6% |

## LINE BOY

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
|---|---|---|---|---|
| 本家 Pyxel（Python/Pyodide） | 約29.3MB | 約1.5秒 | 60.4 | 約0.2% |
| pyxel-rust（Rust/WASM） | 約2.0MB | 約0.9秒 | 58.5 | 約3.3% |
| 素の JavaScript | 約0.15MB | 約1.4秒 | ※下記 | 約1.3% |

## 読み方と注意

- 本家 Pyxel の Web 版は、Pyxel 本体（wheel 約4.7MB）に加えて Python 実行環境（Pyodide 一式）を毎回読み込むため、転送量が桁違いに大きい。起動の待ち時間もその分長い。
- pyxel-rust は WASM 本体のみで約2MB、起動は最速級。実行中の CPU は3方式の中で一番使う（LINE BOY で約3.3%）。それでも軽い範囲。
- JavaScript 版は転送量が最小（約0.14MB）。起動はフォント等の読み込み分だけ Pyxel より速く、Rust と同程度。
- ※FPS の注意：計測器（ヘッドレス環境）内では、JavaScript 版の「提示フレーム数」が CubeBoy 約7、LINE BOY 約20 と低く出た。再測定でも同じ傾向だったが、フレーム生成を促す条件では rAF が約62/秒で回ることを別途確認しており、これは実機ブラウザでの体感速度ではなく、ヘッドレス計測の癖と判断した。Pyxel と pyxel-rust は計測器内でも表示上限（約60）に張り付いた。記事では FPS を断定せず、この癖ごと書くのが正直な形。
- 前提の但し書き：同じゲームでもコードは方式ごとに別物なので、「方式そのものの実力差」というより「この3つの実装の実測」として読む数字。

生データ：results.json（最終ラン）、bench-run2.log（本計測）、results-run3-unpatched.json、bench-run4-js.log（JS再測定）。スクリーンショット shot-*.png で全タイトル描画を確認済み。

---

# 追記：4方式目 rustgames 版（2026-11-06 追加計測）

同じ物差し（bench.js のコピー bench4.js、ヘッドレス Chrome＋SwiftShader、ローカル配信、各2回の平均）で rustgames 版（Rust + wgpu/WebGL、今回新規実装）を追加計測した。

## CubeBoy

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
|---|---|---|---|---|
| rustgames（Rust/wgpu WASM） | 約3.65MB | 約3.0秒 | 7.4 ※下記 | 約2.6% |

## LINE BOY

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
|---|---|---|---|---|
| rustgames（Rust/wgpu WASM） | 約3.65MB | 約2.2秒 | 11.2 ※下記 | 約2.3% |

## 読み方と注意（rustgames 分）

- 転送量は両ゲーム共通の単一 wasm（約3.55MB、全タイトル合算のエンジン込み）にページ HTML/JS を加えた実測。pyxel-rust（約2MB）より大きいのは、wgpu スタックと rustgames 全ゲーム分のコードを含む単一バイナリのため。ゲーム単体の増分ではない。
- ※FPS の注意：wgpu の提示フレーム数はこのヘッドレス環境（SwiftShader のソフトウェア描画）で低く出る。既存の wgpu タイトル Neon Blast 3D でも同じ環境で HUD 表示 22 FPS 程度だった。実機 GPU での体感速度ではない点は JS 版の癖と同じ扱い。
- スクリプト CPU は pyxel-rust と同程度（約2〜3%）。起動は wasm のコンパイル分だけ pyxel-rust より遅い。

生データ：results-rustgames.json。スクリーンショット：shot-CubeBoy-rustgames.png / shot-LINEBOY-rustgames.png（どちらもゲーム画面で確認済み）。
