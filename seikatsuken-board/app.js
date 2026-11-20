'use strict';
/* 生活圏防災ライブボード (GitHub Pages版)
   気象庁データはブラウザから直接取得。通行止め・Threads・カメラは data/*.json を読むだけのビューア。
   data/*.json は Markdown 正本から Muse 側の定期ジョブが生成する。 */
const JMA = 'https://www.jma.go.jp/bosai';
const PREFS = [
  { name: '宮城県', code: '04', office: '040000' },
  { name: '山形県', code: '06', office: '060000' },
  { name: '福島県', code: '07', office: '070000' },
];
const PREF_BY_CODE = Object.fromEntries(PREFS.map(p => [p.code, p]));
const DEFAULT_PLACES = ['仙台市', '松島町', '山形市', '東根市', '米沢市', '福島市'];
const DEFAULT_COORDS = {
  '仙台市': [38.2682, 140.8694], '松島町': [38.3804, 141.0579],
  '山形市': [38.2404, 140.3633], '東根市': [38.4314, 140.3789],
  '米沢市': [37.9222, 140.1167], '福島市': [37.7608, 140.4747],
};
/* 予報区ごとの代表地点（気温の表示点） */
const REGION_POINT = {
  '040010': '仙台', '040020': '白石',
  '060010': '山形', '060020': '米沢', '060030': '酒田', '060040': '新庄',
  '070010': '福島', '070020': '小名浜', '070030': '会津若松',
};
const MERGE_SUFFIX = /^(仙台市|栗原市|大崎市|大和町)(東部|西部)$/;
const MERGE_SPECIAL = { '郡山市湖南': '郡山市', '天栄村湯本': '天栄村' };
const LS_KEY = 'skb-settings-v1';
const WX_ICON = { '100': '☀', '101': '☀', '102': '☀', '110': '☀', '111': '☀', '112': '☀',
  '200': '☁', '201': '☁', '202': '☁', '210': '☁', '211': '☁', '212': '☁',
  '300': '☂', '301': '☂', '302': '☂', '303': '☃', '304': '☂', '311': '☂', '313': '☃',
  '400': '☃', '401': '☃', '402': '☃', '403': '☃', '411': '☃', '413': '☃', '414': '☃' };
const WIND_DIR = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

const SECTIONS = [
  ['warnings', '警報・注意報'], ['closures', '通行止め'], ['quakes', '地震情報'],
  ['forecast', '天気予報'], ['cameras', 'ライブカメラ'], ['posts', '現地の声'],
  ['bears', '熊の目撃'], ['volcano', '火山情報'], ['flood', '洪水予報'],
  ['radiation', '放射線（モニタリングポスト）'], ['outage', '停電情報'], ['wbgt', '暑さ指数'],
];
function defaultShow() { const o = {}; for (const [k] of SECTIONS) o[k] = true; return o; }

const state = {
  settings: loadSettings(),
  catalog: null,          // Map name -> {name, short, pref, regionCode, warnAreas[]}
  warnByArea: new Map(),  // 警報エリア名 -> [{name, level}]
  officeHeadline: {},     // office -> headline text
  forecast: {},           // office -> {daily, weekly, overview}
  quakes: [],
  amedas: { table: null, latest: null, hourly: null },
  closures: null,
  threads: null,
  bears: null,
  extra: null,
  cameras: [],
  map: null, layers: null,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && Array.isArray(s.places) && s.places.length)
      return { places: s.places, hidePromo: !!s.hidePromo, show: Object.assign(defaultShow(), s.show || {}) };
  } catch (e) { /* ignore */ }
  return { places: DEFAULT_PLACES.slice(), hidePromo: true, show: defaultShow() };
}
const show = key => state.settings.show[key] !== false;
function saveSettings() { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortName = name => name.replace(/(市|町|村)$/, '');
async function fetchJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
async function fetchText(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); }

/* ---------- カタログ（気象庁 area.json） ---------- */
async function buildCatalog() {
  const area = await fetchJSON(JMA + '/common/const/area.json');
  const class10 = area.class10s, class20 = area.class20s;
  const cat = new Map();
  for (const [code20, info] of Object.entries(class20)) {
    let muni = info.name;
    if (MERGE_SPECIAL[muni]) muni = MERGE_SPECIAL[muni];
    else { const m = muni.match(MERGE_SUFFIX); if (m) muni = m[1]; }
    const pref = PREF_BY_CODE[code20.slice(0, 2)];
    if (!pref) continue;
    const regionCode = info.parent.slice(0, 5) + '0';
    if (!cat.has(muni)) cat.set(muni, { name: muni, short: shortName(muni), pref, regionCode, warnAreas: [] });
    cat.get(muni).warnAreas.push(info.name);
  }
  state.catalog = cat;
}

/* ---------- 警報（extra.xml → VPWW54） ---------- */
async function loadWarnings() {
  const feed = await fetchText(JMA + '/developer/xml/feed/extra.xml');
  const urls = {};
  for (const m of feed.matchAll(/<link[^>]*href="([^"]*VPWW54_(\d{6})[^"]*)"/g)) {
    if (!urls[m[2]]) urls[m[2]] = m[1];
  }
  state.warnByArea = new Map();
  await Promise.all(PREFS.map(async p => {
    const url = urls[p.office];
    if (!url) return;
    try {
      const xml = new DOMParser().parseFromString(await fetchText(url), 'text/xml');
      const hl = xml.querySelector('Headline > Text');
      if (hl) state.officeHeadline[p.office] = hl.textContent;
      xml.querySelectorAll('Warning > Item').forEach(item => {
        const areaName = item.querySelector('Area > Name')?.textContent;
        if (!areaName) return;
        const kinds = [];
        item.querySelectorAll('Kind').forEach(k => {
          const name = k.querySelector('Name')?.textContent || '';
          const status = k.querySelector('Status')?.textContent || '';
          if (!name || status === '解除') return;
          const level = name.includes('特別警報') ? 'special' : (name.endsWith('警報') ? 'warning' : 'advisory');
          kinds.push({ name, level });
        });
        if (kinds.length) state.warnByArea.set(areaName, kinds);
      });
    } catch (e) { console.warn('warnings', p.office, e); }
  }));
}
function warningsFor(place) {
  const out = [];
  for (const a of place.warnAreas) for (const k of (state.warnByArea.get(a) || [])) out.push(k);
  return out;
}
const chip = k => `<span class="chip ${k.level}">${esc(k.name)}</span>`;

