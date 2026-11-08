# PLaMo翻訳バッチの運用手順

ブログ記事の英文化を「PLaMo 3 Translate の下書き → Muse の校正 → 本人の承認 → 公開」で回すための手順書。2026-11-08、Techブログ記事 `cve-watch-daily` の全文試訳と校正で確立した方式。

## 全体の流れ

1. **下書き生成（Mac / Codex）** — `scripts/plamo_translate.py` を MacBook Pro（M1 Max）の mlx-lm 環境で実行する。PLaMo 3 Translate 8B（MLX-4bit）が段落単位で翻訳する。翻訳に Muse のトークンは使わない。1記事あたり生成は約1分。
2. **校正（Muse）** — 出力された試訳を通読し、下の校正チェックリストで直す。直すのは意味のずれと用語の統一、タイトル／サブタイトルの仕上げが中心。本文の骨格は下書きを活かす。
3. **登録と検証（Muse）** — 校正版を `content/i18n/en.json` の `posts["<site>:<slug>"]` へ登録し、ローカルビルドで生成 JSON の `i18n.en` に入ることを確認する。
4. **公開（本人の承認後）** — commit・push で GitHub Actions がビルドし、英語版 URL（`#/en/post/<site>/<slug>`）で公開側を確認する。下書き承認なしに公開しない。

## 下書き生成の実行方法（Mac側）

前提: `~/plamo-trial/` に venv（mlx-lm 0.32.2）とモデル `pfnet/plamo-3-translate` 8B MLX-4bit があること。31B は Mac に置かない（やるなら i9 側）。

```sh
cd <oosawak.github.io の clone>
~/plamo-trial/venv/bin/python scripts/plamo_translate.py \
  --post content/posts/tech/<日付>-<slug>.md \
  --site tech \
  --glossary content/i18n/glossary-tech.json \
  --context "技術ブログのコラム記事" \
  --model ~/plamo-trial/plamo-3-translate \
  --outdir ~/plamo-trial/out
```

`--context` は記事の種類に合わせて変える（例: 「技術ブログのコラム記事」「ゲーム開発の進捗記事」）。

出力は `--outdir` に4ファイル:

- `<slug>-en.md` — 試訳・未校正の全文（frontmatter 付き）
- `<slug>-en-entry.json` — en.json 登録用エントリ（source_hash 計算済み）
- `<slug>-results.json` — ブロックごとの原文・出力・計測値
- `<slug>-report.md` — 構造の機械照合（見出し数、コードブロック、画像URL、リンクURL集合、日本語残存行）と所要時間

Mac へは neta-cho 経由で指示書を渡し、成果物は neta-cho の `reports/` に戻す運用でもよい（2026-11-08 の初回はこの形）。

**部分戻し（パイプライン化、2026-11-08 本人提案で標準化）**: 件数が多いバッチ（目安10件以上）では、全件の完了を待たず、完了分を区切って先に `reports/` へ戻す（例: `<日付>-<対象>-partial-entries.json` / `-partial-en.md`、含めた slug を明記）。Muse は届いた分から校正を始め、生成と校正を並行させる。最終成果物（全件の統合と報告）は従来どおり別途戻し、部分戻しはそれを置き換えない。

## スクリプトの翻訳方式（検証済み）

- frontmatter の title / subtitle / summary / cover_alt は履歴なしで個別に翻訳。category は用語集 JSON の `category_map` で変換する。
- 本文は空行区切りブロック単位。見出しは記号を外して翻訳、コードブロックはモデルに送らずそのまま写す、画像は URL 据え置きで alt だけ翻訳する。
- 通常段落は行末バックスラッシュ（日本語版の改行マーカー）を外して行をつないでから送る。英語版にバックスラッシュは付けない。
- 履歴は直前の通常段落の原文・訳の1組だけ。
- 用語集（`content/i18n/glossary-<site>.json` の `terms`）は全ブロック共通で渡す。固有名詞の表記が揺れたら用語集へ足してから再実行する。

## 校正チェックリスト

初回の試訳で実際に起きたずれをもとにした確認項目。

- **タイトル／サブタイトル**: 決め台詞の切れが落ちていないか。原文にない言葉が足されていないか（例: 関係のない "ecosystem" の追加）。
- **数字と数量の意味**: 「4か所」が "four versions" のように、数える対象が化けていないか。件数・版数・日付は原文と突き合わせる。
- **工程の抜け**: 並列に挙げられた手順（ふるう、照合する等）が訳で落ちていないか。
- **用語の統一**: 同じ原語に複数の訳が混ざっていないか（例: 更新オーダーが update order / update request と揺れる、仲間が users / members と揺れる）。揺れたら用語集へ登録する。
- **「本人」の扱い**: 文脈なしで "the person" と訳されると英語記事として不自然。書き手（Muse）から見た関係が伝わる形にする。
- **慣用表現**: 「土俵にいない」を "not in the same league" のように別競技へ寄せすぎていないか。意味の中心を取る（例: not even in that arena）。
- **専門用語の定訳**: キャッシュ汚染は cache poisoning のように、分野の定訳がある語はそちらへ寄せる。
- **住所（グルメ系の「お店の情報」）**: ラベル（Location:）だけ英語にし、番地まで含む住所は日本語のまま残す（2026-11-08 本人決定）。ローマ字化すると地名の誤読が混ざり（例: 高擶北を Takatamaki と誤読）、現地で使えないため。市区町村・エリアのみで番地がない場合は、英語表記でよい（「詳しい住所は投稿に明記なし」の注記は英語で残す）。
- **固有名詞の表記統一**: 長音記号（ō 等）は付けない形に統一する。情報リストのラベル（Shop Name / Location / Business Hours / Specialties）と見出し（Shop Information）も全件で揃える。

## 登録の形式（en.json）

`content/i18n/en.json` の `posts` に、キー `<site>:<slug>` で次を持つ:

- `title` / `subtitle` / `category` / `summary` / `cover_alt` / `markdown`（本文全文）
- `source_hash` — 日本語原文（frontmatter＋markdown）を `scripts/build.py` の `source_hash` と同じ方法で計算した SHA-256

`build.py` はハッシュが原文と一致したときだけ、その訳を生成 JSON の `i18n.en` に入れる。**日本語原文を直したら source_hash の再計算と、訳の追随が必須**（ハッシュがずれると英語版は黙って消える）。

`<slug>-en-entry.json` はこの形で出力されるので、校正後にその内容を en.json へマージすればよい。校正で markdown を直した場合は、エントリ側の markdown を校正版へ差し替える（source_hash は原文側のハッシュなので変わらない）。

## ローカル検証

```sh
SITE_ID=tech python3 scripts/build.py
python3 -c "import json; d=json.load(open('dist/data/posts/tech/<slug>.json')); print(d['i18n']['en']['title'])"
```

生成 JSON の `i18n.en` に校正版タイトルが出れば登録成功。あわせて見出し数、リンク URL、画像、日本語残存ゼロを目視で確認する。

## 対象範囲と注意

- 対象は Markdown CMS の各サイト（tech / game など）。サイトが増えたら `glossary-<site>.json` を用意する。
- PLaMo のライセンスは PLaMo Community License。商用利用は PFN の商用利用登録（売上10億円以下は登録で無償）が必要になる場面があるため、個人の試用と商用利用は分けて扱い、商用前に登録する。
- 試訳は未校正・未公開が既定。公開は校正と本人の承認を経てから。
