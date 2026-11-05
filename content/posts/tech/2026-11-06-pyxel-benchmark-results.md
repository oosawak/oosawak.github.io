---
title: '同じゲーム、3つの速さ'
subtitle: 'Pyxel／pyxel-rust／JavaScriptの計測編'
author: ミューズさん
date: '2026-11-06'
category: コラム
summary: '前編で比べた3つの実装を、同じゲームで実際に動かして測りました。CubeBoyとLINE BOYを、本家Pyxel／pyxel-rust／素のJavaScriptで動かし、転送量・動き出すまでの時間・FPS・実行中のCPUを比べます。転送量は本家が約27〜29MB、pyxel-rustが約2MB、JavaScriptが約0.14MBと、桁の違う結果でした。FPSについては、計測器の癖も含めて正直に書きます。'
cover: tech/pyxel-benchmark-results.webp
cover_alt: 大きなリュックを背負ったゲーム機、羽の生えたゲーム機、疾走する小さなゲーム機が、ストップウォッチと巻き尺のあるトラックに並ぶイラスト
type: article
---

[前編](https://oosawak.github.io/tech/#/post/tech/pyxel-three-implementations)では、Pyxelをめぐる3つの実装を比べました。\
今回は続編として、同じゲームを3つの方式で実際に動かして、数字を測りました。\
関連するコードは、GitHubの[pyxel-rust](https://github.com/oosawak/pyxel-rust)と、本家の[Pyxel](https://github.com/kitao/pyxel)にあります。

## 測り方

題材は、CubeBoyとLINE BOYという2つのゲームです。\
どちらも、本家Pyxel（Python）／pyxel-rust（Rust）／素のJavaScriptの3つの形がそろっています。\
計測用にローカルサーバーから同じデータを配信し、ネットワークのぶれを除いて、各2回測りました。\
測ったのは、読み込むデータの量（転送量）、動き出すまでの時間、FPS（1秒あたりの画面の更新回数）、実行中のスクリプトのCPU使用率です。

## 結果

CubeBoyの結果です。

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
| --- | --- | --- | --- | --- |
| 本家Pyxel | 約27.4MB | 約5.4秒 | 61.5（上限） | 約0.2% |
| pyxel-rust | 約2.1MB | 約1.0秒 | 61.5（上限） | 約1.5% |
| 素のJavaScript | 約0.14MB | 約2.2秒 | ※後述 | 約0.6% |

LINE BOYの結果です。

| 方式 | 転送量 | 動き出すまで | FPS（計測器内） | スクリプトCPU |
| --- | --- | --- | --- | --- |
| 本家Pyxel | 約29.3MB | 約1.5秒 | 60.4 | 約0.2% |
| pyxel-rust | 約2.0MB | 約0.9秒 | 58.5 | 約3.3% |
| 素のJavaScript | 約0.15MB | 約1.4秒 | ※後述 | 約1.3% |


## 遊べる場所と、実際の画面

測った実物は、全部ブラウザで遊べます。\
JavaScript版は、この記事の中でそのまま遊べます。\
ほかの方式の画面は、計測のときに撮ったものです。

CubeBoyは、[本家Pyxel版](https://oosawak.github.io/html-player/games/cube-boy-pyx/)／[pyxel-rust版](https://oosawak.github.io/pyxel-rust/examples/cubeboy/)／[JavaScript版](https://oosawak.github.io/html-player/games/cube-boy/)です。

![CubeBoy（本家Pyxel版）の画面](tech/bench-cubeboy-pyxel-v2.webp)

![CubeBoy（pyxel-rust版）の画面](tech/bench-cubeboy-rust.webp)

CubeBoy（JavaScript版）は、ここで遊べます。

```embed
https://oosawak.github.io/html-player/games/cube-boy/
960x720
```

LINE BOYは、[本家Pyxel版](https://oosawak.github.io/html-player/games/line-boy-pyx/)／[pyxel-rust版](https://oosawak.github.io/pyxel-rust/examples/lineboy/)／[JavaScript版](https://oosawak.github.io/html-player/games/line-boy/)です。

![LINE BOY（本家Pyxel版）の画面](tech/bench-lineboy-pyxel-v2.webp)

![LINE BOY（pyxel-rust版）の画面](tech/bench-lineboy-rust.webp)

LINE BOY（JavaScript版）は、ここで遊べます。

```embed
https://oosawak.github.io/html-player/games/line-boy/
960x720
```

## 転送量は、桁が違った

一番差が出たのは、転送量です。\
本家Pyxelは約27〜29MBと、桁違いに大きい結果でした。\
これは、Pyxel本体（約4.7MB）に加えて、Pythonの実行環境（Pyodide）一式を毎回読み込むためです。\
pyxel-rustはWASM本体だけで約2MB、JavaScriptは約0.14MBで最小でした。\
「開いてすぐ遊べる」かどうかは、まずこの量で決まります。

## 動き出すまでは、pyxel-rustが最速級

動き出すまでの時間は、pyxel-rustが約1秒で最速級でした。\
JavaScriptは約1.4〜2.2秒で、本家PyxelはLINE BOYで約1.5秒、CubeBoyで約5.4秒でした。\
本家は、実行環境を立ち上げるところから始まる分、待ち時間が出ます。

## FPSは、断定しません

FPSについては、正直に書いておきます。\
Pyxelとpyxel-rustは、計測器の中でも表示の上限（約60）に張り付きました。\
一方のJavaScript版は、計測器（ヘッドレス環境）の中では「提示されたフレーム数」がCubeBoyで約7、LINE BOYで約20と、低く出ました。\
ただし、フレーム生成を促す条件では、更新の合図（rAF）が1秒に約62回まわることも別に確認しています。\
これは実機で遊ぶときの体感速度ではなく、計測器側の癖と判断しました。\
なので、この記事ではFPSの勝敗は断定しません。

## CPUは、どれも軽い

実行中のスクリプトのCPU使用率は、3方式とも軽い範囲でした。\
一番使うpyxel-rustでも、LINE BOYで約3.3%です。\
重い処理をしているわけではない、という確認が取れました。

## 但し書き

同じゲームでも、コードは方式ごとに別物です。\
ですからこの数字は、「方式そのものの実力差」というより、「この3つの実装を測ったら、こうだった」という実測として読んでください。

## 一言で言うと

入口の軽さ（転送量と起動）は、WASMに直接変換するpyxel-rustと、素のJavaScriptが軽く、本家は実行環境ごと運ぶ分が大きく出ました。\
作りやすさの本家、軽い経路のpyxel-rust、最小のJavaScript。\
前編で書いた性格の違いが、数字にもそのまま表れたと思います。
