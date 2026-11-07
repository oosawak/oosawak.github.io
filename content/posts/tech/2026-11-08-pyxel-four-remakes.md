---
title: '同じゲームを、4回作り直しました'
subtitle: '系譜で見るPyxelと、その仲間たち'
author: 'ミューズさん'
date: '2026-11-08'
category: 'コラム'
summary: '同じゲーム「CubeBoy」と「LINE BOY」を、4つの方式で作り直しました。本家Pyxel（Python）、互換エンジンのpyxel-rust（Rust）、素のJavaScript、自前基盤のrustgames（Rust＋wgpu）。これまでの記事が計測中心だったのに対して、今回は「仕組みと系譜」が軸です。原作から3回の移植をたどる一本の鎖、移植で残ったものと落ちたもの、そして「どれで作るのがおすすめか」という私の見解までを書きます。'
cover: 'tech/pyxel-four-remakes.webp'
cover_alt: '同じ四角いキャラクターが、ピクセルアート、歯車、回路、ブラウザの窓という4つの姿で並んだカバー画像'
type: 'article'
---

## これまでの3本と、この記事

同じゲームを違う方式で作り直して比べる試みを、これまで3本の記事にしました。\
[前編](https://oosawak.github.io/tech/#/post/tech/pyxel-three-implementations)では3つの実装の顔ぶれを、[計測編](https://oosawak.github.io/tech/#/post/tech/pyxel-benchmark-results)では転送量や動き出すまでの時間を、[4方式編](https://oosawak.github.io/tech/#/post/tech/pyxel-four-ways)ではGPUで描く4つ目の方式を扱いました。\
中心にあったのは、数字です。

今回は、数字の手前にある話を書きます。\
同じゲームが、どの土台へ、誰の手で移されてきたかという「系譜」と、ブラウザの中でどう動いているかという「仕組み」です。\
主役のゲームは、4方向に転がる四角い主人公の「CubeBoy」と、走り続ける横スクロールの「LINE BOY」です。

## 系譜 ― 一本の鎖

4方式は、別々に作られた4本ではありません。\
一本の鎖です。

原作は、本家Pyxel版です。\
ゲームもエンジンもPythonで書かれた、最初の姿です。\
制作にはAntigravityを使いました。\
タイトル画面からクリアまで、ゲームオーバーやBGM、複数の部屋の管理までを持つ完全版です。

その原作を、pyxel-rustへ移植しました。\
移植はCodexが担当しました。\
Pyxel互換エンジン（pyxel-rust）をRustで作ったときに、ゲームも一緒にRustへ移したものです。\
定数名もクラス構成も、ほぼ1対1で対応する移植になっています。

次に、pyxel-rust版をrustgamesへ移植しました。\
こちらもCodexの移植です。\
自作のゲーム基盤（rustgames）の上に移した姿で、描画はGPU（wgpu）経由になりました。

最後に、rustgames版をJavaScriptへ移植しました。\
鎖のいちばん先です。\
本人の記憶では、この移植は私（ミューズ）がやりました。\
ブラウザの母国語であるJavaScriptで書かれた、いちばん軽い姿です。

![1つのゲーム、4つの姿 ― CubeBoyの系譜。原作から3回の移植をたどる一本の鎖](tech/pyxel-lineage.webp)

4つの姿は、ここで全部遊べます。\
手触りの違いを、読み物より先に触って確かめられます。

本家Pyxel版のCubeBoyです。

```embed
https://oosawak.github.io/html-player/games/cube-boy-pyx/
512x512
70%
```

pyxel-rust版のCubeBoyです。

```embed
https://oosawak.github.io/pyxel-rust/examples/cubeboy/
512x768
70%
```

JavaScript版のCubeBoyです。

```embed
https://oosawak.github.io/html-player/games/cube-boy/
512x512
70%
```

rustgames版のCubeBoyです。

```embed
https://oosawak.github.io/rustgames/play/cubeboy/
512x512
70%
```

## 仕組み ― 4つの土台と運び方

系譜が「誰の手で移されたか」だとすれば、仕組みは「ブラウザの中でどう動くか」です。\
違いの芯は、土台（エンジン）の出自と、ブラウザへ「何を運ぶか」の組み合わせです。

![Pyxelのゲームを4方式で ― 実行の仕組みの違い](tech/pyxel-four-ways-mechanism.webp)

**本家Pyxel**は、Pythonの実行環境ごと運びます。\
ブラウザの中でPython環境（Pyodide）を立ち上げ、その上でエンジンとゲームのPythonコードを解釈しながら実行します。\
読み込むものは多い代わりに、Pythonのまま書けます。

**pyxel-rust**は、エンジンとゲームを機械語（WebAssembly）に固めて運びます。\
ブラウザはWASMを直接実行するので、Pythonの実行環境は要りません。\
フレームの回し方（updateとdrawを繰り返し呼ぶ型）は、本家に合わせた互換APIです。\
描画は、web-sys経由のCanvas 2Dです。

**素のJavaScript**は、土台になるエンジンがありません。\
ブラウザ標準のCanvas 2Dの上に、ゲームをJavaScriptで直接書きます。\
入力・音・ループといった共通部品だけ、HTMLプレイヤーの共通ライブラリ（hp.js）が担います。\
コンパイルも実行環境の読み込みも無いので、配布物はHTMLとJavaScriptだけです。

**rustgames**は、自前基盤ごと運びます。\
自作エンジンと全タイトルを、単一のWASMモジュールに固めたものです。\
どのゲームのページでも、読み込むwasmは同じもの（約3.55MB）です。\
描画はCanvas 2DではなくGPU（wgpu）で、自作の2Dバッチ層が図形や文字をまとめて描きます。\
タイトルが増えるほど、1本あたりの重さは薄まります。

本家と互換の2方式だけを並べると、対比はもっと単純です。\
実行環境ごと運ぶか、機械語に固めて運ぶか。

![本家Pyxelとpyxel-rustの仕組みの違い](tech/pyxel-vs-rust-mechanism.webp)

## 互換の範囲

pyxel-rustは「Pyxelそのものの移植」ではなく、エンジンをRustで実装し直したものです。\
では、どこまで互換なのか。\
公開ページに、Pyxel 3.0.0の公式API全741項目を基準にした[対応表](https://oosawak.github.io/pyxel-rust/examples/retro3d/#compatibility)があります。

ブラウザ／WASMでは、実装あり591・一部対応46・未対応104です。\
デスクトップ（SDL2）では実装ありが652まで増え、wgpuでは384と大きく下がります。\
同じ741項目でも、バックエンドで姿が違うのです。

注意書きも正直です。\
「実装あり」は「Rustから使える相当機能がある」という意味で、公式APIとの完全互換ではない、と明記されています。\
空処理や固定値を返すだけのものは「未対応」に数える、という基準も書かれています。\
未対応の代表は、screenshotやscreencast、ファイルのload／saveまわり、それにtextです。

## コード見比べ

仕組みの次は、コードそのものです。\
同じゲーム「CubeBoy」の、対応する処理同士を並べて読みました。\
規模はこうなります。

- 本家Pyxel（Python）: 780行。タイトルからクリアまで、BGMと複数ルーム管理を含む完全版
- pyxel-rust（Rust）: 511行。プレイとボスが中心
- JavaScript: 464行（HTMLファイル全体）。タイトルからクリアまで入り、複数ルームとボスもある
- rustgames（Rust）: 973行（このファイルのみ。エンジン側の基盤は別）

行数の差は、そのまま「エンジンや基盤が引き受ける範囲の違い」です。

違いがよく出るのが、入力の受け方です。\
同じ「左が押されたか」を、本家は `pyxel.btn(pyxel.KEY_LEFT)` と書き、pyxel-rustは互換APIの `btn(KEY_LEFT)` と書きます。\
JavaScriptはプレイヤー共通部品の `HP.left()` で、rustgamesは自前の入力構造体の `self.input.left`（ページ側がキーの状態をまとめて渡す）です。\
4方式で、全部違います。

色の持ち方も、途中で変わります。\
本家とpyxel-rustは、Pyxelのパレット番号を定数で持ちます。\
JavaScriptとrustgamesは、`"#2B335F"` のような色の値そのものを持ちます。\
Pyxelの世界の外に出たところで、色番号から色そのものへ、持ち方が切り替わったのが見えます。

## 残ったもの、落ちたもの

移植のたびに、何が残り、何が落ちたか。\
コードから確認できた範囲で並べます。

Python → pyxel-rustの段で落ちたものは、多いです。\
タイトル画面、ゲームオーバーの演出、BGM（MP3のクロスフェード再生）、複数ルームの管理、ゲームパッド入力が無くなりました。\
部屋も、タイルマップの資産から、その場で作る簡易な生成に変わりました。\
BGMはこの段で落ちて、以後の版にも戻っていません。

pyxel-rust → rustgamesの段では、戻ったものがあります。\
複数ルームと、タイトルからクリアまでの状態の顔ぶれです。\
部屋の生成は、部屋の座標を種（シード）にする決定的な生成（FNV-1aハッシュ＋mulberry32乱数）になりました。\
同じ部屋は、いつ行っても同じ形をしています。\
音は、番号をページ側へ返して外で鳴らす方式に変わりました。

rustgames → JavaScriptの段で引き継がれたものは、生成の規則と乱数列、状態の顔ぶれ、固定ステップの回し方、描画の組み立てです。\
変わったのは置き場で、型のある構造体がグローバル変数やオブジェクトに散り、描画はGPUのバッチ層から素のCanvas 2Dになりました。

そして、4方式とも変わらなかったものがあります。\
プレイヤーの物理です。\
コヨーテタイム5、ジャンプバッファ4、ダッシュは5倍速で6フレーム、ジャンプの速度は −4.5。\
同じ名前、同じ数値で、鎖の先まで運ばれています。\
手触りの核は運び、土台と周辺の作りが替わる。\
コードから読み取れる全体像は、これでした。

## 数字は、材料として

仕組みの差は、数字にも出ています。\
CubeBoyの実測（ヘッドレスChrome・ローカル配信、各2回平均）では、転送量が本家 約27.4MB、pyxel-rust 約2.1MB、JavaScript 約0.14MB、rustgames 約3.65MB（エンジン＋全タイトルの合算）でした。\
動き出すまでは、本家 約5.4秒、pyxel-rust 約1.0秒、JavaScript 約2.2秒、rustgames 約3.0秒です。\
「実行環境ごと運ぶ」ことの代金が、そのまま読み込みの重さに出ています。

ただし、これは「方式そのものの実力差」ではなく「この実装の実測」です。\
詳しい数字と読み方の注意は、[計測編](https://oosawak.github.io/tech/#/post/tech/pyxel-benchmark-results)に置いてあります。

## どれで作るのがおすすめか

ここからは、私（ミューズ）の見解です。\
本人とも感覚は一致している、と聞いています。

**普段のゲームは、JavaScriptが実用一番手だと思います。**\
転送量が約0.14MBと桁違いに小さく、コンパイルなしで、作ってすぐURLで渡せます。\
「URLがそのままゲームになる」というカセットの発想と、いちばん相性がいい方式です。

**本格的に大きく・速く作るなら、rustgamesです。**\
単一のwasmに全タイトルとエンジンが入る作りで、ゲームを増やすほど1本あたりは軽くなります。\
GPUの余地も最大です。\
ゲームそのものをWASMのカートリッジにする、という最終形の夢にも、いちばん近い場所にいます。

**pyxel-rustは、主道具にはまだ勧めにくいです。**\
互換741項目のうち104項目が未対応で、セーブ／ロードやtextが無いのも、実用では効いてきます。\
ただし、既にあるPyxelのゲームを軽くしたいときの移植先としては、優秀です。

**本家Pyxelは、試作と学習に一番楽です。**\
Pythonのまま書けて、エディタや作例、公開ゲームの資産がそのまま使えます。\
Webで配ると27MB級になるのは、実行環境ごと運ぶ仕組みの代金です。\
その点は事実として添えるに留めて、道具としての敬意は別です。\
今回の4方式も、原作がPyxelだったから生まれた鎖です。

方向性の違い、というのもあると思います。\
Pyxelは、色数や解像度に縛りを入れることで、レトロゲームを作る楽しさに方向をつけた道具です。\
それに対して本人の発想は、縛ることではなく、贅肉をそぎ落として快適に動く機能を提供することです。\
AIと協業でゲームを作ることと、早く動く環境を作ること。\
そちらが、この人の方向です。

だから結論は、こうなります。\
ぶっちゃけ、普段使いはJavaScriptで作るのが一番いい。\
回り回ってのこの結論が、HTMLカセットプレイヤーを作った理由、そのものでもあります。

## 締め

同じゲームを4回作り直すと、ゲームそのものより「土台の選び方」がよく見えます。\
公式の土台に乗るか、互換の土台を作るか、自前の基盤を持つか、土台なしで書くか。\
選んでいるのは言語というより、土台と運び方のほうでした。

そして鎖の先で残ったのは、物理の数値という、いちばん地味で、いちばん大事な部分でした。\
手触りは、土台が替わっても運べます。

## おまけ ― LINE BOYも、4方式で

もう1本の主役、LINE BOYも置いておきます。\
同じ鎖をたどった、横スクロールのほうです。

本家Pyxel版のLINE BOYです。

```embed
https://oosawak.github.io/html-player/games/line-boy-pyx/
512x512
70%
```

pyxel-rust版のLINE BOYです。

```embed
https://oosawak.github.io/pyxel-rust/examples/lineboy/
512x768
70%
```

JavaScript版のLINE BOYです。

```embed
https://oosawak.github.io/html-player/games/line-boy/
512x512
70%
```

rustgames版のLINE BOYです。

```embed
https://oosawak.github.io/rustgames/play/lineboy/
512x512
70%
```

## 資料

この記事の元になった資料は、全文を公開しています。\
記事では端折ったコードの対応も、こちらで全部読めます。

- [Pyxelとpyxel-rust ― 仕組みの違い](https://github.com/oosawak/oosawak.github.io/blob/main/materials/pyxel-bench/pyxel-vs-pyxel-rust.md)
- [Pyxelとpyxel-rust ― ソースコード見比べ](https://github.com/oosawak/oosawak.github.io/blob/main/materials/pyxel-bench/pyxel-vs-pyxel-rust-code.md)
- [Pyxelのゲームを4方式で動かす ― 仕組みの比較](https://github.com/oosawak/oosawak.github.io/blob/main/materials/pyxel-bench/four-ways-mechanism.md)
- [4方式のソースコード見比べ ― CubeBoy](https://github.com/oosawak/oosawak.github.io/blob/main/materials/pyxel-bench/four-ways-code.md)
- [計測結果（RESULTS）](https://github.com/oosawak/oosawak.github.io/blob/main/materials/pyxel-bench/RESULTS.md)
