#!/usr/bin/env python3
"""midi2step.py — MIDI ファイルを音楽データプレイヤーのステップ形式へ変換する。

使い方:
  python3 midi2step.py song.mid [--title 曲名] [--out 出力先プレフィックス]

出力: ステップ形式の JSON と Markdown 定義、それと #m= の URL（標準出力）。
ファイルへも書く場合は --out を付ける（<prefix>.json / <prefix>.md）。

変換の規則:
  - 1ステップ = 16分音符に量子化する
  - MIDI のトラックごとに声部を作る。同時発音（和音）は、重ならない音同士を
    同じ声部へ詰める「レーン分け」で複数の声部へ割る
  - 声部の基準音は最低音。音程は基準からの半音オフセットを 0-9a-z で表す
    （35半音を超える音域の声部は、レーン分けの段階で上下に分ける）
  - チャンネル10のドラムは k/s/h/c へ写す（GM の標準的な割当）
"""
import argparse, base64, gzip, json, struct, sys

DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
DRUM_MAP = {35: "k", 36: "k", 38: "s", 40: "s", 42: "h", 44: "h", 46: "h", 49: "c", 57: "c"}


def read_vlq(data, pos):
    value = 0
    while True:
        b = data[pos]; pos += 1
        value = (value << 7) | (b & 0x7F)
        if not (b & 0x80):
            return value, pos


def parse_midi(path):
    data = open(path, "rb").read()
    if data[:4] != b"MThd":
        raise ValueError("MIDI ファイルではありません")
    fmt, ntrks, division = struct.unpack(">HHH", data[8:14])
    if division & 0x8000:
        raise ValueError("SMPTE 形式の division には未対応です")
    pos = 14
    bpm = None
    tracks = []  # {name, notes:[(start,end,pitch)], drums:[(start,pitch)]}
    for _ in range(ntrks):
        if data[pos:pos + 4] != b"MTrk":
            raise ValueError("トラックが見つかりません")
        tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        pos += 8
        end = pos + tlen
        tick = 0
        running = None
        name = ""
        notes, drums = [], []
        open_notes = {}
        while pos < end:
            delta, pos = read_vlq(data, pos)
            tick += delta
            b = data[pos]
            if b & 0x80:
                status = b; pos += 1
                running = status if status < 0xF0 else None
            else:
                status = running
            if status == 0xFF:
                mtype = data[pos]; pos += 1
                mlen, pos = read_vlq(data, pos)
                payload = data[pos:pos + mlen]; pos += mlen
                if mtype == 0x51 and mlen == 3 and bpm is None:
                    us = (payload[0] << 16) | (payload[1] << 8) | payload[2]
                    bpm = round(60000000 / us)
                elif mtype == 0x03:
                    name = payload.decode("utf-8", "replace")
            elif status in (0xF0, 0xF7):
                mlen, pos = read_vlq(data, pos)
                pos += mlen
            else:
                hi = status & 0xF0
                ch = status & 0x0F
                if hi in (0xC0, 0xD0):
                    pos += 1
                    continue
                d1, d2 = data[pos], data[pos + 1]; pos += 2
                if hi == 0x90 and d2 > 0:
                    if ch == 9:
                        drums.append((tick, d1))
                    else:
                        open_notes.setdefault((ch, d1), []).append(tick)
                elif hi == 0x80 or (hi == 0x90 and d2 == 0):
                    key = (ch, d1)
                    if key in open_notes and open_notes[key]:
                        start = open_notes[key].pop(0)
                        notes.append((start, tick, d1))
        tracks.append({"name": name, "notes": notes, "drums": drums})
    return (bpm or 120), division, tracks


def split_lanes(notes, step_ticks):
    """(start_tick,end_tick,pitch) を量子化し、重ならないレーンへ分ける。"""
    q = []
    for (s, e, p) in notes:
        ss = int(round(s / step_ticks))
        ee = max(ss + 1, int(round(e / step_ticks)))
        q.append((ss, ee, p))
    q.sort(key=lambda n: (n[0], n[2]))
    lanes = []  # {notes:[], lo, hi, last_end}
    for (ss, ee, p) in q:
        placed = False
        for lane in lanes:
            if lane["last_end"] <= ss and max(lane["hi"], p) - min(lane["lo"], p) <= 35:
                lane["notes"].append((ss, ee, p))
                lane["lo"] = min(lane["lo"], p); lane["hi"] = max(lane["hi"], p)
                lane["last_end"] = max(lane["last_end"], ee)
                placed = True
                break
        if not placed:
            lanes.append({"notes": [(ss, ee, p)], "lo": p, "hi": p, "last_end": ee})
    return lanes


