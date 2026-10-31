---
title: '図で見る、Markdown CMS'
subtitle: '共通の芯と、公開版・商用版の流れ'
author: ミューズさん
date: '2026-10-31'
category: お知らせ
summary: Markdown CMSの裏側の組み立てを、構成図で説明します。共通の芯は「サイトフォルダを正本にして、buildが記事JSON（共通仕様のdata.json）を生成し、表示側はそれを読むだけ」という形です。公開版（GitHub版）はActionsで生成してPagesで配信し、商用版（Cloudflare版・R2更新型）は管理画面からR2へ保存し、Queuesの通知でWorkerが生成と配信を行います。どちらの版でも、表示する側ではプログラムは動きません。
cover: tech/architecture.webp
cover_alt: フォルダに入った文書が小さな変換ボックスを通って整ったカードの束になり、配信タワーと雲へ分かれていくイラスト
type: article
---
Markdown CMSが、裏側でどう組み立てられているかを図にしました。\
この記事では、その構成図を主役にして、仕組みを順番に説明します。\
版は2つありますが、芯になる考え方は共通です。

## 設計原則は、3つ

出発点にある問いは、「閲覧のたびにプログラムを動かす必要はあるか？」です。\
ホームページ程度の更新頻度では、アクセスが来るたびにデータベースへ問い合わせてページを組み立てる処理は、過剰だと考えています。\
そこで、設計原則を3つに絞りました。

1. **正本はファイル**：データベースに記事を入れません。記事はMarkdown、画像はファイルのまま置き、そのまま人が読めて、移せて、バックアップできます
2. **事前生成**：公開前に生成を済ませておきます。配るのは、生成結果のJSONやHTMLだけです
3. **ブラウザでの表示**：サーバーは配るだけにして、一覧や記事の組み立ては、閲覧者のブラウザ側が担います

![スライド「運用の重力をゼロにする3つの設計原則」：正本はファイル、事前生成、ブラウザでの表示という3本柱の図](tech/architecture-principles.webp)

## 共通の芯は、「サイトフォルダ」

正本は、Markdownファイルの集まりです。\
記事は、タイトルや日付などの情報（frontmatter）付きのMarkdownで書き、画像とサイト設定と一緒に「サイトフォルダ」へ置きます。\
build（生成）がそのフォルダを読んで、記事JSONを組み立てます。\
表示側は、そのJSONを読むだけです。\
記事JSONは共通仕様の data.json なので、複数のサイトの記事を1つのポータルに集めることもできます。\
このブログを含む私のサイト群も、この形で回っています。

## 公開版（GitHub版）の流れ

公開版は、GitHubの仕組みの上で動きます。\
手元で、VS Codeなどのエディタで記事を書き、GitHubリポへpushします。\
するとGitHub Actionsが build.py を走らせて、生成とテストを行い、生成物をcommitします。\
配信はGitHub Pagesが担い、ブラウザはJSONを読んで表示します。

![OSS版 Markdown CMS 処理構造の図：編集（User Terminal）、保管（GitHub Repo）、生成（GitHub Actions）、配信（GitHub Pages）、表示（User Browser）の5段階](tech/architecture-oss-gemini.webp)

生成が走るのは、pushしたときだけです。\
配信側で、プログラムが動き続けることはありません。\
公開版はMITライセンスで、[リポジトリ](https://github.com/oosawak/markdown-cms-oss)と[サンプルサイト](https://oosawak.github.io/markdown-cms-oss/)を公開しています。

## 商用版（Cloudflare版）の流れ

商用版は、Cloudflareの上で動きます。\
中心になるのは、「R2更新型」と呼んでいる形です。\
認証付きの管理画面で記事を編集すると、記事と画像はR2に保存されます。\
更新はQueuesで通知され、WorkerがMarkdownをJSONへ変換します。\
生成に失敗したときは、直前の成功版がそのまま配信され続けます。\
配信もWorkerが担い、生成済みの版をR2から届けます。

![Cloudflare版 Markdown CMS 処理構造の図：編集（Admin UI）、保管（Cloudflare R2）、生成（Cloudflare Workers）、配信（Cloudflare Edge）、表示（User Browser）の5段階](tech/architecture-cloudflare-gemini.webp)

なお、図の「配信」の箱にある Dynamic Head/OGP Injection（ページごとにheadやOGPを差し込む仕組み）は、SEO対策として実装中です。

記事の更新に、GitHubは使いません。\
ただし、商用版にはGitHub更新の仕組みも残してあります。\
記事と画像をprivateリポに置いてpushすると、Cloudflare Pagesがビルドして公開する形です。\
R2更新型とは別の公開先で、2つの型の記事は別々に管理します。

## 並べてみると

| 処理 | 公開版（GitHub版） | 商用版（Cloudflare版・R2更新型） |
|---|---|---|
| 保存先 | GitHubリポ | R2 |
| 生成する場所 | GitHub Actions（build.py） | Worker |
| 配信 | GitHub Pages | Worker |
| 更新方法 | エディタで書いてpush | 管理画面で編集 |

違うのは、部品の置き場所です。\
「サイトフォルダを正本にして、生成したJSONを表示側が読む」という芯は、どちらも同じです。\
配信元が変わっても、表示側の作りは両版で同じなので、読む側の体験は変わりません。

![スライド「インフラが変わっても、閲覧体験は変わらない」：data.jsonをブラウザ側のapp.jsが読み、一覧や記事を組み立てる図](tech/architecture-display.webp)

どちらを選ぶかの目安を図にすると、こうなります。

![スライド「どちらを選ぶべきか？ ― 読み替えガイド」：GitHubを使うことに抵抗があるか、全部を自分で把握したいか、運用支援が要るかで版を選ぶ流れ図](tech/architecture-guide.webp)

## 配信側では、プログラムは動かない

この構成で一番大事なのは、最後のところです。\
どちらの版でも、ページを表示する側ではプログラムが動きません。\
プログラムが動くのは、記事を更新して生成するときだけです。\
だから、表示の速さも、守る対象の小ささも、保ちやすくなります。\
[『守る対象を小さくする、MarkdownCMSの安全性への考え方』](https://oosawak.github.io/tech/#/post/tech/static-cms-security)で書いた考え方は、この構成から来ています。

版の違いと売り方については、[『MarkdownCMSの公開版と商用版』](https://oosawak.github.io/tech/#/post/tech/markdown-cms-editions)にまとめています。
