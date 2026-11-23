---
title: 'どこでもソース管理'
subtitle: 'BOOTHでお試し販売を始めました'
author: 'ミューズさん'
date: '2026-11-23'
category: 'コラム'
summary: '「どこでもソース管理」のMac版を、BOOTHでお試し販売として売り始めました。Android版とWindows版も、自分の機械で使う分には動いていて、最終確認が済み次第、同じ商品に追加します。'
cover: 'tech/source-control-anywhere-release-cover-v1.webp'
cover_alt: '夜空に浮かぶ本棚の家と、USBメモリを持つ人のイラスト。Lyre3 Gamesのショップカバー'
type: 'article'
---

今日、BOOTHでお試し販売を始めました。\
売り始めたのは、Mac版（Apple Silicon用）です。\
価格はお試し価格で1,000円にしました。\
商品ページは[こちら](https://lyre3-games.booth.pm/items/9205179)です。\
紹介のページは[こちら](https://oosawak.github.io/materials/source-control-anywhere/)にあります。\
仕組みや実測の話は、[前回の記事](https://oosawak.github.io/tech/#/post/tech/source-control-anywhere)に書きました。

## 今回出すのはMac版です

中身は、起動すると、ソースの置き場（Forgejo）と、編集画面（VS Code）と、確認ページがそろうアプリです。\
ネットがなくても、アカウントを作らなくても使えます。\
データはアプリと分かれているので、アプリを入れ替えてもデータは残ります。\
バックアップと復元も入っています。\
新しい版が出た時は、購入履歴から再ダウンロードできます。\
お試し販売の間、更新は無料で付いてきます。

![起動のランチャー。データの場所と、Forgejoのアカウント情報が出ている](tech/source-control-anywhere-release-launcher-v1.png)

![ランチャーとVS Codeと確認ページが並んだ画面。編集して、保存して、確認ページに出るまで](tech/source-control-anywhere-release-screen-v1.png)

## 入っているソフト

箱の中の主なソフトです。\
土台はUbuntu 26.04.1 LTSです。\
置き場はForgejo 15.0.11、編集画面はcode-server 4.146.0、確認ページはCaddyです。\
動かす役はQEMU 11.1.3で、殻はTauriです。\
言語は、Node.js 24.22.3、Python 3.14.4、Rust 1.96.1が入っています。\
Git 2.53.0とVim 9.1も入っています。\
中の合図の受け渡しには、Mosquitto（MQTT）も入っています。\
部品のライセンスは、アプリの中に全部同梱してあります。

## Android版とWindows版も、もうすぐです

Android版とWindows版も、私が自分の機械で使う分には、もう動いています。\
Android版は、電話の中で同じ置き場が動く形です。\
Windows版は、Mac版と同じ箱の形です。\
どちらも最終確認が済み次第、同じ商品に追加します。\
購入した方は、再ダウンロードで入手できます。

![Pixel 7aで動くAndroid版の画面。部品の状態と接続先が出ている](tech/source-control-anywhere-release-pocketgit-v1.png)

## 正直な所も書いておきます

お試し版です。\
Mac版のNodeの機能は実験中です。\
期待しないでください。\
説明書は同梱してあります。\
困った所があれば、直した版を再ダウンロードできる形で出します。

## アイデアをお寄せください

この仕組みは、Ubuntuで動くサービスを、そのままアプリの形にできます。\
こんな道具が欲しい、というアイデアがあれば、お知らせください。\
例えば「簡易ゲームサーバーを作りたい」みたいな相談でも構いません。\
作れるものは、作ってみます。

## 学校の先生へ

いつもお世話になっている学校の先生には、ギフトを発行します。\
ご連絡ください。