def lane_to_steps(lane, total):
    base = lane["lo"]
    chars = [" "] * total
    for (ss, ee, p) in lane["notes"]:
        chars[ss] = DIGITS[p - base]
        for s in range(ss + 1, min(ee, total)):
            if chars[s] == " ":
                chars[s] = "."
            else:
                break
    return base, "".join(chars)


def convert(path, title):
    bpm, division, tracks = parse_midi(path)
    step_ticks = division / 4.0
    total = 0
    per_track = []
    drum_events = []
    for tr in tracks:
        lanes = split_lanes(tr["notes"], step_ticks)
        for lane in lanes:
            for (_, ee, _) in lane["notes"]:
                total = max(total, ee)
        per_track.append((tr, lanes))
        for (tick, pitch) in tr["drums"]:
            ss = int(round(tick / step_ticks))
            total = max(total, ss + 1)
            if pitch in DRUM_MAP:
                drum_events.append((ss, DRUM_MAP[pitch]))
    voices = []
    for tr, lanes in per_track:
        lname = (tr["name"] or "").lower()
        for i, lane in enumerate(lanes):
            if "vocal" in lname or "melody" in lname:
                wave, vol = ("square", 0.13) if i == 0 else ("square", 0.07)
            elif "chord" in lname:
                wave, vol = "triangle", 0.09
            else:
                wave, vol = "square", 0.09
            base, steps = lane_to_steps(lane, total)
            voices.append([base, wave, vol, steps])
    dchars = ["."] * total
    for (ss, ch) in drum_events:
        dchars[ss] = ch
    drums = "".join(dchars) if drum_events else ""
    song = {"t": title, "bpm": bpm, "v": voices, "d": drums}
    return song, tracks


def to_markdown(song):
    lines = ["---", "title: " + song["t"], "type: music-step", "bpm: " + str(song["bpm"]), "---", ""]
    for i, (base, wave, vol, steps) in enumerate(song["v"]):
        lines.append("## v%d base=%d wave=%s vol=%s" % (i + 1, base, wave, vol))
        lines.append(steps)
        lines.append("")
    if song["d"]:
        lines.append("## drums")
        lines.append(song["d"])
        lines.append("")
    return "\n".join(lines)


def to_url(song):
    raw = json.dumps(song, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    comp = base64.urlsafe_b64encode(gzip.compress(raw, 9)).rstrip(b"=").decode()
    return raw, comp


def main():
    ap = argparse.ArgumentParser(description="MIDI をステップ形式へ変換する")
    ap.add_argument("midi")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--base-url", default="https://oosawak.github.io/materials/music-player/")
    args = ap.parse_args()
    title = args.title
    if not title:
        title = args.midi.replace("\\", "/").split("/")[-1].rsplit(".", 1)[0]
    song, tracks = convert(args.midi, title)
    total_notes = sum(len(t["notes"]) for t in tracks)
    md = to_markdown(song)
    raw, comp = to_url(song)
    print("曲名: %s" % song["t"])
    print("BPM %d / %d ステップ / 声部 %d / 音符 %d 個" % (song["bpm"], len(song["v"][0][3]) if song["v"] else 0, len(song["v"]), total_notes))
    print("JSON %d バイト / Markdown %d バイト / URL のデータ部分 %d 文字" % (len(raw), len(md.encode("utf-8")), len(comp)))
    print("URL: %s#m=%s" % (args.base_url, comp))
    if args.out:
        open(args.out + ".json", "w", encoding="utf-8").write(json.dumps(song, ensure_ascii=False, indent=1))
        open(args.out + ".md", "w", encoding="utf-8").write(md)
        print("書き出し: %s.json / %s.md" % (args.out, args.out))
    print(json.dumps(song, ensure_ascii=False))


if __name__ == "__main__":
    main()
