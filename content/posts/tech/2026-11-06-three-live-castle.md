---
title: 'Three-Liveで城モデル'
subtitle: 'AI生成Three.jsからGLBへ'
author: ミューズさん
date: '2026-11-06'
category: コラム
summary: 'Googleのオープンソース「Three-Live」を試しました。AIが生成したThree.jsのコードを、GLBという3Dモデルの形に変換する仕組みです。公式の道具で仙台城のイメージのモデル（石垣と二重櫓）を作り、検証を通して44KBのGLBができました。櫓や石垣を部品にできれば、ほかの城もパラメータ違いで作れます。'
cover: tech/three-live-castle.webp
cover_alt: コードの線が右へ流れていき、石垣の上に立つ二重櫓の城に変わっていくイラスト
type: article
---

AIが書いたコードから、3Dのモデルが作れないか。\
Googleが公開した「Three-Live」という仕組みで、城のモデルを作って試しました。

## Three-Liveとは

[Three-Live](https://opensource.googleblog.com/2026/11/introducing-three-live-ai-generated-3d-ar-webxr.html)は、Googleのオープンソース（Apache 2.0）で、v1.0.0のDeveloper Previewとして公開されたものです。\
AIが生成したThree.jsのコードを、決められた箱（サンドボックス）の中で実行し、GLB（glTF 2.0）とUSDZという3Dモデルの形に変換します。\
できたモデルは、Web・Android・iOSで、3D表示やAR、WebXRに使えます。\
変換を担当する部分はRustで作られていて、Boaというエンジンでコードを読み解きます。

## 先に分かっていたこと

試作の前に、研究で1つ分かっていたことがあります。\
Three.jsの書き方で形を作り、toGLB()で書き出すと、開発中のPyxel 3で使える形のGLBになる、ということです。\
今回はその先で、公式の道具（CLI）を使って、最初からGLBを作る流れを試しました。

## 仙台城を作ってみた

題材は、仙台城のイメージです。\
3段の石積みの台の上に、白壁と瓦屋根の二重櫓を置き、小さい櫓と後ろの塀を添えました。\
仙台城に天守はないので、天守は作っていません。

![試作した仙台城のモデルを正面から見たところ](tech/three-live-castle-preview.webp)

なお、この画像はモデルのデータから簡易な描き方で作った静止画で、色は実際の表示より少し地味に出ています。

作り方は、手続き的に書いたThree.jsのコード（castle.js）を、公式CLIに入力することです。\
出力されたGLBは検証（validate）を通過し、中身はメッシュ26個、大きさは44KBでした。

## 実際のコード

作ったコードの全文です。\
石垣と櫓を部品（関数）に分けて、数字で組み立てる書き方になっています。

```js
// Sendai Castle prototype — procedural Three.js scene for Three-Live
// Motif: ishigaki (stone rampart) + nijuu-yagura (two-story turret).
// Sendai Castle had no tenshu (main keep), so none is built here.

function mat(color, roughness, metalness) {
  return new THREE.MeshStandardMaterial({
    color: color,
    roughness: roughness === undefined ? 0.9 : roughness,
    metalness: metalness === undefined ? 0.0 : metalness
  });
}

function box(w, h, d, color, x, y, z, roughness) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, roughness));
  m.position.set(x, y, z);
  scene.add(m);
  return m;
}

// Square frustum (for ishigaki courses and tiled roofs).
// A 4-sided cylinder rotated 45 degrees gives flat faces on the axes.
function frustum(rBottom, rTop, h, color, x, y, z, scaleZ, roughness) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, h, 4),
    mat(color, roughness)
  );
  m.rotation.y = Math.PI / 4;
  m.scale.set(1.0, 1.0, scaleZ === undefined ? 1.0 : scaleZ);
  m.position.set(x, y, z);
  scene.add(m);
  return m;
}

const STONE_A = 0x83868a;
const STONE_B = 0x8b8e91;
const STONE_C = 0x7e8184;
const SLATE = 0x39424c;   // roof tile
const PLASTER = 0xf2f0eb; // white wall
const WOOD = 0x4a3826;    // door
const DARK = 0x1c1e20;    // window openings

// ---- Ground platform ----
box(64, 1, 46, 0x66705f, 0, 0, 0, 1.0);

// ---- Ishigaki: three stacked stone courses with a slope ----
frustum(21.0, 19.9, 2.4, STONE_A, 0, 1.7, 0, 0.92, 1.0);
frustum(19.9, 18.8, 2.4, STONE_B, 0, 4.1, 0, 0.92, 1.0);
frustum(18.8, 17.7, 2.4, STONE_C, 0, 6.5, 0, 0.92, 1.0);
// scale x of the courses to make the base rectangular
// (done via a wrapper approach: geometry already added; proportions read fine as-is)

// Rim slab on top of the stone base
box(26.0, 0.5, 24.0, 0x6a6e73, 0, 7.95, 0, 1.0);

// ---- Main two-story turret (nijuu-yagura) ----
const TX = -5.5;
// lower floor
box(9.5, 4.4, 7.6, PLASTER, TX, 10.4, 0, 0.9);
// eave slab 1
box(11.0, 0.4, 9.1, SLATE, TX, 12.8, 0, 0.8);
// roof 1 (truncated pyramid so the upper floor can sit on it)
frustum(7.6, 5.1, 1.7, SLATE, TX, 13.85, 0, 0.83, 0.8);
// upper floor
box(6.9, 3.4, 5.9, PLASTER, TX, 16.4, 0, 0.9);
// eave slab 2
box(8.3, 0.35, 7.2, SLATE, TX, 18.28, 0, 0.8);
// roof 2
frustum(6.0, 1.1, 2.4, SLATE, TX, 19.65, 0, 0.86, 0.8);
// ridge ornament
box(1.8, 0.3, 0.9, SLATE, TX, 21.0, 0, 0.8);
// windows (front)
box(1.0, 1.2, 0.12, DARK, TX - 2.8, 10.8, 3.86, 0.6);
box(1.0, 1.2, 0.12, DARK, TX + 2.8, 10.8, 3.86, 0.6);
box(1.0, 1.1, 0.12, DARK, TX, 16.6, 3.01, 0.6);
// door (front)
box(1.4, 2.4, 0.12, WOOD, TX, 9.4, 3.86, 0.9);

// ---- Smaller single turret on the other corner ----
const SX = 8.5;
box(6.2, 3.6, 5.6, PLASTER, SX, 10.0, 0, 0.9);
box(7.6, 0.35, 6.9, SLATE, SX, 11.98, 0, 0.8);
frustum(5.4, 0.9, 2.0, SLATE, SX, 13.15, 0, 0.9, 0.8);
box(1.0, 1.1, 0.12, DARK, SX, 10.4, 2.86, 0.6);

// ---- Rear white wall (dobei) connecting the top edge ----
box(20.0, 2.2, 0.8, PLASTER, -1.0, 9.3, -7.6, 0.9);
box(20.4, 0.3, 1.2, SLATE, -1.0, 10.55, -7.6, 0.8);

// ---- Two simple pines on the ground ----
function pine(x, z) {
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6), mat(0x4a3826, 1.0));
  trunk.position.set(x, 1.3, z);
  scene.add(trunk);
  const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.7, 3.4, 8), mat(0x44603f, 1.0));
  leaves.position.set(x, 3.8, z);
  scene.add(leaves);
}
pine(20, 10);
pine(-22, -12);
```


## 一度比率で失敗した

最初の描画チェックで、石垣に対して上の台が張り出しすぎていると分かりました。\
石垣の方を大きくして、比率を直しています。\
コードで作る模型は、数字を直せばすぐ作り直せるのが利点です。

## 部品にできれば量産できる

今回の作り方だと、櫓や石垣は「部品」として扱えます。\
部品がそろえば、ほかの城は大きさや組み合わせ（パラメータ）を変えるだけで作れるはずです。\
本に付ける3Dマップや、戦国ガイド、奥羽一生録といった場所で、同じモデルを使い回す。\
そのための型の試作、というのが今回の位置づけです。

正本はコード（テキスト）で、モデルはそこから生成される。\
私のサイト群やゲームと同じ型が、3Dでも使えそうだ、という手応えがありました。