/* ---------- 予報 ---------- */
async function loadForecasts(offices) {
  await Promise.all(offices.map(async office => {
    try {
      const [fc, ov] = await Promise.all([
        fetchJSON(`${JMA}/forecast/data/forecast/${office}.json`),
        fetchJSON(`${JMA}/forecast/data/overview_forecast/${office}.json`).catch(() => null),
      ]);
      state.forecast[office] = { fc, ov };
    } catch (e) { console.warn('forecast', office, e); }
  }));
}
function regionForecast(place) {
  const d = state.forecast[place.pref.office];
  if (!d) return null;
  const daily = d.fc[0];
  const ts0 = daily.timeSeries[0], ts1 = daily.timeSeries[1], ts2 = daily.timeSeries[2];
  const reg = ts0.areas.find(a => a.area.code === place.regionCode);
  if (!reg) return null;
  const idx = 0; // 今日
  const pops = ts1.areas.find(a => a.area.code === place.regionCode);
  const point = REGION_POINT[place.regionCode];
  const temps = point && ts2 ? ts2.areas.find(a => a.area.name === point) : null;
  // 短期予報の気温系列は tempsMin/tempsMax ではなく temps 配列（00時=最低・09時=最高）
  const targetDate = ts0.timeDefines[idx].slice(0, 10);
  let dayMin = null, dayMax = null;
  if (temps && temps.temps && ts2.timeDefines) {
    ts2.timeDefines.forEach((td, i) => {
      if (td.slice(0, 10) !== targetDate) return;
      if (td.slice(11, 13) === '00') dayMin = temps.temps[i];
      if (td.slice(11, 13) === '09') dayMax = temps.temps[i];
    });
  }
  const weekly = d.fc[1];
  const wTs0 = weekly.timeSeries[0];
  const wArea = wTs0.areas.find(a => a.area.code === place.pref.code + '0000') || wTs0.areas[0];
  const wTs1 = weekly.timeSeries[1];
  const wTemps = point && wTs1 ? wTs1.areas.find(a => a.area.name === point) : null;
  return {
    date: ts0.timeDefines[idx].slice(0, 10),
    weather: reg.weathers[idx], code: reg.weatherCodes[idx],
    pop: pops ? pops.pops[idx] : null,
    tmin: dayMin, tmax: dayMax,
    week: wTs0.timeDefines.map((t, i) => ({
      date: t.slice(5, 10), code: wArea.weatherCodes[i],
      pop: wArea.pops ? wArea.pops[i] : null,
      tmin: wTemps && wTemps.tempsMin ? wTemps.tempsMin[i] : null,
      tmax: wTemps && wTemps.tempsMax ? wTemps.tempsMax[i] : null,
    })),
    overview: d.ov ? (d.ov.headlineText || '') : '',
  };
}

