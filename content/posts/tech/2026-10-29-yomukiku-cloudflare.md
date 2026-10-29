---
title: 小説サイト「よむきく」も、Cloudflareへ
subtitle: いまのGitHub Pages版と並べて公開する計画
date: '2026-10-29'
category: お知らせ
summary: 小説投稿サイト「よむきく」について、現在のGitHub Pages版に加えて、Cloudflare版を作って並べて公開する計画を紹介します。決まっていることと、これから決めることを分けて書きます。
cover: tech/yomukiku-cloudflare.webp
cover_alt: 同じ本棚が見える2つの扉のイラスト。片方は木の図書室、もう片方は雲の浮かぶ空
type: article
---

小説投稿サイト「よむきく」は、Markdownで書いた物語を公開するサイトです。\
作品のファイルを置くと、GitHub Actionsがデータを更新し、サイトに反映されます。\
現在は、GitHub Pagesから配信しています。

- [小説投稿サイト「よむきく」を見る](https://oosawak.github.io/MdYomuKiku/)

## もう一つの配信先、Cloudflare版を作ります

MarkdownCMSには、Cloudflareを使う商用版ができました。\
その仕組みを、今度は自分の小説サイトでも試してみたいと思っています。

「よむきく」のCloudflare版を作り、いまのGitHub Pages版と並べて公開する予定です。\
公開版と商用版の違いは、前の記事に書きました。

- [MarkdownCMSの公開版と商用版](https://oosawak.github.io/tech/#/post/tech/markdown-cms-editions)
- [OSS版サンプルサイトの案内記事](https://oosawak.github.io/markdown-cms-oss/#/post/sample/oss-and-cloudflare)

## 並べて公開する狙い

同じ物語が、GitHub PagesとCloudflareの両方で読めるようになります。\
配信のされ方や更新の仕方の違いを、サンプルではない実際のサイトで比べられるのが狙いです。

「よむきく」は小説のサイトなので、生成の仕組みはMarkdownCMSと少し違います。\
それでも、作品をMarkdownで持つという発想は同じです。\
その発想が、配信先を変えても使えるかを確かめます。

## まだ決めていないこと

Cloudflare版の構成は、これから決めます。\
GitHubで更新してCloudflare Pagesから配信する形か、R2で更新してWorkersから配信する形か、どちらにするかは未定です。\
公開の時期も、まだ決めていません。

この記事でお伝えするのは、「よむきくのCloudflare版を作る」という計画までです。\
詳細が決まったら、あらためてお知らせします。

## 公開したらお知らせします

Cloudflare版の「よむきく」が公開できたら、このブログでお知らせします。\
物語を読む場所が、もう一つ増える予定です。
