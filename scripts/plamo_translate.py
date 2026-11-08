#!/usr/bin/env python3
"""PLaMo 3 Translate (Mac / mlx-lm) でブログ記事を段落単位に英訳し、
Markdown CMS の英語版登録用エントリ（en.json 形式）を生成するバッチ。

設計（2026-11-08 の実記事試訳で検証済みの方式）:
- frontmatter の title / subtitle / summary / cover_alt を個別に翻訳する。
- 本文は空行区切りブロック単位で翻訳する。見出しは記号を外して訳し、
  コードブロックはモデルに送らずそのまま写す。画像は URL 据え置きで
  alt テキストだけを訳す。箇条書きブロックは行ごとに訳してマーカーを
  保つ（お店の情報リストなどが段落に潰れないように）。
- 通常段落は行末バックスラッシュ（日本語版の改行マーカー）を外し、
  行を空白でつないでから送る。英語版にバックスラッシュは付けない。
- 履歴は「直前の通常段落の原文と訳」の1組だけを渡す。
- 用語集は glossary JSON（{"terms": [{"source":..,"target":..}, ...],
  "category_map": {"コラム": "Column", ...}}) を全ブロック共通で渡す。
- 出力の手直しはしない。構造の機械照合（見出し数、段数、コードブロック、
  画像URL、リンクURL集合、日本語残存行）を検証レポートに残す。

出力（--outdir 配下）:
- <slug>-en.md        試訳・未校正の英語版全文（frontmatter 付き）
- <slug>-en-entry.json  en.json の posts["<site>:<slug>"] へそのまま入る形
                        （source_hash は scripts/build.py と同じ計算）
- <slug>-results.json  ブロックごとの原文・モデル出力・計測値
- <slug>-report.md     検証結果と所要時間の報告

使い方（Mac、mlx-lm 入りの venv で）:
  python3 scripts/plamo_translate.py \
    --post content/posts/tech/2026-11-07-cve-watch-daily.md \
    --site tech \
    --glossary content/i18n/glossary-tech.json \
    --context "技術ブログのコラム記事" \
    --outdir ~/plamo-trial/out

--dry-run を付けるとモデルを読み込まず、分割と検証計画だけを出す
（mlx の無い環境でもセグメント分割の確認ができる）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------- util

def parse_md(path: Path):
    raw = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", raw, re.S)
    if not m:
        raise ValueError(f"Missing YAML frontmatter: {path}")
    import yaml  # build.py と同じ解釈にするため PyYAML を使う
    fm = yaml.safe_load(m.group(1))
    if not isinstance(fm, dict):
        raise ValueError(f"Bad YAML frontmatter: {path}")
    return fm, m.group(2)


def source_hash(obj) -> str:
    """scripts/build.py の source_hash と同一の計算。"""
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def split_blocks(body: str):
    """空行区切りでブロック化する。コードフェンスは途中で割らない。"""
    blocks, cur, in_fence = [], [], False
    for line in body.split("\n"):
        if line.strip().startswith("```"):
            in_fence = not in_fence
            cur.append(line)
            continue
        if line.strip() == "" and not in_fence:
            if cur:
                blocks.append("\n".join(cur))
                cur = []
            continue
        cur.append(line)
    if cur:
        blocks.append("\n".join(cur))
    return [b for b in blocks if b.strip()]


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.S)
IMAGE_RE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)$")
LINK_RE = re.compile(r"\[[^\]]*\]\((https?://[^)]+)\)")
LIST_ITEM_RE = re.compile(r"^(\s*(?:[-*]|\d+\.)\s+)(.*)$")


def classify(block: str) -> str:
    s = block.strip()
    if s.startswith("```"):
        return "code"
    if HEADING_RE.match(s):
        return "heading"
    if IMAGE_RE.match(s):
        return "image"
    lines = [ln for ln in s.split("\n") if ln.strip()]
    if lines and all(LIST_ITEM_RE.match(ln) for ln in lines):
        return "list"
    return "paragraph"


def paragraph_input(block: str) -> str:
    """行末バックスラッシュを外し、行を空白でつなぐ。"""
    lines = []
    for line in block.split("\n"):
        lines.append(line.rstrip())
    joined = " ".join(l[:-1] if l.endswith("\\") else l for l in lines)
    return re.sub(r"\s+", " ", joined).strip()


# ---------------------------------------------------------------- model

class PlamoTranslator:
    def __init__(self, model_path: str, source_lang="ja", target_lang="en",
                 context="", glossary=None):
        from mlx_lm import load  # Mac 専用。dry-run 時は呼ばれない
        self.model, self.tokenizer = load(
            model_path, trust_remote_code=True,
            tokenizer_config={"trust_remote_code": True},
        )
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.context = context
        self.glossary = glossary or []
        self.calls = []

    def translate(self, text: str, label: str, history=None) -> str:
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler

        messages = []
        if history:
            messages.append({"role": "user", "content": history[0]})
            messages.append({"role": "assistant", "content": history[1]})
        messages.append({"role": "user", "content": text})
        kwargs = {
            "source_lang": self.source_lang,
            "target_lang": self.target_lang,
        }
        if self.context:
            kwargs["context"] = self.context
        if self.glossary:
            kwargs["glossary"] = self.glossary
        prompt = self.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False,
            chat_template_kwargs=kwargs,
        )
        n_in = len(self.tokenizer.encode(prompt))
        est = len(self.tokenizer.encode(text))
        max_tokens = max(512, min(4096, est * 4 + 256))
        t0 = time.time()
        out = []
        n_out = 0
        for resp in stream_generate(
            self.model, self.tokenizer, prompt,
            max_tokens=max_tokens, sampler=make_sampler(temp=0),
        ):
            out.append(resp.text)
            n_out = resp.generation_tokens
        elapsed = time.time() - t0
        self.calls.append({
            "label": label, "seconds": round(elapsed, 3),
            "input_tokens": n_in, "output_tokens": n_out,
            "max_tokens": max_tokens,
        })
        return "".join(out).strip()


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--post", required=True, help="原文記事 .md のパス")
    ap.add_argument("--site", required=True, help="サイトID（tech など）")
    ap.add_argument("--glossary", help="用語集 JSON のパス")
    ap.add_argument("--context", default="", help="モデルへ渡す context 文字列")
    ap.add_argument("--outdir", required=True, help="出力先フォルダ")
    ap.add_argument("--model", default="~/plamo-trial/plamo-3-translate",
                    help="PLaMo 3 Translate 8B MLX-4bit のパス（Mac上）")
    ap.add_argument("--dry-run", action="store_true",
                    help="モデルを読み込まず分割結果だけ出す")
    args = ap.parse_args()

    post = Path(args.post).expanduser()
    outdir = Path(args.outdir).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)
    slug = post.stem[11:]  # YYYY-MM-DD- を外す（build.py と同じ規則）

    glossary_terms, category_map = [], {}
    if args.glossary:
        g = json.loads(Path(args.glossary).read_text(encoding="utf-8"))
        glossary_terms = g.get("terms", [])
        category_map = g.get("category_map", {})

    fm, body = parse_md(post)
    blocks = split_blocks(body)
    kinds = [classify(b) for b in blocks]

    print(f"slug={slug} blocks={len(blocks)} kinds={kinds}")
    if args.dry_run:
        for i, (k, b) in enumerate(zip(kinds, blocks)):
            head = b.replace("\n", " ")[:60]
            print(f"[{i}] {k}: {head}")
        print("dry-run: モデルは読み込んでいません")
        return 0

    tr = PlamoTranslator(str(Path(args.model).expanduser()),
                         context=args.context, glossary=glossary_terms)

    results = []

    def do(text, label, history=None):
        out = tr.translate(text, label, history=history)
        results.append({"label": label, "source": text, "output": out})
        return out

    # frontmatter（履歴なしで独立に訳す）
    en_fm = {}
    for key in ("title", "subtitle", "summary", "cover_alt"):
        if fm.get(key):
            en_fm[key] = do(str(fm[key]), f"frontmatter:{key}")
    if fm.get("category") in category_map:
        en_fm["category"] = category_map[fm["category"]]
    elif fm.get("category"):
        en_fm["category"] = do(str(fm["category"]), "frontmatter:category")

    # 本文
    en_blocks = []
    history = None  # 直前の通常段落の (原文, 訳)
    for i, (kind, block) in enumerate(zip(kinds, blocks)):
        label = f"block:{i}:{kind}"
        if kind == "code":
            en_blocks.append(block)  # モデルに送らない
            results.append({"label": label, "source": block, "output": block})
        elif kind == "heading":
            m = HEADING_RE.match(block.strip())
            text = do(m.group(2), label, history=history)
            en_blocks.append(f"{m.group(1)} {text}")
        elif kind == "image":
            m = IMAGE_RE.match(block.strip())
            alt = do(m.group(1), label, history=history)
            en_blocks.append(f"![{alt}]({m.group(2)})")
        elif kind == "list":
            # 箇条書きは行ごとに訳してマーカーを保つ（住所などの情報リストが
            # 1段落に潰れないように）。履歴は通常段落のものを引き継がない。
            out_lines = []
            for ln in block.strip().split("\n"):
                m = LIST_ITEM_RE.match(ln)
                if m and m.group(2).strip():
                    out_lines.append(m.group(1) + do(m.group(2), label))
                else:
                    out_lines.append(ln)
            en_blocks.append("\n".join(out_lines))
        else:
            src = paragraph_input(block)
            out = do(src, label, history=history)
            en_blocks.append(out)
            history = (src, out)

    en_body = "\n\n".join(en_blocks) + "\n"

    # 英語版全文（試訳・未校正の印つき）
    import yaml
    out_fm = dict(fm)
    for k, v in en_fm.items():
        out_fm[k] = v
    out_fm["author"] = "Muse"
    fm_text = yaml.safe_dump(out_fm, allow_unicode=True, sort_keys=False)
    en_md = ("<!-- PLaMo 3 Translate 8B による試訳。未校正・未公開 -->\n"
             f"---\n{fm_text}---\n\n{en_body}")
    (outdir / f"{slug}-en.md").write_text(en_md, encoding="utf-8")

    # en.json 登録用エントリ
    entry = {
        "title": en_fm.get("title", fm.get("title", "")),
        "category": en_fm.get("category", fm.get("category", "")),
        "summary": en_fm.get("summary", fm.get("summary", "")),
        "cover_alt": en_fm.get("cover_alt", fm.get("cover_alt", "")),
        "markdown": en_body,
        "source_hash": source_hash({"frontmatter": fm, "markdown": body}),
    }
    subtitle = en_fm.get("subtitle", fm.get("subtitle", ""))
    if subtitle:
        entry = {"title": entry["title"], "subtitle": subtitle,
                 **{k: v for k, v in entry.items() if k != "title"}}
    (outdir / f"{slug}-en-entry.json").write_text(
        json.dumps({f"{args.site}:{slug}": entry}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    (outdir / f"{slug}-results.json").write_text(
        json.dumps({"calls": tr.calls, "blocks": results},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    # 検証（機械照合。不一致は直さず報告する）
    def links(s):
        return sorted(set(LINK_RE.findall(s)))
    ja_left = [ln for ln in en_body.split("\n")
               if re.search(r"[ぁ-んァ-ヶ一-龠]", ln)]
    report = [
        f"# PLaMo翻訳バッチ検証: {args.site}:{slug}",
        "",
        f"- 見出し数: 原文 {sum(1 for k in kinds if k=='heading')} / "
        f"訳文 {len(re.findall(r'^#{1,6} ', en_body, re.M))}",
        f"- コードブロック数: 原文 {sum(1 for k in kinds if k=='code')} / "
        f"訳文 {en_body.count('```') // 2}",
        f"- 画像URL: 原文 {[IMAGE_RE.match(b.strip()).group(2) for b, k in zip(blocks, kinds) if k=='image']} / "
        f"訳文 {re.findall(r'!\[[^\]]*\]\(([^)]+)\)', en_body)}",
        f"- リンクURL集合一致: {links(body) == links(en_body)}",
        f"- 日本語残存行: {len(ja_left)} 件",
        f"- 生成時間合計: {sum(c['seconds'] for c in tr.calls):.1f} 秒 "
        f"（呼び出し {len(tr.calls)} 回）",
        "",
        "試訳は未校正・未公開。訳質の採否は校正工程で判断する。",
    ]
    (outdir / f"{slug}-report.md").write_text("\n".join(report) + "\n",
                                              encoding="utf-8")
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
