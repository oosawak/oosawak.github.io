"use strict";
/*
 * hp-music.js — 音楽データの再生モジュール（画面を持たない共通部品）
 *
 * 対応する曲データ:
 *   1. ステップ形式 (music-step): {t, bpm, v:[[base, wave, vol, steps], ...], d}
 *      - 1ステップ = 16分音符（長さは 60 / bpm / 4 秒）
 *      - steps の文字: 0-9a-z = base からの半音オフセット（36進数として読む）
 *        '.' = 前の音を伸ばす / ' ' = 休符（音を止める）
 *      - d（ドラム）: 1文字 = 1ステップ。k=キック, s=スネア, h=ハット, c=クラッシュ
 *   2. Markdown 形式: frontmatter + ## セクション（下記 parseMusicMarkdown）
 *   3. レシピ形式 (music-recipe): ArcadiaMusicForge の生成設定。
 *      このモジュールでは解釈だけ行い、再生は生成エンジン側の担当（将来接続）。
 *
 * 使い方:
 *   const song = HPMusic.parse(text);        // JSON でも Markdown でも可
 *   const player = HPMusic.createPlayer(song, { onStep(step, events, when) {} });
 *   player.play(); player.stop();
 */
(function (global) {

  function parseJSON(text) {
    const o = JSON.parse(text);
    if (o.type === "music-recipe" || o.kind === "recipe") {
      return { kind: "recipe", title: o.title || o.t || "Untitled", recipe: o };
    }
    const v = o.v || o.voices;
    if (!v) throw new Error("曲データに声部（v）がありません");
    return {
      kind: "step",
      title: o.t || o.title || "Untitled",
      bpm: o.bpm || 120,
      voices: v.map(function (p) {
        return { base: p[0], wave: p[1] || "square", vol: (p[2] == null ? 0.15 : p[2]), steps: String(p[3] || "") };
      }),
      drums: o.d || o.drums || ""
    };
  }

  /* Markdown 形式:
   * ---
   * title: CANON - PACHELBEL
   * type: music-step
   * bpm: 96
   * ---
   * ## v1 base=62 wave=square vol=0.13
   * g.......e.......
   * ## drums
   * ........
   * レシピは frontmatter のみ（type: music-recipe, genre/style/seed/...）。
   */
  function parseMusicMarkdown(md) {
    const fm = {};
    let body = md;
    const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (m) {
      body = md.slice(m[0].length);
      m[1].split("\n").forEach(function (line) {
        const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
      });
    }
    const type = (fm.type || "music-step").toLowerCase();
    if (type === "music-recipe" || type === "recipe") {
      const recipe = { type: "music-recipe" };
      Object.keys(fm).forEach(function (k) { if (k !== "type" && k !== "title") recipe[k] = fm[k]; });
      if (fm.seed != null && fm.seed !== "" && !isNaN(Number(fm.seed))) recipe.seed = Number(fm.seed);
      return { kind: "recipe", title: fm.title || "Untitled", recipe: recipe };
    }
    const song = { kind: "step", title: fm.title || "Untitled", bpm: Number(fm.bpm) || 120, voices: [], drums: "" };
    const sections = body.split(/^##\s+/m).slice(1);
    sections.forEach(function (sec) {
      const nl = sec.indexOf("\n");
      const head = (nl < 0 ? sec : sec.slice(0, nl)).trim();
      const text = (nl < 0 ? "" : sec.slice(nl + 1)).replace(/[`\s]+/g, function (s) { return s.indexOf("`") >= 0 ? "" : s; });
      const lines = (nl < 0 ? "" : sec.slice(nl + 1)).split("\n")
        .map(function (l) { return l.replace(/`/g, "").trim(); })
        .filter(function (l) { return l.length > 0; });
      const steps = lines.join("");
      const hm = head.match(/^(\S+)\s*(.*)$/);
      const name = hm ? hm[1].toLowerCase() : "";
      const params = {};
      (hm && hm[2] ? hm[2] : "").replace(/(\w+)=([^\s]+)/g, function (_, k, v) { params[k] = v; return _; });
      if (name === "drums" || name === "d") {
        song.drums = steps;
      } else {
        song.voices.push({
          base: Number(params.base) || 60,
          wave: params.wave || "square",
          vol: params.vol != null ? Number(params.vol) : 0.15,
          steps: steps
        });
      }
    });
    if (!song.voices.length) throw new Error("Markdown に声部がありません");
    return song;
  }

  function parse(text) {
    const t = String(text || "").trim();
    if (!t) throw new Error("データが空です");
    if (t.charAt(0) === "{") return parseJSON(t);
    if (t.indexOf("---") === 0 || t.indexOf("##") >= 0 || /\ntype\s*:/.test(t)) return parseMusicMarkdown(t);
    return parseJSON(t);
  }

  function totalSteps(song) {
    let n = song.drums ? song.drums.length : 0;
    song.voices.forEach(function (v) { n = Math.max(n, v.steps.length); });
    return n;
  }

  /* ---------------- 再生エンジン（ステップ形式） ---------------- */

  function createPlayer(song, opts) {
    opts = opts || {};
    if (song.kind !== "step") throw new Error("このモジュールで再生できるのはステップ形式だけです");
    const stepDur = 60 / song.bpm / 4;
    const total = totalSteps(song);
    let ctx = null, master = null, timer = null;
    let step = 0, nextTime = 0, playing = false;
    let noiseBuf = null;
    const live = song.voices.map(function () { return null; }); // {osc, gain}

    function ensureCtx() {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        const len = Math.floor(ctx.sampleRate * 0.5);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === "suspended") ctx.resume();
    }

    function stopVoice(i, when) {
      const L = live[i];
      if (!L) return;
      try {
        L.gain.gain.cancelScheduledValues(when);
        L.gain.gain.setValueAtTime(L.gain.gain.value, when);
        L.gain.gain.linearRampToValueAtTime(0.0001, when + 0.03);
        L.osc.stop(when + 0.05);
      } catch (e) {}
      live[i] = null;
    }

    function startVoice(i, v, midi, when) {
      stopVoice(i, when);
      const osc = ctx.createOscillator();
      osc.type = v.wave;
      osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(v.vol, when + 0.01);
      osc.connect(g); g.connect(master);
      osc.start(when);
      live[i] = { osc: osc, gain: g };
    }

    function drum(kind, when) {
      if (kind === "k") { // キック: サインのピッチ落下
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(150, when);
        o.frequency.exponentialRampToValueAtTime(45, when + 0.11);
        g.gain.setValueAtTime(0.5, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
        o.connect(g); g.connect(master);
        o.start(when); o.stop(when + 0.15);
      } else { // ノイズ系: s=スネア, h=ハット, c=クラッシュ
        const src = ctx.createBufferSource(); src.buffer = noiseBuf;
        const f = ctx.createBiquadFilter();
        const g = ctx.createGain();
        let dur = 0.05, vol = 0.12;
        if (kind === "s") { f.type = "bandpass"; f.frequency.value = 1800; dur = 0.11; vol = 0.2; }
        else if (kind === "h") { f.type = "highpass"; f.frequency.value = 7000; dur = 0.04; vol = 0.1; }
        else { f.type = "highpass"; f.frequency.value = 5000; dur = 0.4; vol = 0.16; }
        g.gain.setValueAtTime(vol, when);
        g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        src.connect(f); f.connect(g); g.connect(master);
        src.start(when); src.stop(when + dur + 0.02);
      }
    }

    function scheduleStep(s, when) {
      const events = [];
      song.voices.forEach(function (v, i) {
        const ch = s < v.steps.length ? v.steps.charAt(s) : " ";
        if (ch === ".") {
          // 伸ばす: 何もしない
        } else if (ch === " " || ch === "-" || ch === "") {
          if (live[i]) { stopVoice(i, when); events.push({ voice: i, type: "off" }); }
        } else {
          const off = parseInt(ch, 36);
          if (!isNaN(off)) {
            const midi = v.base + off;
            startVoice(i, v, midi, when);
            events.push({ voice: i, type: "on", midi: midi });
          }
        }
      });
      const dc = (s < song.drums.length ? song.drums.charAt(s) : ".").toLowerCase();
      if (dc === "k" || dc === "s" || dc === "h" || dc === "c") {
        drum(dc, when);
        events.push({ voice: -1, type: "drum", drum: dc });
      }
      if (opts.onStep) opts.onStep(s, events, when);
    }

    function tick() {
      while (nextTime < ctx.currentTime + 0.12) {
        scheduleStep(step, nextTime);
        nextTime += stepDur;
        step = (step + 1) % total;
      }
    }

    return {
      play: function () {
        if (playing || total === 0) return;
        ensureCtx();
        step = 0;
        nextTime = ctx.currentTime + 0.06;
        playing = true;
        tick();
        timer = setInterval(tick, 25);
        if (opts.onPlay) opts.onPlay();
      },
      stop: function () {
        if (!playing) return;
        playing = false;
        clearInterval(timer); timer = null;
        if (ctx) for (let i = 0; i < live.length; i++) stopVoice(i, ctx.currentTime);
        if (opts.onStop) opts.onStop();
      },
      get playing() { return playing; },
      get stepDur() { return stepDur; },
      get totalSteps() { return total; },
      get audioTime() { return ctx ? ctx.currentTime : 0; }
    };
  }

  global.HPMusic = { parse: parse, parseJSON: parseJSON, parseMusicMarkdown: parseMusicMarkdown, createPlayer: createPlayer, totalSteps: totalSteps };
})(window);
