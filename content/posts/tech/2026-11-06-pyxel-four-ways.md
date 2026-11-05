---
title: '4つ目のエンジン、GPUで描く'
subtitle: 'rustgames版の実装と計測'
author: ミューズさん
date: '2026-11-06'
category: コラム
summary: 'CubeBoyとLINE BOYに、GPUで描くrustgames版を加えて4方式で測り直しました。転送量は約3.65MBでpyxel-rustより重く、動き出すまでも少し遅い一方、実行中のCPUは同程度でした。ソースコードの行数も4方式で比べます。LINE BOYは、pyxel-rustの266行に対してrustgamesは1,501行と、エンジンが引き受ける範囲の違いがそのまま出ました。'
cover: tech/pyxel-four-ways.webp
cover_alt: 4台のゲーム機が並ぶイラスト。木の質感のもの、歯車と蝶ネクタイのもの、小さいもの、GPUファンを背負って立体迷路が浮かぶ大きいもの
type: article
---

[前編](https://oosawak.github.io/tech/#/post/tech/pyxel-three-implementations)では、Pyxelをめぐる3つの実装を比べました。\
[計測編](https://oosawak.github.io/tech/#/post/tech/pyxel-benchmark-results)では、同じゲームを3つの方式で動かして測りました。\
今回は、4つ目の方式としてrustgames版を加えます。

関連するコードは、GitHubの[pyxel-rust](https://github.com/oosawak/pyxel-rust)、[rustgames](https://github.com/oosawak/rustgames)と、本家の[Pyxel](https://github.com/kitao/pyxel)にあります。

## rustgamesに、2Dの層を作った

rustgamesは、最初からGPU（wgpu／WebGL）で3Dを描くエンジンです。\
2Dのゲームを載せる場所が無かったので、まず2Dを描く層を新しく作りました。\
やっていることは、正射影で色付きの三角形をまとめて描くことです。\
画像（テクスチャ）は使わず、四角・線・円といった基本図形と、5×7ドットの文字だけで画面を作ります。\
乱数はJavaScript版と完全に同じ決定的な生成を再現したので、部屋や地形は同じ種から同じ世界ができます。\
日本語の表示はページ側の表示に分け、音はページ側の簡単なビープで近似しました。

正直に書いておくと、まだ足りない部分もあります。\
LINE BOYでは、着地や走行のときの土ぼこりは未実装です（ジャンプのときの粒はあります）。\
大おばけボスの塗りも近似です。

## 測り直した

測り方は計測編と同じで、計測用のローカルサーバーから同じデータを配信し、各2回の平均です。

CubeBoy

| 方式 | 転送量 | 動き出すまで | スクリプトCPU |
|---|---|---|---|
| 本家Pyxel | 約27.4MB | 約5.4秒 | 約0.2% |
| pyxel-rust | 約2.1MB | 約1.0秒 | 約1.5% |
| JavaScript | 約0.14MB | 約2.2秒 | 約0.6% |
| rustgames | 約3.65MB | 約3.0秒 | 約2.6% |

LINE BOY

| 方式 | 転送量 | 動き出すまで | スクリプトCPU |
|---|---|---|---|
| 本家Pyxel | 約29.3MB | 約1.5秒 | 約0.2% |
| pyxel-rust | 約2.0MB | 約0.9秒 | 約3.3% |
| JavaScript | 約0.15MB | 約1.4秒 | 約1.3% |
| rustgames | 約3.65MB | 約2.2秒 | 約2.3% |

rustgamesの約3.65MBは、大半が1つのwasmファイル（約3.55MB）です。\
このファイルには、wgpuの仕組みと、rustgamesの全タイトル分のコードが入っています。\
2本とも同じ重さなのは、そのためです。\
ゲーム1本だけの重さではありません。

動き出すまでは、pyxel-rustより少し遅い結果でした。\
wasmのコンパイルの分と思われます。\
実行中のCPUは、pyxel-rustと同程度の約2〜3%でした。

FPSは、今回も断定しません。\
計測器の中ではrustgamesが低く出ましたが（CubeBoy約7、LINE BOY約11）、同じ環境で測った既存のwgpuタイトルでも表示が低く出ることを確認済みで、計測器の癖と判断しています。

## ソースの行数を比べる

ゲーム本体のコードの行数です（JavaScript版だけは、HTMLファイル全体の行数です）。

| 方式 | CubeBoy | LINE BOY |
|---|---|---|
| 本家Pyxel（Python） | 781行 | 1,212行 |
| pyxel-rust（Rust） | 511行 | 266行 |
| JavaScript | 464行 | 629行 |
| rustgames（Rust） | 973行 | 1,501行 |

rustgames版には、このほかに共通の2D描画層が597行あります。\
ゲーム側は、その層を部品として使います。

一番差が出たのは、LINE BOYです。\
pyxel-rustの266行は、PyxelのAPIがタイルマップや描画を引き受けている分です。\
rustgamesの1,501行は、その引き受け手が無い場所に、全部を自分で書いた分です。\
行数だけで言えば、CubeBoyはJavaScript版が一番短く、LINE BOYはpyxel-rust版が一番短いです。\
エンジンやAPIが引き受ける範囲の違いが、そのまま行数に出ています。

なお、計測編と同じく、コードは方式ごとに別物です。\
「方式そのものの実力差」というより、「この4つの実装の実測」として読んでください。

## 実際に遊べます

CubeBoy・[本家Pyxel版](https://oosawak.github.io/html-player/games/cube-boy-pyx/)

```embed
https://oosawak.github.io/html-player/games/cube-boy-pyx/
512x512
70%
```

CubeBoy・[pyxel-rust版](https://oosawak.github.io/pyxel-rust/examples/cubeboy/)

```embed
https://oosawak.github.io/pyxel-rust/examples/cubeboy/
512x512
70%
```

CubeBoy・[JavaScript版](https://oosawak.github.io/html-player/games/cube-boy/)

```embed
https://oosawak.github.io/html-player/games/cube-boy/
512x512
70%
```

CubeBoy・[rustgames版](https://oosawak.github.io/rustgames/play/cubeboy/)

```embed
https://oosawak.github.io/rustgames/play/cubeboy/
512x512
70%
```

LINE BOY・[本家Pyxel版](https://oosawak.github.io/html-player/games/line-boy-pyx/)

```embed
https://oosawak.github.io/html-player/games/line-boy-pyx/
512x512
70%
```

LINE BOY・[pyxel-rust版](https://oosawak.github.io/pyxel-rust/examples/lineboy/)

```embed
https://oosawak.github.io/pyxel-rust/examples/lineboy/
512x512
70%
```

LINE BOY・[JavaScript版](https://oosawak.github.io/html-player/games/line-boy/)

```embed
https://oosawak.github.io/html-player/games/line-boy/
512x512
70%
```

LINE BOY・[rustgames版](https://oosawak.github.io/rustgames/play/lineboy/)

```embed
https://oosawak.github.io/rustgames/play/lineboy/
512x512
70%
```

4方式がそろいました。\
同じゲームでも、置く場所が変わると、重さも速さも書き方も変わります。\
数字と実物で確かめられるのが、この実験の一番の収穫です。
