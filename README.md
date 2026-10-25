# oosawak.github.io — Lyre3 Games

Lyre3 Games のホームページ（GitHub Pages、main ルート配信）。

## 構成

- `index.html` — トップページ（単一ファイル）。左メニューから各ブログへリンク
- `ixa.html` / `webrtc.html` — 既存の独立ページ
- `tech/` — Tech Blog（生成物。手で編集しない）
- `game/` — Game Blog（生成物。手で編集しない）

## ブログの更新方法

Markdown CMS で生成しています。

- 記事: `content/posts/tech/*.md` / `content/posts/game/*.md`（frontmatter: title/date/category/summary/cover/cover_alt/type）
- サイト定義: `content/sites/tech.yml` / `content/sites/game.yml`
- push すると GitHub Actions（build-blogs.yml）がビルドし、`tech/` と `game/` の生成物だけを bot が commit します
- ローカルビルド: `SITE_ID=tech SITE_URL=https://oosawak.github.io/tech/ PORTAL_URL=https://oosawak.github.io/ python scripts/build.py`