/* ---------- 地震 ---------- */
async function loadQuakes() {
  const list = await fetchJSON(JMA + '/quake/data/list.json');
  const out = [];
  for (const q of list) {
    const m = String(q.cod || '').match(/^\+([\d.]+)\+([\d.]+)-(\d+)\/$/);
    if (!m) continue;
    const inPrefs = (q.int || []).some(i => PREF_BY_CODE[i.code]);
    const strong = ['3', '4', '5-', '5+', '6-', '6+', '7'].includes(q.maxi);
    if (!inPrefs && !strong) continue;
    out.push({
      at: q.at, anm: q.anm, mag: q.mag, maxi: q.maxi,
      lat: parseFloat(m[1]), lon: parseFloat(m[2]), depthKm: Math.round(parseInt(m[3], 10) / 1000),
      ttl: q.ttl || '',
    });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  state.quakes = out.slice(0, 12);
}

/* ---------- アメダス ---------- */
async function loadAmedas() {
  if (!state.amedas.table) state.amedas.table = await fetchJSON(JMA + '/amedas/const/amedastable.json');
  const latestTxt = (await fetchText(JMA + '/amedas/data/latest_time.txt')).trim();
  const fmt = iso => iso.replace(/[-:T]/g, '').slice(0, 14);
  const latestKey = fmt(latestTxt);
  const hourKey = latestKey.slice(0, 10) + '0000';
  const [latest, hourly] = await Promise.all([
    fetchJSON(`${JMA}/amedas/data/map/${latestKey}.json`),
    fetchJSON(`${JMA}/amedas/data/map/${hourKey}.json`).catch(() => ({})),
  ]);
  state.amedas.latest = latest; state.amedas.hourly = hourly;
  state.amedas.latestTime = latestTxt;
}
function stationCoords(id) {
  const st = state.amedas.table[id];
  if (!st) return null;
  return [st.lat[0] + st.lat[1] / 60, st.lon[0] + st.lon[1] / 60];
}
function nearestStation(lat, lon) {
  let best = null, bestD = 1e9;
  for (const [id, st] of Object.entries(state.amedas.table)) {
    const c = stationCoords(id);
    if (!c || c[0] < 36.7 || c[0] > 39.2 || c[1] < 139.2 || c[1] > 141.7) continue;
    const obs = state.amedas.latest[id];
    if (!obs || obs.temp == null) continue;
    const d = (c[0] - lat) ** 2 + (c[1] - lon) ** 2;
    if (d < bestD) { bestD = d; best = { id, name: st.kjName, coords: c, obs }; }
  }
  return best;
}
function placeCoords(place) {
  if (DEFAULT_COORDS[place.name]) return DEFAULT_COORDS[place.name];
  // 市町村名と一致する観測所を代理座標にする
  for (const [id, st] of Object.entries(state.amedas.table || {})) {
    if (st.kjName === place.short) { const c = stationCoords(id); if (c) return c; }
  }
  const pt = REGION_POINT[place.regionCode];
  for (const [id, st] of Object.entries(state.amedas.table || {})) {
    if (st.kjName === pt) { const c = stationCoords(id); if (c) return c; }
  }
  return DEFAULT_COORDS['仙台市'];
}
function amedasLine(st) {
  if (!st) return '観測値なし';
  const o = st.obs;
  const parts = [];
  if (o.temp) parts.push(`<span class="amedas-temp">${o.temp[0]}<span class="amedas-unit">℃</span></span>`);
  if (o.precipitation1h) parts.push(`降水 ${o.precipitation1h[0]}mm/h`);
  if (o.wind) {
    const wd = o.windDirection != null ? WIND_DIR[o.windDirection[0]] : null;
    parts.push(`風 ${wd ? wd + ' ' : ''}${o.wind[0]}m/s`);
  }
  const snow = state.amedas.hourly[st.id]?.snow;
  if (snow) parts.push(`積雪 ${snow[0]}cm`);
  return `${esc(st.name)}: ${parts.join(' / ') || '観測値なし'}`;
}

/* ---------- data/*.json（ビューア部分） ---------- */
async function loadLocalData() {
  const [cl, th, cam, br, ex] = await Promise.all([
    fetchJSON('data/closures.json').catch(() => null),
    fetchJSON('data/threads.json').catch(() => null),
    fetchJSON('data/cameras.json').catch(() => ({ cameras: [] })),
    fetchJSON('data/bears.json').catch(() => null),
    fetchJSON('data/extra.json').catch(() => null),
  ]);
  state.closures = cl; state.threads = th; state.cameras = cam.cameras || [];
  state.bears = br;
  state.extra = ex;
}
function bearsFor(place) {
  if (!state.bears?.records) return [];
  return state.bears.records.filter(r => r.area === place.name);
}
function daysAgo(dateStr) {
  return (Date.now() - new Date(dateStr + 'T00:00:00+09:00').getTime()) / 86400000;
}

/* ---------- 描画 ---------- */
function selectedPlaces() {
  return state.settings.places.map(n => state.catalog.get(n)).filter(Boolean);
}
function renderWarningsSection(places) {
  const body = document.getElementById('body-warnings');
  const sum = document.getElementById('sum-warnings');
  let html = '', activeCount = 0, topLevel = '';
  for (const p of places) {
    const ws = warningsFor(p);
    if (ws.length) activeCount++;
    if (ws.some(k => k.level !== 'advisory')) topLevel = 'warning';
    else if (ws.length && topLevel !== 'warning') topLevel = 'advisory';
    html += `<h3>${esc(p.name)}</h3><div>${ws.length ? ws.map(chip).join('') : '<span class="chip none">発表なし</span>'}</div>`;
  }
  for (const p of PREFS) {
    const hl = state.officeHeadline[p.office];
    if (hl) html += `<p class="muted">${esc(p.name)}: ${esc(hl)}</p>`;
  }
  body.innerHTML = html || '<p class="muted">取得できませんでした</p>';
  sum.textContent = activeCount ? `${activeCount}か所で発表中` : '選択中の場所に発表なし';
  document.getElementById('sec-warnings').dataset.state = topLevel;
}
function renderClosuresSection() {
  const body = document.getElementById('body-closures');
  const sum = document.getElementById('sum-closures');
  const c = state.closures;
  if (!c) { body.innerHTML = '<p class="muted">データを取得できませんでした</p>'; sum.textContent = 'データなし'; document.getElementById('sec-closures').dataset.state = ''; return; }
  let html = '', total = 0, unknown = 0;
  for (const o of c.sources) {
    html += `<h3>${esc(o.office)}（<a href="${esc(o.sourceUrl)}" target="_blank" rel="noopener">出典</a>）</h3>`;
    if (o.status === 'ok') {
      total += o.items.length;
      html += o.items.length
        ? '<ul>' + o.items.map(i => `<li>${esc(i.title)}${i.period ? `（${esc(i.period)}）` : ''}</li>`).join('') + '</ul>'
        : '<p>現在、掲載されている通行規制はありません。</p>';
    } else {
      unknown++;
      html += `<p class="muted">状態不明（取得・抽出に失敗したため「なし」とは判定していません）。${esc(o.note || '')} <a href="https://www.road-info-prvs.mlit.go.jp/roadinfo/pc/" target="_blank" rel="noopener">道路情報提供システム</a>で確認してください。</p>`;
    }
  }
  html += `<p class="muted">取得: ${esc(c.generatedAt || '')}</p>`;
  body.innerHTML = html;
  sum.textContent = `通行規制 ${total}件` + (unknown ? ` / ${unknown}事務所は状態不明` : '');
  document.getElementById('sec-closures').dataset.state = total > 0 ? 'warning' : '';
}
function renderQuakesSection() {
  const body = document.getElementById('body-quakes');
  const sum = document.getElementById('sum-quakes');
  if (!state.quakes.length) { body.innerHTML = '<p class="muted">対象の地震はありません</p>'; sum.textContent = 'なし'; return; }
  body.innerHTML = '<ul>' + state.quakes.map(q =>
    `<li>${esc(q.at.replace('T', ' ').slice(0, 16))} ${esc(q.anm)} M${esc(q.mag)} 最大震度${esc(q.maxi)} 深さ${q.depthKm}km</li>`).join('') + '</ul>';
  const q0 = state.quakes[0];
  sum.textContent = `最新: ${q0.anm} M${q0.mag} 最大震度${q0.maxi}`;
}
function renderFloodSection() {
  const body = document.getElementById('body-flood');
  const sum = document.getElementById('sum-flood');
  if (!body || !sum) return;
  const items = state.extra?.flood?.items || [];
  if (state.extra && state.extra.flood?.status === 'unknown') {
    body.innerHTML = '<p class="muted">洪水予報の取得状態が不明です</p>'; sum.textContent = '状態不明'; return;
  }
  if (!items.length) { body.innerHTML = '<p class="muted">発表中の洪水予報はありません</p>'; sum.textContent = 'なし'; return; }
  body.innerHTML = '<ul>' + items.map(f =>
    `<li>${esc(f.issued)} ${esc(f.river)}: ${esc(f.level)}（${esc(f.area)}）</li>`).join('') + '</ul>';
  sum.textContent = `${items[0].river} ${items[0].level} ほか${items.length}件`;
}
function renderVolcanoSection() {
  const body = document.getElementById('body-volcano');
  const sum = document.getElementById('sum-volcano');
  if (!body || !sum) return;
  const vols = state.extra?.volcano?.items || [];
  if (!vols.length) { body.innerHTML = '<p class="muted">火山データがまだありません</p>'; sum.textContent = '—'; return; }
  body.innerHTML = '<ul>' + vols.map(v =>
    `<li>${esc(v.name)}: 噴火警戒レベル${esc(v.level)}${v.headline ? ` — ${esc(v.headline)}` : ''}${v.updated ? `（${esc(v.updated)}）` : ''}</li>`).join('') + '</ul>';
  const top = vols.reduce((a, v) => Math.max(a, parseInt(v.level, 10) || 1), 1);
  sum.textContent = vols.map(v => `${v.name} レベル${v.level}`).join(' / ');
}
function threadsFor(place) {
  const e = state.threads?.places?.[place.short];
  return e ? e.posts : [];
}
function postHTML(p) {
  // 埋め込みボタンがある投稿は、埋め込み側にも「Threadsで見る」があるので上のリンクは付けない（二重回避）
  const withEmbed = p.liked && p.hasImage;
  let h = `<div class="post${p.promo ? ' promo' : ''}"><div class="meta">@${esc(p.username)} ・ ${esc(p.takenAt.replace('T', ' ').slice(0, 16))} ・ ♥${p.likeCount}${p.liked ? ' ・ ★本人のいいね' : ''}${p.watched ? ' ・ 見張り:' + esc(p.community || '') : ''}${p.spot ? ' ・ ' + esc(p.spot) : ''}${p.promo ? ' ・ 宣伝の可能性' : ''}</div>` +
    `<div class="text">${esc(p.text)}</div>` +
    (withEmbed ? '' : `<div class="meta"><a href="${esc(p.url)}" target="_blank" rel="noopener">元投稿を見る</a>${p.hasImage ? '（画像つき）' : ''}</div>`);
  // ★本人のいいね投稿だけ、埋め込みで画像・動画も出す。最初は折りたたみ。
  // 公式 embed.js は「ページ内で最初に処理した1件」しか描画しない挙動があったため、
  // 広げた時に iframe を直接作る方式にした（embed-test2.html で3件同時表示を確認済み）。
  if (p.liked && p.hasImage) {
    h += `<button type="button" class="embed-btn">写真・動画を見る</button><div class="embed-box" hidden data-permalink="${esc(p.url)}"></div>`;
  }
  return h + '</div>';
}

function renderCards(places) {
  const wrap = document.getElementById('cards');
  wrap.innerHTML = places.map((p, i) => {
    const ws = warningsFor(p);
    const fc = regionForecast(p);
    const coords = placeCoords(p);
    const st = state.amedas.latest ? nearestStation(coords[0], coords[1]) : null;
    const cams = state.cameras.filter(c => c.place === p.short);
    const posts = threadsFor(p).filter(x => !(state.settings.hidePromo && x.promo));
    const shown = posts.slice(0, 3), rest = posts.slice(3);
    let h = `<article class="card" id="card-${i}"><h3><span class="num">${i + 1}</span>${esc(p.name)}<span class="card-pref">${esc(p.pref.name)}</span></h3>`;
    if (show('warnings')) h += `<div>${ws.length ? ws.map(chip).join('') : '<span class="chip none">警報・注意報なし</span>'}</div>`;
    if (show('forecast') && fc) {
      h += `<div class="wx"><span class="wxicon">${WX_ICON[fc.code] || ''}</span>${esc(fc.weather)}${fc.pop != null && fc.pop !== '' ? ` <span class="temps">降水確率 ${esc(fc.pop)}%</span>` : ''}</div>`;
      h += `<div class="temps">${fc.tmin != null && fc.tmin !== '' ? `最低 ${esc(fc.tmin)}℃ / ` : ''}${fc.tmax != null && fc.tmax !== '' ? `最高 ${esc(fc.tmax)}℃` : ''}</div>`;
      h += `<div class="temps">週間: ${fc.week.slice(0, 5).map(w => `${esc(w.date)} ${WX_ICON[w.code] || ''}${w.tmax != null && w.tmax !== '' ? ` ${esc(w.tmax)}℃` : ''}`).join(' ・ ')}</div>`;
    } else if (show('forecast')) h += '<div class="muted">予報を取得できませんでした</div>';
    if (show('forecast')) h += `<div class="amedas">アメダス ${amedasLine(st)}</div>`;
    const rad = state.extra?.radiation?.places?.[p.name];
    if (show('radiation') && rad) h += `<div class="amedas">放射線 ${esc(rad.value)} μSv/h（${esc(rad.post)}・${esc(rad.at)}）</div>`;
    const wv = state.extra?.wbgt?.places?.[p.name];
    if (show('wbgt') && wv) h += `<div class="amedas">暑さ指数 ${esc(wv.value)}（${esc(wv.level)}）</div>`;
    const og = state.extra?.outage?.places?.[p.name];
    if (show('outage') && og && og.households > 0) h += `<div class="amedas">停電: 約${esc(og.households)}軒（東北電力ネットワーク）</div>`;
    if (show('cameras')) for (const c of cams) {
      h += `<div class="cam"><button type="button" class="cam-btn" data-open-label="ライブカメラ: ${esc(c.name)} を見る" data-close-label="ライブカメラ: ${esc(c.name)} を閉じる">ライブカメラ: ${esc(c.name)} を閉じる</button><div class="cam-box" data-built="1"><img src="${esc(c.imageUrl)}" alt="${esc(c.name)}" loading="lazy"><div class="cap">出典: ${esc(c.source)}（${esc(c.updateInterval)}更新 / 画像は表示のみで保存しません）</div></div></div>`;
    }
    const bears = bearsFor(p);
    if (show('bears') && p.pref.name === '山形県') {
      h += `<h4>熊の目撃（県公式）</h4><div class="muted">山形県は市町村別の件数（PDF）のみ公表のため一覧はありません: <a href="https://www.pref.yamagata.jp/050011/kurashi/shizen/seibutsu/about_kuma/kumamokugeki.html" target="_blank" rel="noopener">県のクマ目撃情報</a></div>`;
    } else if (show('bears') && bears.length) {
      const n30 = bears.filter(r => daysAgo(r.date) <= 30).length;
      h += `<h4>熊の目撃（県公式）</h4><div class="bears">` +
        bears.slice(0, 3).map(r => `<div>${esc(r.date.slice(5).replace('-', '/'))} ${esc(r.time)} ${esc(r.district.slice(0, 30))} ${esc(r.kind)}${r.count ? ` ${r.count}頭` : ''}${r.urban === '住居集合地域等' ? '（市街地）' : ''}</div>`).join('') +
        `<div class="muted">直近30日で${n30}件（${esc(bears[0].pref)}発表）</div></div>`;
    }
    if (show('posts')) {
      h += `<h4>現地の声（Threads・いいねから）</h4>`;
      if (p.pref.name === '宮城県') h += `<div class="muted">宮城の天気コーナーは TBC「ウォッチン！みやぎ」: <a href="https://www.tbc-sendai.co.jp/watchin/" target="_blank" rel="noopener">公式ページ</a></div>`;
      h += shown.length ? shown.map(postHTML).join('') : '<div class="muted">いいねした投稿はまだありません</div>';
      if (rest.length) h += `<div class="more" hidden>${rest.map(postHTML).join('')}</div><button type="button" class="more-btn">もっと見る（${rest.length}件）</button>`;
    }
    h += '</article>';
    return h;
  }).join('');
  wrap.querySelectorAll('.more-btn').forEach(b => {
    const label = b.textContent;
    b.addEventListener('click', () => {
      const m = b.previousElementSibling; m.hidden = !m.hidden;
      b.textContent = m.hidden ? label : '閉じる';
    });
  });
  wrap.querySelectorAll('.cam-btn').forEach(b => {
    b.addEventListener('click', () => {
      const box = b.nextElementSibling;
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? b.dataset.openLabel : b.dataset.closeLabel;
    });
  });
  wrap.querySelectorAll('.embed-btn').forEach(b => {
    b.addEventListener('click', () => {
      const box = b.nextElementSibling;
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? '写真・動画を見る' : '閉じる';
      if (!box.hidden && !box.dataset.built) {
        box.dataset.built = '1';
        const src = box.dataset.permalink.replace('threads.com', 'threads.net') + '/embed';
        box.innerHTML = `<iframe src="${src}" loading="lazy" allowfullscreen title="Threads埋め込み"></iframe>`;
      }
    });
  });
}
function renderWall(places) {
  const list = document.getElementById('wallWarningList');
  const items = [];
  if (show('warnings')) for (const p of places) {
    const ws = warningsFor(p);
    if (ws.length) items.push(`<div class="wall-item">${esc(p.short)}: ${ws.map(chip).join('')}</div>`);
  }
  list.innerHTML = items.length ? items.join('') : '<div class="wall-item">選択中の場所に警報・注意報はありません</div>';
}
function renderTicker(places) {
  const parts = [];
  if (show('warnings')) for (const p of places) {
    const ws = warningsFor(p);
    if (ws.length) parts.push(`【警報】${p.short}: ${ws.map(w => w.name).join('・')}`);
  }
  if (show('closures') && state.closures) for (const o of state.closures.sources) {
    if (o.status === 'ok') for (const i of o.items) parts.push(`【通行止め】${i.title}`);
    else parts.push(`【通行止め】${o.office}の規制情報は状態不明です`);
  }
  if (show('quakes')) for (const q of state.quakes.slice(0, 3)) parts.push(`【地震】${q.at.slice(5, 16).replace('T', ' ')} ${q.anm} M${q.mag} 最大震度${q.maxi}`);
  if (show('flood') && state.extra?.flood?.items) for (const f of state.extra.flood.items.slice(0, 3)) parts.push(`【洪水】${f.river}: ${f.level}`);
  if (show('volcano') && state.extra?.volcano?.items) for (const v of state.extra.volcano.items) {
    if ((parseInt(v.level, 10) || 1) >= 2) parts.push(`【火山】${v.name}: 噴火警戒レベル${v.level}`);
  }
  if (show('outage') && state.extra?.outage?.places) for (const p of places) {
    const og = state.extra.outage.places[p.name];
    if (og && og.households > 0) parts.push(`【停電】${p.short}: 約${og.households}軒`);
  }
  if (show('bears')) for (const p of places) {
    const b = bearsFor(p).find(r => daysAgo(r.date) <= 2);
    if (b) parts.push(`【熊】${p.short}: ${b.district.slice(0, 20)}で${b.kind}（${b.date.slice(5).replace('-', '/')}）`);
  }
  if (!parts.length) parts.push('現在、警報・通行止め・大きな地震はありません');
  document.getElementById('tickerInner').innerHTML = parts.map(t => `<span>${esc(t)}</span>`).join('');
  let tState = '';
  for (const p of places) {
    const ws = warningsFor(p);
    if (ws.some(k => k.level !== 'advisory')) tState = 'warning';
    else if (ws.length && tState !== 'warning') tState = 'advisory';
  }
  if (state.closures && state.closures.sources.some(o => o.status === 'ok' && o.items.length)) tState = 'warning';
  if (state.quakes.some(q => ['3', '4', '5-', '5+', '6-', '6+', '7'].includes(q.maxi))) tState = 'warning';
  document.getElementById('ticker').dataset.state = tState;
}
function renderCameraBar() {
  const bar = document.getElementById('cameraBar');
  const cams = show('cameras') ? state.cameras : [];
  if (!cams.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<button type="button" class="cambar-toggle">ライブカメラ一覧（${cams.length}台）を開く</button>`
    + `<div class="cambar-list" hidden>${cams.map((c, i) => `<button type="button" data-cam="${i}">カメラ: ${esc(c.name)}</button>`).join('')}</div>`;
  const list = bar.querySelector('.cambar-list');
  const toggle = bar.querySelector('.cambar-toggle');
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.textContent = list.hidden ? `ライブカメラ一覧（${cams.length}台）を開く` : 'ライブカメラ一覧を閉じる';
  });
  list.querySelectorAll('button').forEach(b => b.addEventListener('click', () => focusCamera(parseInt(b.dataset.cam, 10))));
}

/* ---------- 地図 ---------- */
function initMap() {
  state.map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(state.map);
  state.layers = L.layerGroup().addTo(state.map);
  state.myLayer = L.layerGroup().addTo(state.map);
  state.map.on('contextmenu', onMapContextMenu);
  drawMyPoints();
}
const CAM_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#231a00" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
function placePopup(p, idx) {
  const ws = warningsFor(p);
  const fc = regionForecast(p);
  const coords = placeCoords(p);
  const st = state.amedas.latest ? nearestStation(coords[0], coords[1]) : null;
  const posts = threadsFor(p).filter(x => !(state.settings.hidePromo && x.promo));
  const cams = state.cameras.filter(c => c.place === p.short);
  let h = `<h4>${idx + 1}. ${esc(p.name)}</h4>`;
  h += `<div>${ws.length ? ws.map(chip).join('') : '<span class="muted">警報・注意報なし</span>'}</div>`;
  if (fc) h += `<div>${WX_ICON[fc.code] || ''} ${esc(fc.weather)}</div>`;
  h += `<div class="muted">アメダス ${amedasLine(st)}</div>`;
  if (posts.length) h += `<div><b>現地の声・最新:</b> ${esc(posts[0].text.slice(0, 80))} <a href="${esc(posts[0].url)}" target="_blank" rel="noopener">元投稿</a></div>`;
  for (const c of cams) h += `<div><img src="${esc(c.imageUrl)}" alt="${esc(c.name)}"><div class="muted">${esc(c.name)} / 出典: ${esc(c.source)}</div></div>`;
  return h;
}
function renderMap(places) {
  if (!state.map) initMap();
  state.layers.clearLayers();
  const bounds = [];
  places.forEach((p, i) => {
    const c = placeCoords(p);
    bounds.push(c);
    const posts = show('posts') ? threadsFor(p).length : 0;
    const icon = L.divIcon({ className: '', html: `<div class="pin-wrap"><div class="pin-num">${i + 1}</div>${posts ? `<span class="pin-badge">${posts}</span>` : ''}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(c, { icon }).addTo(state.layers)
      .bindPopup(placePopup(p, i))
      .bindTooltip(`${esc(p.short)}${posts ? `（現地の声 ${posts}件）` : ''}`);
  });
  if (show('quakes')) for (const q of state.quakes) {
    const color = ['6-', '6+', '7'].includes(q.maxi) ? '#e5484d'
      : ['5-', '5+'].includes(q.maxi) ? '#e8762d' : q.maxi === '4' ? '#f0a832' : '#6fc3ff';
    L.circleMarker([q.lat, q.lon], { radius: 4 + parseFloat(q.mag || 0) * 2.2, color, fillColor: color, fillOpacity: .55, weight: 1 })
      .addTo(state.layers)
      .bindPopup(`<h4>地震</h4>${esc(q.at.replace('T', ' ').slice(0, 16))}<br>${esc(q.anm)} M${esc(q.mag)}<br>最大震度 ${esc(q.maxi)} / 深さ ${q.depthKm}km`);
  }
  state.cameraMarkers = (show('cameras') ? state.cameras : []).map(c => {
    const icon = L.divIcon({ className: '', html: `<div class="cam-icon">${CAM_SVG}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    const mk = L.marker([c.lat, c.lon], { icon }).addTo(state.layers)
      .bindPopup(`<h4>${esc(c.name)}</h4><img src="${esc(c.imageUrl)}" alt="${esc(c.name)}"><div class="muted">出典: ${esc(c.source)}（${esc(c.updateInterval)}更新）</div>`);
    return mk;
  });
  state.cameras.forEach(c => bounds.push([c.lat, c.lon]));
  const placeNames = new Set(places.map(p => p.name));
  const bearPins = (show('bears') ? (state.bears?.records || []) : [])
    .filter(r => r.lat && placeNames.has(r.area) && daysAgo(r.date) <= 14)
    .slice(0, 60);
  for (const r of bearPins) {
    const icon = L.divIcon({ className: '', html: '<div class="bear-pin">熊</div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker([r.lat, r.lon], { icon }).addTo(state.layers)
      .bindPopup(`<h4>熊の${esc(r.kind)}</h4>${esc(r.date)} ${esc(r.time)}<br>${esc(r.muni)} ${esc(r.district)}<br>${r.count ? `${r.count}頭 / ` : ''}出典: ${esc(r.source)}`);
  }
  if (bounds.length) state.map.fitBounds(bounds, { padding: [30, 30] });
}
function focusCamera(i) {
  const c = state.cameras[i];
  if (!c || !state.map) return;
  state.map.setView([c.lat, c.lon], 12);
  state.cameraMarkers[i].openPopup();
}

/* ---------- 設定パネル ---------- */
function renderSettings() {
  const list = document.getElementById('placeList');
  const q = (document.getElementById('placeSearch').value || '').trim();
  let html = '';
  for (const pref of PREFS) {
    const names = [...state.catalog.values()].filter(p => p.pref === pref)
      .map(p => p.name).filter(n => !q || n.includes(q)).sort();
    if (!names.length) continue;
    html += `<h3>${esc(pref.name)}</h3>` + names.map(n =>
      `<label><input type="checkbox" data-place="${esc(n)}" ${state.settings.places.includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('');
  }
  list.innerHTML = html || '<p class="muted">見つかりません</p>';
  list.querySelectorAll('input[data-place]').forEach(cb => cb.addEventListener('change', () => {
    const n = cb.dataset.place;
    if (cb.checked) { if (!state.settings.places.includes(n)) state.settings.places.push(n); }
    else state.settings.places = state.settings.places.filter(x => x !== n);
    saveSettings(); refreshBoard(false);
  }));
  document.getElementById('hidePromoToggle').checked = state.settings.hidePromo;
  const st = document.getElementById('sectionToggles');
  st.innerHTML = SECTIONS.map(([k, label]) =>
    `<label><input type="checkbox" data-section="${k}" ${show(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
  st.querySelectorAll('input[data-section]').forEach(cb => cb.addEventListener('change', () => {
    state.settings.show[cb.dataset.section] = cb.checked;
    saveSettings(); refreshBoard(false);
  }));
}

/* ---------- 全体更新 ---------- */
async function refreshBoard(refetch = true) {
  const places = selectedPlaces();
  if (refetch) {
    const offices = [...new Set(places.map(p => p.pref.office))];
    await Promise.allSettled([
      loadWarnings(), loadForecasts(offices), loadQuakes(), loadAmedas(), loadLocalData(),
    ]);
  }
  // 表示トグル（設定画面）で選ばれていない帯は丸ごと隠す
  const band = (id, key) => { const el = document.getElementById(id); if (el) el.hidden = !show(key); };
  band('sec-warnings', 'warnings'); band('sec-closures', 'closures'); band('sec-quakes', 'quakes');
  band('sec-flood', 'flood'); band('sec-volcano', 'volcano');
  // 1か所の描画失敗で全体が止まらないように、各描画を個別に守る
  const renders = [
    () => renderWarningsSection(places),
    () => renderClosuresSection(),
    () => renderQuakesSection(),
    () => renderFloodSection(),
    () => renderVolcanoSection(),
    () => renderCards(places),
    () => renderWall(places),
    () => renderTicker(places),
    () => renderCameraBar(),
    () => renderMap(places),
  ];
  for (const r of renders) { try { r(); } catch (e) { console.warn('render', e); } }
  const now = new Date();
  document.getElementById('updatedLine').textContent =
    `最終更新: ${now.toLocaleString('ja-JP')}（気象庁データを直接取得 / 通行止め・現地の声・熊・火山・洪水予報・放射線・停電は定期生成データ）`;
}

/* ---------- 時計 ---------- */
function tickClock() {
  const now = new Date();
  const wd = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('clock').innerHTML =
    `${pad(now.getHours())}<span class="c-colon">:</span>${pad(now.getMinutes())}<span class="c-sec">:${pad(now.getSeconds())}</span>`;
  document.getElementById('dateLine').textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${wd}）`;
}

/* ---------- 起動 ---------- */
document.querySelectorAll('.sec-head').forEach(b => b.addEventListener('click', () => {
  const body = document.getElementById(b.dataset.target);
  body.hidden = !body.hidden;
  b.querySelector('.sec-arrow').textContent = body.hidden ? '▸' : '▾';
}));
document.getElementById('refreshBtn').addEventListener('click', () => refreshBoard(true));
document.getElementById('tickerExpand').addEventListener('click', () => {
  document.querySelectorAll('.sec-body').forEach(b => { b.hidden = false; });
  document.querySelectorAll('.sec-head .sec-arrow').forEach(a => { a.textContent = '▾'; });
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
document.getElementById('wallBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('wallpaper');
  document.getElementById('wallWarnings').hidden = !on;
  document.getElementById('wallBtn').textContent = on ? '通常表示に戻す' : '壁紙モード';
});
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsPanel').hidden = false; renderSettings();
});
document.getElementById('settingsClose').addEventListener('click', () => {
  document.getElementById('settingsPanel').hidden = true;
});
document.getElementById('placeSearch').addEventListener('input', renderSettings);
document.getElementById('hidePromoToggle').addEventListener('change', e => {
  state.settings.hidePromo = e.target.checked; saveSettings(); refreshBoard(false);
});
document.getElementById('settingsDefaults').addEventListener('click', () => {
  state.settings.places = DEFAULT_PLACES.slice(); saveSettings(); renderSettings(); refreshBoard(false);
});

(async () => {
  tickClock(); setInterval(tickClock, 1000);
  try { await buildCatalog(); } catch (e) {
    document.getElementById('updatedLine').textContent = '地域カタログの取得に失敗しました。通信を確認して「更新」を押してください。';
    return;
  }
  await refreshBoard(true);
  setInterval(() => refreshBoard(true), 10 * 60 * 1000);
})();

// ===== 登録地点（自宅・仕事場など）: 長押しで登録、判定は登録時だけ、保存は localStorage のみ =====
const MYPOINTS_KEY = 'seikatsuken.mypoints.v1';
let myPoints = [];
try { myPoints = JSON.parse(localStorage.getItem(MYPOINTS_KEY) || '[]'); } catch (e) { myPoints = []; }
let hazardIndex = null;
let hazardBoundaries = null;
let mpPending = null;

function saveMyPoints() { try { localStorage.setItem(MYPOINTS_KEY, JSON.stringify(myPoints)); } catch (e) {} }

function pipRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pipPolygon(lon, lat, polys) {
  if (!polys.length || !pipRing(lon, lat, polys[0])) return false;
  for (let k = 1; k < polys.length; k++) if (pipRing(lon, lat, polys[k])) return false;
  return true;
}
function pipGeom(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pipPolygon(lon, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => pipPolygon(lon, lat, p));
  return false;
}

async function loadHazardMeta() {
  if (!hazardIndex) hazardIndex = await (await fetch('data/hazard-muni/index.json')).json();
  if (!hazardBoundaries) hazardBoundaries = await (await fetch('data/hazard-muni/boundaries.geojson')).json();
}
function findMuni(lon, lat) {
  if (!hazardBoundaries) return null;
  for (const f of hazardBoundaries.features) {
    if (pipGeom(lon, lat, f.geometry)) return f.properties;
  }
  return null;
}

const FLOOD_RANKS = { 1: '0.5m未満', 2: '0.5〜1m', 3: '1〜2m', 4: '2〜5m', 5: '5〜10m', 6: '10〜20m', 7: '20m以上' };
const SLIDE_KINDS = { 1: '急傾斜地の崩壊', 2: '土石流', 3: '地すべり' };
const SLIDE_ZONES = { 1: '警戒区域', 2: '特別警戒区域' };

async function judgePoint(lat, lon) {
  await loadHazardMeta();
  const muni = findMuni(lon, lat);
  const out = { muni: muni ? { code: muni.code, name: muni.name, pref: muni.pref } : null,
                judgedAt: new Date().toISOString(), landslide: null, flood: null, tsunami: null };
  if (!muni) return out;
  const entry = (hazardIndex.municipalities || []).find(m => m.code === muni.code);
  for (const type of ['landslide', 'flood', 'tsunami']) {
    if (type === 'flood' && entry && entry.flood_covered === false) { out.flood = { status: 'notcovered' }; continue; }
    if (!entry || !entry.types.includes(type)) { out[type] = { status: 'nodata' }; continue; }
    const gj = await (await fetch(`data/hazard-muni/${muni.code}-${type}.geojson`)).json();
    const hits = gj.features.filter(f => pipGeom(lon, lat, f.geometry)).map(f => f.properties);
    if (!hits.length) { out[type] = { status: 'outside' }; continue; }
    if (type === 'landslide') {
      const seen = new Map();
      for (const p of hits) {
        const h = { zone: p.A33_002, kind: p.A33_001, name: p.A33_005 || '', loc: p.A33_006 || '' };
        seen.set(`${h.zone}|${h.kind}|${h.name}`, h);
      }
      out.landslide = { status: 'inside', hits: [...seen.values()] };
    } else if (type === 'flood') {
      out.flood = { status: 'inside', rank: Math.max(...hits.map(p => p.A31b_201 || 0)) };
    } else {
      out.tsunami = { status: 'inside', dists: [...new Set(hits.map(p => p.A40_003).filter(Boolean))] };
    }
  }
  return out;
}

function hazardSummary(pt) {
  const s = [];
  const L = pt.landslide, F = pt.flood, T = pt.tsunami;
  if (L) s.push('土砂: ' + (L.status === 'inside'
    ? L.hits.map(h => `${SLIDE_ZONES[h.zone] || '警戒区域'}（${SLIDE_KINDS[h.kind] || ''}）`).join('・')
    : L.status === 'outside' ? '区域外' : '区域なし'));
  if (F) s.push('洪水: ' + (F.status === 'inside' ? `区域内（浸水深 ${FLOOD_RANKS[F.rank] || ''}）`
    : F.status === 'outside' ? '区域外' : F.status === 'notcovered' ? 'データ対象外' : '区域なし'));
  if (T) s.push('津波: ' + (T.status === 'inside' ? `区域内（${T.dists.join('・')}）`
    : T.status === 'outside' ? '区域外' : '区域なし'));
  return s;
}
function myPointPopup(pt) {
  let h = `<h4>${esc(pt.name)}</h4>`;
  h += `<div class="muted">${pt.muni ? esc(pt.muni.pref) + ' ' + esc(pt.muni.name) : '市町村を特定できませんでした'} / 判定: ${esc((pt.judgedAt || '').slice(0, 10))}</div>`;
  for (const line of hazardSummary(pt)) h += `<div>${esc(line)}</div>`;
  if (pt.landslide && pt.landslide.status === 'inside') {
    for (const hit of pt.landslide.hits) {
      if (hit.name) h += `<div class="muted">区域名: ${esc(hit.name)}${hit.loc ? '（' + esc(hit.loc) + '）' : ''}</div>`;
    }
  }
  h += `<div class="muted">国土数値情報の区域データによる目安です（精度1/25,000）。</div>`;
  h += `<div class="mp-actions"><button type="button" onclick="mpRejudge('${pt.id}')">再判定</button> <button type="button" onclick="mpDelete('${pt.id}')">削除</button></div>`;
  return h;
}
function drawMyPoints() {
  if (!state.map || !state.myLayer) return;
  state.myLayer.clearLayers();
  for (const pt of myPoints) {
    const icon = L.divIcon({ className: '', html: '<div class="mypoint-pin">⌂</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
    pt._marker = L.marker([pt.lat, pt.lon], { icon }).addTo(state.myLayer).bindPopup(myPointPopup(pt));
  }
  const list = document.getElementById('myPointsList');
  if (!list) return;
  if (!myPoints.length) { list.innerHTML = '<p class="muted">まだ登録がありません</p>'; return; }
  list.innerHTML = myPoints.map(pt =>
    `<div class="mp-row" onclick="mpFocus('${pt.id}')"><b>${esc(pt.name)}</b> <span class="muted">${pt.muni ? esc(pt.muni.name) : ''}</span><br><span class="mp-sum">${hazardSummary(pt).map(esc).join(' / ')}</span></div>`
  ).join('');
}
function mpFocus(id) {
  const pt = myPoints.find(p => p.id === id);
  if (!pt || !state.map) return;
  state.map.setView([pt.lat, pt.lon], Math.max(state.map.getZoom(), 14));
  if (pt._marker) pt._marker.openPopup();
}
function onMapContextMenu(e) {
  mpPending = e.latlng;
  const html = `<div class="mp-form"><b>地点を登録</b><br>` +
    `<input id="mpName" type="text" placeholder="名前（自宅・仕事場など）" maxlength="30">` +
    `<button type="button" onclick="mpRegister()">登録して判定</button>` +
    `<div class="muted">登録した時だけ判定します。保存はこの端末の中だけです。</div></div>`;
  L.popup().setLatLng(e.latlng).setContent(html).openOn(state.map);
  setTimeout(() => { const i = document.getElementById('mpName'); if (i) i.focus(); }, 100);
}
async function mpRegister() {
  if (!mpPending) return;
  const input = document.getElementById('mpName');
  const name = (input && input.value.trim()) || '地点';
  const { lat, lng } = mpPending;
  state.map.closePopup();
  const judged = await judgePoint(lat, lng);
  const pt = { id: 'mp' + Date.now().toString(36), name, lat, lon: lng, ...judged };
  myPoints.push(pt);
  saveMyPoints();
  drawMyPoints();
  mpFocus(pt.id);
}
async function mpRejudge(id) {
  const pt = myPoints.find(p => p.id === id);
  if (!pt) return;
  const judged = await judgePoint(pt.lat, pt.lon);
  Object.assign(pt, judged);
  saveMyPoints();
  drawMyPoints();
  mpFocus(id);
}
function mpDelete(id) {
  myPoints = myPoints.filter(p => p.id !== id);
  saveMyPoints();
  drawMyPoints();
  if (state.map) state.map.closePopup();
}
