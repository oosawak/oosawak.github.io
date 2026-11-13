---
title: '処理はどこで動くか'
subtitle: 'Markdown CMSの構造 — データベースも実行サーバーもなし'
author: ミューズさん
date: '2026-11-01'
category: お知らせ
summary: 'Webサイトの処理は、どこで動いているのでしょうか。従来型のCMSは、データベースとアプリケーションサーバーをリクエストのたびに動かし続けます。Markdown CMSは、その両方を取り除きました。この記事では英語版スライドに沿って、設計の3つの柱、共通の芯であるサイトフォルダ、記事の5段階のライフサイクル、GitHubで動くOSS版とCloudflareで動く商用版、そして計算の足跡がほぼゼロになる理由を説明します。'
cover: tech/processing-lives.webp
cover_alt: 文書の束をカードに打ち抜いてブラウザの窓へ飛ばすプレス機と、本棚のそばで眠るサーバータワーのイラスト
type: article
---
Webサイトの中で、処理はどこで動いているのでしょうか。\
従来型のCMSでは、答えは「サーバーで、ずっと」です。\
データベースが中身を抱え、アプリケーションサーバーがリクエストのたびにページを組み立て、読む人がいなくても両方が動き続けます。\
週に数回しか変わらないホームページにとって、それは待機しているだけの仕組みが多すぎます。\
Markdown CMSは逆のやり方を取ります。\
データベースと実行サーバーを丸ごと取り除き、処理が動くのは公開の瞬間だけにします。\
この記事では、英語版スライドに沿って、その構造を説明します。\
なお、図は英語版スライドのものをそのまま使っています。

## データベースと実行サーバーを取り除きました

比較は単純です。\
従来の構成（身近な例はWordPressです）はデータベースを抱え、アクセスのたびにサーバー側で描画します。\
Markdown CMSは、正本をプレーンなMarkdownファイルとして持ち、公開のときにJSONを生成し、ページの組み立てはブラウザに任せます。\
結果として、データベースの保守はゼロ、待機中の計算はゼロ、サーバー側の描画はゼロです。

![スライド「We removed the database and the runtime server」：データベースとサーバー側描画を持つ従来構成と、Markdownファイル・公開時のJSON生成・ブラウザでの組み立てを持つMarkdown CMSの比較](tech/processing-lives-removed.webp)

## 運用の重さを消す3つの柱

この構造は、3つの決定で成り立っています。

1. **ファイルが正本（Files = Truth）**：正本を抱えるデータベースはありません。正しい中身は、Markdownと素材のファイルとして、ローカルのファイルシステムに直接置かれます。記事はファイルとして、どこへでも持ち運べます
2. **事前生成（Pre-Generation）**：計算はすべて、読者が来る前に終わらせます。ビルドは静的なJSONを生み、配信は生成済みの成果物を渡すだけです
3. **ブラウザでの組み立て（Browser Assembly）**：クライアントは軽いJSONを受け取り、DOMを手元で組み立てます。リクエストのたびにサーバーがHTMLを描画することはありません

![スライド「The three structural pillars」：Files = Truth、Pre-Generation、Browser Assemblyの3本柱](tech/processing-lives-pillars.webp)

## 共通の芯：サイトフォルダ

どちらの版を選んでも、芯は同じです。\
フォルダ1つです。

- `posts/*.md` — frontmatterにメタデータを持たせた、Markdownの記事
- `assets/` — 画像とファイル。ファイルのまま置きます
- `scripts/build.py` — フォルダを読み、共通のJSON形式である `data.json` を出す変換器
- `index.html` + `app.js` — そのJSONを表示する、読み取り側

![スライド「The universal core」：posts、assets、build.py、読み取り側のアプリからなるサイトフォルダ](tech/processing-lives-core.webp)

記事が同じフォルダ形式にそろっているので、既存のサイトも取り込めます。\
変換器がWordPressのサイトや手書きのHTMLサイトをサイトフォルダへ変え、その後はここで生まれたサイトとまったく同じに保守できます。

## Markdown記事のライフサイクル

どの記事も、同じ5つの段階をたどります：編集、保存、生成、配信、表示。\
共通の芯は変わりません。\
版によって変わるのは、各段階が動く物理的な場所だけです。

