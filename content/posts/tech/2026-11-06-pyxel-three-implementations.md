---
title: 'レトロゲームエンジン'
subtitle: 'Lyre3 Gamesの、Pyxelをめぐる3つの実装'
author: ミューズさん
date: '2026-11-06'
category: コラム
summary: 'Lyre3 Gamesでは、レトロゲームエンジンを作り、そのエンジンでゲームを作っています。その題材であるPyxelをめぐる3つの実装を比べます。Pythonで書く本家、そのAPIをRustとWASMの軽い経路へ移したpyxel-rust、互換を追わずGPUで3Dを描くrustgames。GitHubでは「フォーク」と登録されながら中身は独立に作った、pyxel-rustの生い立ちも紹介します。'
cover: tech/pyxel-three-implementations.webp
cover_alt: 1本の根から3本の枝が伸び、それぞれの先にレトロゲームの画面（迷路とヘビ、宇宙船と歯車、ネオンの3Dトンネル）が付いているイラスト
type: article
---

Lyre3 Gamesでは、レトロゲームエンジンを作り、そのエンジンでゲームを作っています。\
題材にしているのは、Pyxel（ピクセル）という小さなレトロゲームエンジンです。\
私の周りには、このPyxelをめぐって、作り方の違う3つの実装があります。\
本家と、その名前を受け継いだ私の2つです。

## まず、系譜の話から

GitHubの上では、私の[pyxel-rust](https://github.com/oosawak/pyxel-rust)は、本家[kitao/pyxel](https://github.com/kitao/pyxel)の「フォーク」として登録されています。\
2026年3月にフォークした記録が、そのまま残っているからです。\
ただし、フォークした時点の本家（Pyxel v2.7.10）は、mainブランチに手つかずで残してあるだけです。

実際に育ててきたmasterブランチは、本家と共通の祖先を持たない、独立した履歴になっています。\
2026年5月から6月にかけての431コミットがそれで、作業はCopilotと一緒に進めました。\
つまり「フォーク」と書いてあるのに、中身はゼロから作った別物、という少し変わった生い立ちです。

## 本家Pyxel ― Pythonで手軽に

本家の[Pyxel](https://github.com/kitao/pyxel)は、ゲームをPythonで書くエンジンです。\
書きやすさが売りで、思いついたらすぐ試せる手軽さがあります。\
エンジンの芯はRustで作られていて、Webで遊ばせるときはPythonの実行環境ごとブラウザへ運ぶ（Emscriptenという）方式です。\
「配布物としてのエンジン」がきちんと整っているのが、本家の強みです。

## pyxel-rust ― APIの世界を、RustとWASMへ

[pyxel-rust](https://github.com/oosawak/pyxel-rust)は、本家のAPIの世界を、RustとWASMの軽い経路へ移した実装です。\
ゲーム自体をRustで書き、wasm-bindgenで直接WASMにします。\
ブラウザでの描画はCanvas 2Dが中心で、wgpuを使う描画方式も選べます。\
init／run／cls／blt／textといった本家の主要なAPIは、コードを持ってきたのではなく、同じ使い方になるよう作り直した互換実装です。\
デスクトップでは、本家のpyxel-core（SDL2）を描画側に使う選択肢もあります。\
Python製の道具（run／app2html）も付いていて、GitHub Pagesにはブラウザで遊べるデモ（Arisa Questなど）が並んでいます。

## rustgames ― 互換を追わない3D

[rustgames](https://github.com/oosawak/rustgames)は、Pyxelとは系譜の関係がない、完全な独自実装です。\
Rustとwgpu／WebGLで、最初からGPUで3Dを描くためのエンジンと、それで作ったゲーム集になっています。\
霧や点光源、迷路の自動生成、敵AIの経路探索、FPS視点のカメラ、パーティクルといった仕組みを、エンジン側に内蔵しています。\
Neon Maze 3D、Neon Blast 3D、Earth Defenseといった3Dゲームが入り、[プレイ用ページ](https://oosawak.github.io/rustgames/play/)からブラウザで遊べます。\
JavaScript側のエンジンライブラリ（engine.js）も持っています。

## 並べてみると

|  | 本家Pyxel | pyxel-rust | rustgames |
| --- | --- | --- | --- |
| ゲームを書く言語 | Python | Rust | Rust |
| ブラウザでの動かし方 | Pythonの実行環境ごと運ぶ | WASMに直接変換 | WASMに直接変換 |
| 描画 | エンジン内蔵 | Canvas 2D／wgpu | wgpu／WebGL（3D） |
| 本家APIとの互換 | 本家そのもの | 主要APIを互換実装 | 目指さない |
| 位置づけ | 配布物のエンジン | APIの世界を軽い経路へ移した2D実装 | GPUで3Dを描く本格派 |

## 一言で言うと

本家は「Pythonで手軽に作る、配布物のエンジン」です。\
pyxel-rustは「そのAPIの世界を、RustとWASMの軽い経路へ移した2D実装」です。\
rustgamesは「互換を追わず、最初からGPUで3Dを描く系統」です。

同じ「ゲームを作る」でも、言語と実行の経路が違えば、できあがりの性格も変わります。\
土台の選び方が、そのまま作品の性格になるのだと思います。

## 計測編へ続く

「では、実際に速いのはどれなのか」。\
それは、測ってみないと分かりません。\
いま、CubeBoyとLINE BOYという2つのゲームを、本家Pyxel／pyxel-rust／素のJavaScriptの3つの方式で動かして、起動の速さやフレームレート、読み込むデータの量を比べる準備を進めています。\
結果が出たら、続編で報告します。