![スライド「The lifecycle of a Markdown article」：編集から表示までの5段階と、変更時に走る生成](tech/processing-lives-lifecycle.webp)

## OSS版：すべてGitHubの上で

無料版は、GitHubの既存の仕組みの上で動きます。\
編集は手元のターミナルやVS Code、任意のエディターで。\
`git push` が、記事をGitHubリポジトリへ保存します。\
そのpushがGitHub Actionsを起動し、ビルドが走ってJSONを生成します。\
GitHub Pagesが静的ファイルを配信し、読者のブラウザがJSONを受け取って、app.jsで手元に描画します。

![スライド「OSS Edition: entirely on GitHub」：ユーザーのターミナル、GitHubリポジトリ、GitHub Actions、GitHub Pages、ユーザーのブラウザ](tech/processing-lives-oss.webp)

OSS版はMITライセンスで公開されており、[リポジトリ](https://github.com/oosawak/markdown-cms-oss) と [サンプルサイト](https://oosawak.github.io/markdown-cms-oss/) があります。

## 商用版：Cloudflareのエッジで

商用版は、読み手側の流れからGitHubを外します。\
GitHubを使わない人でもサイトを運用できるようにするためです。\
認証済みの管理画面で記事を編集します。\
保存すると、Markdownと画像がCloudflare R2へ入り、Queuesを通してイベントが発火します。\
Workerが生成を走らせ、MarkdownをJSONへ変換します。\
配信もWorkerが担い、最後に成功した生成をR2からエッジで直接返して、URLごとに動的なheadとOGPタグを差し込みます。このSEOの仕組みは、いま実装中です。\
生成に失敗した場合は、前の版がそのまま公開され続けます。

![スライド「Commercial Edition: on the Cloudflare Edge」：管理画面、Cloudflare R2、Cloudflare Workers、Cloudflareエッジ、ユーザーのブラウザ](tech/processing-lives-commercial.webp)

商用版には、GitHubを使う変種も残してあります。\
非公開リポジトリの記事を、Cloudflare Pagesがビルドして公開する形です。\
R2の形とは別の公開先で、2つは分けて管理します。

## 構造の変数を切り分ける

並べて置くと、2つの版が違うのは、この表の場所だけです。

| 変数 | OSS版 | 商用版 |
|---|---|---|
| 保存先 | GitHubリポジトリ（Git） | Cloudflare R2（オブジェクトストレージ） |
| 生成の芯 | GitHub Actions（build.py） | Cloudflare Workers |
| 実行トリガー | git push | 管理API経由の PUT /save |
| エッジ配信 | GitHub Pages | R2から返すWorkers |
| 失敗時の状態 | 最後に成功したコミットが公開され続ける | 最後に成功した生成が公開され続ける |

![スライド「Isolating the architectural variables」：2つの版の比較表](tech/processing-lives-compare.webp)

その下にある普遍の真理は動きません：1ファイルが1記事、データベースなし、実行サーバーなし、表示はいつも data.json を読む app.js です。

## 計算の足跡はほぼゼロへ

この構造では、サーバーレス関数やビルドは、pushや公開の瞬間にだけ動きます。\
それ以外の時間は本当にゼロで待機し、ページの閲覧では計算は一切起きません。\
計算が起きるのは、中身そのものが変わるときだけです。

![スライド「The compute footprint approaches absolute zero」：公開時にだけ跳ねてゼロへ戻る計算と、閲覧時はゼロのままの線](tech/processing-lives-footprint.webp)

## 公開パイプラインの選び方

では、どちらの版が合うのでしょうか。\
Gitでの作業が苦でなく、すべてを1つのリポジトリで見渡したいなら、GitHubのOSS版で十分です。\
GitHubなしに管理画面から編集できる形がよければ、Cloudflareの商用版です。\
どちらを選んでも、正本は持ち運べるMarkdownファイルとしての、あなた自身の中身のままです。\
基盤は変えられます。\
記事は、変えなくて済みます。

この記事には英語版もあります。上の「English」ボタンで切り替えられます（直接のURLは [Where the Processing Lives](https://oosawak.github.io/tech/#/en/post/tech/where-the-processing-lives) です）。
