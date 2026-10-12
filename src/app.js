/* 山座同定カメラ — 画面とデータ取得 */
(function () {
'use strict';
const C = window.Core;
const D2R = C.D2R, R2D = C.R2D;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = d => d >= 10000 ? (d / 1000).toFixed(1) + ' km' : d >= 1000 ? (d / 1000).toFixed(2) + ' km' : Math.round(d) + ' m';
const fmtDeg = (v, p = 1) => (v >= 0 ? '' : '−') + Math.abs(v).toFixed(p) + '°';
const fmtSigned = (v, p = 1) => (v >= -0.5 * 10 ** -p ? '+' : '−') + Math.abs(v).toFixed(p) + '°';
const dirName = az => ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'][Math.round(az / 22.5) % 16];
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

/* ---------- 設定 ---------- */
const DEFAULTS = { eye: 1.6, maxDist: 120000, liveFov: 64, showHidden: false };
const settings = Object.assign({}, DEFAULTS);
try { Object.assign(settings, JSON.parse(localStorage.getItem('yamaSettings') || '{}')); } catch (e) { /* 保存なしでも動く */ }
const saveSettings = () => { try { localStorage.setItem('yamaSettings', JSON.stringify(settings)); } catch (e) { } };

/* ---------- 状態 ---------- */
const S = {
  mode: 'home',            // home | live | still
  pos: null,               // {lat, lon, acc, src}
  data: null,              // {lat, lon, maxDist, eye}  読み込み済みデータの条件
  loadToken: 0,
  dem: null, demSource: null,
  peaks: [], peaksError: null,
  obs: null, ground: null,
  pano: null, analyzed: [], ready: false, progress: '',
  sensor: { ok: false, hx: 0, hy: 0, heading: null, src: '', pitch: 0, roll: 0, acc: null, decl: null },
  liveOffset: { yaw: 0, pitch: 0 },
  still: null,
  tap: null, selected: null,
  stream: null, geoWatch: null,
  toastTimer: 0,
};
const video = $('#video'), stillCv = $('#still'), overlay = $('#overlay');
const octx = overlay.getContext('2d');

/* ---------- データ源 ---------- */
const DEM_SOURCES = {
  gsi: { name: '国土地理院 標高タイル', url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`, decode: C.decodeGSI,
    credit: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院 標高タイル</a>' },
  terrarium: { name: 'Terrarium標高タイル(AWS Open Data)', url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, decode: C.decodeTerrarium,
    credit: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (AWS Open Data)</a>' },
};
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const TIERS = maxDist => [{ z: 14, maxDist: 3000 }, { z: 12, maxDist: 25000 }, { z: 10, maxDist: maxDist }];

let decodeCanvas = null;
function decodeCtx() {
  if (!decodeCanvas) {
    decodeCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  }
  return decodeCanvas.getContext('2d', { willReadFrequently: true });
}
async function fetchTile(src, z, x, y) {
  const res = await fetch(src.url(z, x, y), { mode: 'cors' });
  if (res.status === 404) return null;                // 海域・範囲外
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { http: res.status });
  const blob = await res.blob();
  let bmp;
  try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
  catch (e) { bmp = await createImageBitmap(blob); }
  const ctx = decodeCtx();
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return src.decode(ctx.getImageData(0, 0, 256, 256).data);
}
async function loadDEM(dem, lat, lon, maxDist, onProgress, token) {
  const jobs = [];
  for (const t of dem.tiers) for (const tile of C.tilesForRadius(lat, lon, t.maxDist, t.z)) if (!dem.hasTile(tile.z, tile.x, tile.y)) jobs.push(tile);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      if (token !== S.loadToken) return;
      const t = jobs[i++];
      let arr;
      try { arr = await fetchTile(S.demSource, t.z, t.x, t.y); }
      catch (e) {
        // 国土地理院から取れない(通信制限など)場合は Terrarium に切り替える
        if (S.demSource === DEM_SOURCES.gsi && !e.http) {
          S.demSource = DEM_SOURCES.terrarium;
          try { arr = await fetchTile(S.demSource, t.z, t.x, t.y); } catch (e2) { failed++; }
        } else failed++;
      }
      if (arr !== undefined) dem.setTile(t.z, t.x, t.y, arr);
      done++; onProgress(done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { total: jobs.length, failed };
}
async function fetchPeaks(lat, lon, radius) {
  const key = `yamaPeaks:${lat.toFixed(2)},${lon.toFixed(2)},${radius}`;
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && Date.now() - c.t < 30 * 864e5) return c.peaks;
  } catch (e) { }
  const N = C.destination(lat, lon, 0, radius), Sth = C.destination(lat, lon, 180, radius);
  const E = C.destination(lat, lon, 90, radius), W = C.destination(lat, lon, 270, radius);
  const q = `[out:json][timeout:60];node["natural"~"^(peak|volcano)$"]["name"](${Sth.lat.toFixed(4)},${W.lon.toFixed(4)},${N.lat.toFixed(4)},${E.lon.toFixed(4)});out body;`;
  let lastErr = null;
  for (const ep of OVERPASS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const js = await res.json();
      const peaks = [];
      for (const el of js.elements || []) {
        const t = el.tags || {};
        const name = t['name:ja'] || t.name;
        if (!name) continue;
        const ele = parseFloat(String(t.ele || '').replace(/,/g, ''));
        peaks.push({ id: el.id, lat: el.lat, lon: el.lon, name, kana: t['name:ja-Hira'] || t['name:ja_kana'] || t['name:ja-Kana'] || '', ele: ele > -100 && ele < 9000 ? ele : null, volcano: t.natural === 'volcano' });
      }
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), peaks })); } catch (e) { }
      return peaks;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('取得失敗');
}

/* ---------- データ準備(地形→稜線→各山頂の見通し) ---------- */
function needsReload(pos) {
  const d = S.data;
  if (!d) return true;
  if (d.maxDist !== settings.maxDist || d.eye !== settings.eye) return true;
  return C.distBearing(d.lat, d.lon, pos.lat, pos.lon).d > 400;
}
async function prepare(pos) {
  if (!needsReload(pos)) return;
  const token = ++S.loadToken;
  S.ready = false; S.pano = null; S.analyzed = []; S.peaksError = null;
  S.data = { lat: pos.lat, lon: pos.lon, maxDist: settings.maxDist, eye: settings.eye };
  if (!S.dem || S.dem.tiers[2].maxDist !== settings.maxDist) S.dem = new C.DEM(TIERS(settings.maxDist));
  if (!S.demSource) S.demSource = DEM_SOURCES.gsi;
  const dem = S.dem;
  let demP = 0;
  const setP = () => { S.progress = `地形データ ${Math.round(demP * 100)}%`; renderChips(); };
  setP();
  const peaksP = fetchPeaks(pos.lat, pos.lon, settings.maxDist).then(p => p, e => { S.peaksError = e; return []; });
  const r = await loadDEM(dem, pos.lat, pos.lon, settings.maxDist, (d, t) => { demP = d / t; if (token === S.loadToken) setP(); }, token);
  if (token !== S.loadToken) return;
  S.demStats = r;
  if (r.failed) toast(`標高データの一部(${r.failed}/${r.total}枚)を取得できませんでした。その方向の山は「判定できない」として表示から外します。`, 6000);
  if (r.total && r.failed === r.total) { S.progress = '地形データを取得できません'; renderChips(); toast('標高データを取得できませんでした。電波の状況を確認して、もう一度開いてください。', 6000); return; }
  const ground = dem.sampleFinest(pos.lat, pos.lon);
  S.ground = ground === ground ? ground : 0;
  S.obs = { lat: pos.lat, lon: pos.lon, h: S.ground + settings.eye };
  const pano = C.createPanorama(dem, S.obs, settings.maxDist, 0.1);
  S.pano = pano;
  const CH = 90;
  for (let i = 0; i < pano.n; i += CH) {
    C.computePanoramaRange(dem, pano, i, i + CH);
    S.progress = `稜線を計算 ${Math.round(pano.done / pano.n * 100)}%`; renderChips();
    if (S.mode === 'still' && (i / CH) % 8 === 0) drawOverlay();
    await nextFrame();
    if (token !== S.loadToken) return;
  }
  C.indexRidges(pano);
  S.progress = '山名データを取得中'; renderChips();
  const peaks = await peaksP;
  if (token !== S.loadToken) return;
  S.peaks = peaks;
  const out = [];
  for (let i = 0; i < peaks.length; i += 120) {
    for (let k = i; k < Math.min(peaks.length, i + 120); k++) {
      const a = C.analyzePeak(dem, S.obs, pano.ctx, peaks[k]);
      if (a && a.d <= settings.maxDist) out.push(a);
    }
    S.progress = `見通しを計算 ${Math.round(Math.min(1, (i + 120) / peaks.length) * 100)}%`; renderChips();
    await nextFrame();
    if (token !== S.loadToken) return;
  }
  for (const a of out) {
    // 標高が不明・0m以下の山頂は判定に使わない
    a.valid = a.ele >= 1 && a.status !== 'unknown';
    a.outline = a.status === 'visible' ? C.onOutline(pano, a) : null;
    // 画面に山名を出すのは、見えていて、空との境目か尾根の輪郭の上にある山頂だけ
    a.label = a.valid && a.status === 'visible' && !!a.outline;
    a.prio = (a.outline === 'sky' ? 20000 : a.outline === 'ridge' ? 10000 : 0) + a.ele - a.d * 0.004;
  }
  out.sort((a, b) => b.prio - a.prio);
  S.analyzed = out;
  S.cands = out.filter(a => a.valid);
  S.ready = true;
  S.progress = '';
  renderChips();
  if (S.peaksError) toast('山名データを取得できませんでした。稜線の表示と地形の判定のみ行います。', 6000);
  onDataReady();
}
/* 位置が決まったら、データが使い回せればそのまま照合、そうでなければ読み込む */
function usePosition(pos) {
  S.pos = pos;
  if (!needsReload(pos) && S.ready) {
    if (S.mode === 'still' && S.still && !S.still.alignTried) autoAlignStill(true);
    drawOverlay(); renderChips();
  } else prepare(pos);
}
function onDataReady() {
  const st = S.still;
  if (S.mode === 'still') drawOverlay();
  if (S.mode === 'still' && st && !st.alignTried) autoAlignStill(true);
  else if (S.mode === 'still' && S.tap) showResult();
}

/* ---------- 位置情報 ---------- */
function startGeo() {
  if (!navigator.geolocation || S.geoWatch != null) return;
  S.geoWatch = navigator.geolocation.watchPosition(p => {
    const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, src: 'gps' };
    if (S.mode === 'live' || (S.mode === 'still' && S.still && S.still.src === 'live' && !S.pos)) {
      S.pos = pos;
      if (S.sensor.decl == null) S.sensor.decl = C.declinationJP(pos.lat, pos.lon);
      if (pos.acc < 300) prepare(pos);
    }
    S.lastGps = pos;
    renderChips();
  }, err => {
    toast(err.code === 1 ? '位置情報の利用が許可されていません。iPhoneの「設定 > プライバシー > 位置情報サービス > Safari」で許可してください。' : '位置情報を取得できません。屋外で少し待つか、写真から調べてください。', 7000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopGeo() { if (S.geoWatch != null) { navigator.geolocation.clearWatch(S.geoWatch); S.geoWatch = null; } }

/* ---------- 方位・傾きセンサー ---------- */
function onOrientation(e) {
  if (e.beta == null) return;
  const t = C.cameraTiltFromOrientation(e.beta, e.gamma || 0);
  const screenAngle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  let heading = null, src = '';
  const decl = S.sensor.decl != null ? S.sensor.decl : (S.pos ? C.declinationJP(S.pos.lat, S.pos.lon) : 7.5);
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    heading = e.webkitCompassHeading - decl; src = 'iPhoneのコンパス';
    S.sensor.acc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
  } else if (e.absolute && e.alpha != null) {
    const a = e.alpha * D2R, b = e.beta * D2R, g = (e.gamma || 0) * D2R;
    const cE = -Math.sin(g) * Math.cos(a) - Math.sin(b) * Math.cos(g) * Math.sin(a);
    const cN = -Math.sin(g) * Math.sin(a) + Math.sin(b) * Math.cos(g) * Math.cos(a);
    heading = Math.atan2(cE, cN) * R2D - decl; src = '端末のコンパス';
  }
  const k = 0.25;
  if (heading != null) {
    const hx = Math.sin(heading * D2R), hy = Math.cos(heading * D2R);
    if (!S.sensor.ok) { S.sensor.hx = hx; S.sensor.hy = hy; }
    S.sensor.hx += (hx - S.sensor.hx) * k; S.sensor.hy += (hy - S.sensor.hy) * k;
    S.sensor.heading = C.normAz(Math.atan2(S.sensor.hx, S.sensor.hy) * R2D);
    S.sensor.src = src;
  }
  const roll = t.roll - screenAngle;
  if (!S.sensor.ok) { S.sensor.pitch = t.pitch; S.sensor.roll = roll; }
  S.sensor.pitch += (t.pitch - S.sensor.pitch) * k;
  S.sensor.roll += (C.angDiff(roll, S.sensor.roll)) * k;
  S.sensor.ok = true;
}

/* ---------- 画面切り替え ---------- */
function show(mode) {
  S.mode = mode;
  $('#toast').hidden = true;
  $('#home').hidden = mode !== 'home';
  $('#stage').hidden = mode === 'home';
  video.hidden = mode !== 'live';
  stillCv.hidden = mode !== 'still';
  $('#btnShutter').hidden = mode !== 'live';
  $('#btnAlign').hidden = mode !== 'still';
  $('#btnReset').hidden = mode !== 'still';
  $('#btnPhoto2').hidden = mode !== 'live';
  $('#hint').textContent = mode === 'live' ? '山をタップするか、シャッターを押すと判定します' :
    mode === 'still' ? '山をタップすると名前と根拠を表示。稜線がずれていたら指でずらして合わせる' : '';
  if (mode !== 'still') closeSheet();
  resizeOverlay();
  renderChips();
  updateZoomUi();
}
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
}
function busy(text) { $('#busy').hidden = !text; if (text) $('#busyText').textContent = text; }

/* ---------- ライブ ---------- */
async function startLive() {
  // iPhoneでは、許可ダイアログはボタン操作の直後に呼ぶ必要がある
  let orientP = Promise.resolve('granted');
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    orientP = DeviceOrientationEvent.requestPermission().catch(() => 'denied');
  }
  let camP = null;
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    camP = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
  }
  startGeo();
  S.still = null; S.tap = null;
  show('live');
  const orient = await orientP;
  if (orient !== 'granted') toast('方位センサーの利用が許可されませんでした。Safariを再読み込みして「許可」を選んでください。写真で合わせることはできます。', 7000);
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('deviceorientationabsolute', onOrientation);
  if (!camP) { toast('このブラウザではカメラを使えません。写真から調べてください。', 6000); return; }
  try {
    S.stream = await camP;
    video.srcObject = S.stream;
    await video.play().catch(() => { });
  } catch (e) {
    toast('カメラを起動できませんでした。カメラの利用を許可するか、写真から調べてください。', 7000);
  }
  if (S.lastGps && S.lastGps.acc < 300) { S.pos = S.lastGps; prepare(S.pos); }
  loop();
}
function stopLive() {
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
  video.srcObject = null;
  window.removeEventListener('deviceorientation', onOrientation);
  window.removeEventListener('deviceorientationabsolute', onOrientation);
}
function liveCamera() {
  const iw = video.videoWidth, ih = video.videoHeight;
  if (!iw || !ih) return null;
  const F = (Math.max(iw, ih) / 2) / Math.tan(settings.liveFov * D2R / 2);
  const yaw = (S.sensor.heading != null ? S.sensor.heading : 0) + S.liveOffset.yaw;
  return { iw, ih, cam: C.makeCamera({ yaw, pitch: S.sensor.pitch + S.liveOffset.pitch, roll: S.sensor.roll, F, cx: iw / 2, cy: ih / 2 }) };
}
function freeze() {
  const lc = liveCamera();
  if (!lc) { toast('カメラの映像がまだありません。'); return false; }
  stillCv.width = lc.iw; stillCv.height = lc.ih;
  stillCv.getContext('2d').drawImage(video, 0, 0, lc.iw, lc.ih);
  const o = lc.cam.o;
  S.still = {
    src: 'live', iw: lc.iw, ih: lc.ih, F: o.F, F0: o.F, yaw0: o.yaw, pitch0: o.pitch, roll: o.roll,
    adj: { yaw: 0, pitch: 0 }, yawKnown: S.sensor.heading != null, pitchKnown: S.sensor.ok,
    yawSrc: S.sensor.heading != null ? `${S.sensor.src}(磁北→真北 ${fmtDeg(S.sensor.decl || 0)} 補正)` : 'なし',
    liveOffset: { ...S.liveOffset }, compassAcc: S.sensor.acc, manual: false, align: null, alignTried: false,
  };
  if (S.stream) S.stream.getVideoTracks().forEach(t => { t.enabled = false; });
  // ライブで見ていた範囲(切り取り+拡大)のまま静止画にする
  const zc = baseTransform(lc.iw, lc.ih, true).s / baseTransform(lc.iw, lc.ih, false).s * (S.liveZoom || 1);
  S.stillView = { z: Math.min(MAX_ZOOM_STILL, zc), cx: lc.iw / 2, cy: lc.ih / 2 };
  clampStillView();
  show('still');
  if (S.ready) autoAlignStill(true);
  return true;
}
function backToLive() {
  if (S.stream) S.stream.getVideoTracks().forEach(t => { t.enabled = true; });
  S.still = null; S.tap = null; S.stillView = null;
  show('live');
}

/* ---------- 写真 ---------- */
async function loadPhoto(file) {
  busy('写真を読み込み中');
  try {
    const buf = await file.arrayBuffer();
    let exif = null;
    try { exif = C.parseExif(buf); } catch (e) { exif = null; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) {
      busy(null);
      toast('この写真は読み込めませんでした(HEIC形式はPCのブラウザでは開けないことがあります)。JPEGで試してください。', 7000);
      return;
    }
    const iw = img.naturalWidth, ih = img.naturalHeight;
    stillCv.width = iw; stillCv.height = ih;
    stillCv.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    stopLive(); stopGeo();
    let F, fSrc;
    if (exif && exif.f35) { F = C.focalPxFrom35mm(exif.f35, iw, ih); fSrc = `写真の情報(35mm換算 ${exif.f35}mm)`; }
    else { F = C.focalPxFrom35mm(26, iw, ih); fSrc = '不明のため iPhone標準カメラ相当(35mm換算 26mm)と仮定'; }
    const decl = exif && exif.lat != null ? C.declinationJP(exif.lat, exif.lon) : 7.5;
    let yaw0 = 0, yawKnown = false, yawSrc = '写真に方位の記録なし(全方位から探索)';
    if (exif && exif.dir != null) {
      yawKnown = true;
      yaw0 = exif.dirRef === 'M' ? exif.dir - decl : exif.dir;
      yawSrc = exif.dirRef === 'M' ? `写真の記録(磁北基準 → 真北へ ${fmtDeg(decl)} 補正)` : '写真の記録(真北基準)';
    }
    S.still = {
      src: 'photo', iw, ih, F, F0: F, fSrc, yaw0, pitch0: 0, roll: 0, adj: { yaw: 0, pitch: 0 }, yawKnown, pitchKnown: false, yawSrc,
      exif, manual: false, align: null, alignTried: false, name: file.name,
    };
    S.tap = null; S.stillView = null;
    show('still');
    busy(null);
    if (exif && exif.lat != null) {
      usePosition({ lat: exif.lat, lon: exif.lon, acc: exif.hErr || null, src: 'exif' });
    } else {
      askLocation();
    }
  } catch (e) {
    busy(null);
    toast('写真の読み込みに失敗しました: ' + e.message, 6000);
  }
}
function askLocation() {
  openSheet(`
    <h2>撮影した場所を指定</h2>
    <p class="sub">この写真には位置情報が入っていません。iPhoneの写真を選ぶと位置情報が外されることがあります。今いる場所で撮った写真なら「現在地を使う」を押してください。</p>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="useHere" type="button">現在地を使う</button></div>
    <label class="field">緯度, 経度
      <input type="text" id="latlon" inputmode="decimal" placeholder="例: 36.6513, 138.1810" autocomplete="off">
      <small>地図アプリで撮影地点を長押しすると表示される数字を貼り付けられます。</small>
    </label>
    <div class="row"><button class="btn" id="useLatLon" type="button">この位置で計算</button></div>`);
  $('#useHere').onclick = () => {
    if (!navigator.geolocation) { toast('位置情報を使えません。'); return; }
    busy('現在地を取得中');
    navigator.geolocation.getCurrentPosition(p => {
      busy(null); closeSheet();
      usePosition({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, src: 'gps' });
    }, () => { busy(null); toast('現在地を取得できませんでした。緯度・経度を入力してください。', 5000); }, { enableHighAccuracy: true, timeout: 20000 });
  };
  $('#useLatLon').onclick = () => {
    const m = $('#latlon').value.match(/(-?\d+(?:\.\d+)?)\s*[,、\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { toast('「36.65, 138.18」の形で入力してください。'); return; }
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('緯度・経度の範囲を確認してください。'); return; }
    closeSheet();
    usePosition({ lat, lon, acc: null, src: 'manual' });
  };
}

/* ---------- 写真・静止画のカメラ ---------- */
function stillCamera() {
  const st = S.still;
  return C.makeCamera({ yaw: st.yaw0 + st.adj.yaw, pitch: st.pitch0 + st.adj.pitch, roll: st.roll, F: st.F, cx: st.iw / 2, cy: st.ih / 2 });
}
/* 拡大していないときの配置。cover=ライブ(画面いっぱいに切り取り)、それ以外=写真(全体を収める) */
function baseTransform(iw, ih, cover) {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  const s = cover ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
  // 根拠シートを開いているときは、写真をシートに隠れない側へ寄せる
  if (!cover && S.sheetOpen && W >= 760) {
    const aw = W - 472, s2 = Math.min(aw / iw, H / ih);
    return { s: s2, ox: (aw - iw * s2) / 2, oy: (H - ih * s2) / 2, W, H };
  }
  let oy = (H - ih * s) / 2;
  if (!cover && S.sheetOpen) oy = Math.min(oy, 88);
  return { s, ox: (W - iw * s) / 2, oy, W, H };
}
/* 拡大を含めた配置。画像・稜線・山名・タップ位置はすべてこの変換で画面に置くので、拡大してもずれない */
const MAX_ZOOM_STILL = 8, MAX_ZOOM_LIVE = 5;
function viewTransform(iw, ih, cover) {
  const b = baseTransform(iw, ih, cover);
  const Sx = b.ox + iw / 2 * b.s, Sy = b.oy + ih / 2 * b.s;     // 拡大の基準点(画像中心の画面位置)
  if (cover) {
    const z = S.liveZoom || 1;
    if (z <= 1.0001) return Object.assign(b, { z: 1 });
    const s = b.s * z;
    return { s, ox: Sx - iw / 2 * s, oy: Sy - ih / 2 * s, W: b.W, H: b.H, z };
  }
  const v = S.stillView;
  if (!v || v.z <= 1.0001) return Object.assign(b, { z: 1 });
  const s = b.s * v.z;
  return { s, ox: Sx - v.cx * s, oy: Sy - v.cy * s, W: b.W, H: b.H, z: v.z };
}
/* 拡大中に画像の外側へ動かしすぎないように制限する(画面の中央は常に画像の内側) */
function clampStillView() {
  const v = S.stillView, st = S.still;
  if (!v || !st) return;
  v.cx = Math.min(st.iw, Math.max(0, v.cx));
  v.cy = Math.min(st.ih, Math.max(0, v.cy));
}
function applyLiveZoom() {
  const z = S.liveZoom || 1;
  video.style.transform = z > 1.0001 ? `scale(${z})` : '';
  updateZoomUi();
}
function updateZoomUi() {
  const z = S.mode === 'live' ? (S.liveZoom || 1) : S.mode === 'still' && S.stillView ? S.stillView.z : 1;
  const b = $('#btnZoom');
  b.hidden = !(z > 1.05) || S.mode === 'home';
  b.textContent = `×${z.toFixed(1)} 等倍に戻す`;
  const h = $('#hint');
  if (S.mode === 'still') h.textContent = z > 1.05 ? '拡大中: 1本指で移動、2本指で拡大・縮小、山をタップで判定' : '山をタップすると名前と根拠を表示。2本指で拡大。稜線がずれていたら1本指でずらして合わせる';
  else if (S.mode === 'live') h.textContent = '山をタップするか、シャッターを押すと判定します。2本指で拡大';
}
function drawStill() {
  // 画面いっぱいに収める(切り取らない)
  const st = S.still;
  const T = viewTransform(st.iw, st.ih, false);
  stillCv.style.cssText = `position:absolute;left:${T.ox}px;top:${T.oy}px;width:${st.iw * T.s}px;height:${st.ih * T.s}px`;
  return T;
}

/* ---------- 自動合わせ ---------- */
async function autoAlignStill(silent) {
  const st = S.still;
  if (!st) return;
  if (!S.ready) { if (!silent) toast('地形データの準備中です。完了すると自動で合わせます。'); return; }
  st.alignTried = true;
  busy(st.yawKnown ? '写真と稜線を照合中' : '写真と稜線を全方位で照合中');
  await nextFrame(); await nextFrame();
  const k = Math.min(1, 640 / Math.max(st.iw, st.ih));
  const w = Math.round(st.iw * k), h = Math.round(st.ih * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(stillCv, 0, 0, w, h);
  const field = C.buildEdgeField(cx.getImageData(0, 0, w, h).data, w, h);
  const base = { yaw: st.yaw0 + st.adj.yaw, pitch: st.pitch0 + st.adj.pitch, roll: st.roll, F: st.F * k };
  const ranges = st.yawKnown ? { yaw: 20, pitch: st.pitchKnown ? 5 : 8 } : { yaw: 180, pitch: 8 };
  const res = C.autoAlign(S.pano, field, base, ranges);
  busy(null);
  const good = res && res.cover >= 0.45 && res.distinct >= 1.25;
  st.align = res ? Object.assign({}, res, { applied: good, at: Date.now() }) : { applied: false, failed: true };
  if (good) {
    st.adj.yaw += res.dyaw; st.adj.pitch += res.dpitch;
    // ライブ画面にも補正を引き継ぐ
    if (st.src === 'live') { S.liveOffset.yaw = st.liveOffset.yaw + st.adj.yaw; S.liveOffset.pitch = st.liveOffset.pitch + st.adj.pitch; }
    toast(`稜線を写真に合わせました(方位 ${fmtSigned(res.dyaw)}、上下 ${fmtSigned(res.dpitch)}、一致 ${Math.round(res.cover * 100)}%)`, 3500);
  } else {
    toast('写真の稜線をはっきり読み取れず、自動では合わせられませんでした。白い稜線を指でずらして、写真の山の形に重ねてください。', 7000);
  }
  renderChips();
  drawOverlay();
  if (S.tap) showResult();
}

/* ---------- 誤差の見積もり ---------- */
function uncertainty() {
  const st = S.still;
  let az, el, why;
  if (st && st.align && st.align.applied && !st.manualAfterAlign) { az = st.align.cover > 0.7 ? 0.25 : 0.4; el = az; why = `写真の稜線と自動で照合済み(一致 ${Math.round(st.align.cover * 100)}%)`; }
  else if (st && st.manual) { az = 0.4; el = 0.4; why = '稜線を手動で写真に合わせ済み'; }
  else if (st && st.src === 'live') { az = 6; el = st.pitchKnown ? 2 : 6; why = '方位センサーの値のみ(誤差が数度ある)'; }
  else if (st && st.yawKnown) { az = 5; el = 6; why = '写真に記録された方位のみ(誤差が数度ある)'; }
  else { az = 30; el = 8; why = '方位が不明'; }
  return { az, el, why, aligned: az < 1 };
}

/* ---------- 重ね表示 ---------- */
function resizeOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = overlay.clientWidth, h = overlay.clientHeight;
  if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) { overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.mode === 'still' && S.still) { drawStill(); drawOverlay(); }
}
function distColor(d, a) {
  // 近い尾根は暖色、遠い尾根ほど青白く(空気遠近法)
  const t = Math.max(0, Math.min(1, Math.log(Math.max(d, 500) / 500) / Math.log(240)));
  const r = Math.round(240 + (170 - 240) * t), g = Math.round(163 + (196 - 163) * t), b = Math.round(94 + (235 - 94) * t);
  return `rgba(${r},${g},${b},${a})`;
}
let lastDraw = null;
const MAX_LABELS = 8;     // 1画面に出す山名の上限
function drawOverlay() {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  octx.clearRect(0, 0, W, H);
  let cam, T;
  if (S.mode === 'live') {
    const lc = liveCamera();
    if (!lc) return;
    cam = lc.cam; T = viewTransform(lc.iw, lc.ih, true);
  } else if (S.mode === 'still' && S.still) {
    cam = stillCamera(); T = viewTransform(S.still.iw, S.still.ih, false);
  } else return;
  lastDraw = { cam, T };
  const pano = S.pano;
  if (!pano) return;
  octx.save();
  if (S.mode === 'still') { octx.beginPath(); octx.rect(T.ox, 0, S.still.iw * T.s, H); octx.clip(); }
  drawOverlayInner(cam, T, W, H, pano);
  octx.restore();
}
function drawOverlayInner(cam, T, W, H, pano) {
  const toScr = p => ({ x: T.ox + p.x * T.s, y: T.oy + p.y * T.s });
  // 画面に入る方位の範囲
  const left = cam.unproject((0 - T.ox) / T.s, (H / 2 - T.oy) / T.s).az;
  const right = cam.unproject((W - T.ox) / T.s, (H / 2 - T.oy) / T.s).az;
  let span = C.angDiff(right, left); if (span <= 0) span += 360;
  const i0 = Math.floor(C.normAz(left - 2) / pano.azStep), cnt = Math.ceil((span + 4) / pano.azStep);
  // 重なる尾根の輪郭
  const R = pano.ridges;
  if (R) {
    octx.lineWidth = 1.2;
    for (let c = 0; c < cnt; c++) {
      const i = (i0 + c) % pano.n, j = (i + 1) % pano.n;
      if (i >= pano.done) continue;
      for (let k = R.start[i]; k < R.start[i + 1]; k++) {
        const p = cam.project(i * pano.azStep, R.el[k]); if (!p) continue;
        const a = toScr(p);
        let best = -1, bd = 1e9;
        for (let m = R.start[j]; m < R.start[j + 1]; m++) {
          const rr = R.d[m] / R.d[k];
          if (rr < 0.88 || rr > 1.14) continue;
          const de = Math.abs(R.el[m] - R.el[k]);
          if (de < 0.3 * D2R && de < bd) { bd = de; best = m; }
        }
        octx.strokeStyle = distColor(R.d[k], 0.55);
        if (best >= 0) {
          const q = cam.project(j * pano.azStep, R.el[best]); if (!q) continue;
          const b = toScr(q);
          octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
        } else { octx.fillStyle = distColor(R.d[k], 0.4); octx.fillRect(a.x - 0.6, a.y - 0.6, 1.2, 1.2); }
      }
    }
  }
  // 稜線(空との境目)
  octx.lineJoin = 'round';
  for (const pass of [{ w: 4, c: 'rgba(0,0,0,.45)' }, { w: 1.8, c: 'rgba(238,242,244,.95)' }]) {
    octx.beginPath(); let pen = false;
    for (let c = 0; c < cnt; c++) {
      const i = (i0 + c) % pano.n;
      const el = pano.sky[i];
      if (el !== el || i >= pano.done) { pen = false; continue; }
      const p = cam.project(i * pano.azStep, el);
      if (!p) { pen = false; continue; }
      const s = toScr(p);
      if (pen) octx.lineTo(s.x, s.y); else { octx.moveTo(s.x, s.y); pen = true; }
    }
    octx.lineWidth = pass.w; octx.strokeStyle = pass.c; octx.stroke();
  }
  // 山名
  const boxes = [];
  const labels = [];
  let shown = 0;
  for (const a of S.analyzed) {
    if (!(a.label || (settings.showHidden && a.valid))) continue;
    if (Math.abs(C.angDiff(a.az, left + span / 2)) > span / 2 + 1) continue;
    const p = cam.project(a.az, a.el); if (!p) continue;
    const s = toScr(p);
    if (s.x < -20 || s.x > W + 20 || s.y < -40 || s.y > H + 20) continue;
    labels.push({ a, s });
  }
  octx.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
  octx.textBaseline = 'alphabetic';
  const topLimit = 64;
  for (const L of labels) {
    const { a, s } = L;
    const text = a.peak.name + (a.status === 'marginal' ? '?' : '');
    const sub = Math.round(a.ele) + 'm';
    const tw = Math.max(octx.measureText(text).width, 40) + 10;
    let placed = null;
    if (shown < MAX_LABELS) {
      for (let row = 0; row < 6; row++) {
        const by = Math.max(topLimit, s.y - 30 - row * 34);
        const box = { x: s.x - tw / 2, y: by - 30, w: tw, h: 30 };
        if (!boxes.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) { placed = box; break; }
      }
    }
    const isSel = S.selected && S.selected.peak === a.peak;
    if (!placed && !isSel && a.label) continue;   // 山名を置けない山は点も出さない
    const col = a.status === 'hidden' ? 'rgba(239,138,128,.85)' : a.status === 'marginal' ? 'rgba(233,196,106,.95)' : isSel ? '#f0a35e' : '#eef2f4';
    octx.fillStyle = col;
    octx.beginPath(); octx.arc(s.x, s.y, isSel ? 4 : 2.6, 0, Math.PI * 2); octx.fill();
    if (!placed) continue;
    boxes.push(placed); shown++;
    octx.strokeStyle = col; octx.lineWidth = 1;
    if (a.status !== 'visible') octx.setLineDash([3, 3]);
    octx.beginPath(); octx.moveTo(s.x, s.y - 4); octx.lineTo(s.x, placed.y + placed.h); octx.stroke();
    octx.setLineDash([]);
    octx.fillStyle = isSel ? 'rgba(240,163,94,.92)' : 'rgba(13,16,20,.72)';
    roundRect(placed.x, placed.y, placed.w, placed.h, 6); octx.fill();
    octx.fillStyle = isSel ? '#1a120b' : col;
    octx.textAlign = 'center';
    octx.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
    octx.fillText(text, s.x, placed.y + 14);
    octx.font = '11px ui-monospace, Menlo, monospace';
    octx.fillStyle = isSel ? '#4a3220' : 'rgba(154,167,178,1)';
    octx.fillText(sub, s.x, placed.y + 26);
    octx.textAlign = 'start';
  }
  // タップ位置
  if (S.tap && S.mode === 'still') {
    {
      const s = toScr({ x: S.tap.ix, y: S.tap.iy });
      octx.strokeStyle = '#f0a35e'; octx.lineWidth = 2;
      octx.beginPath(); octx.arc(s.x, s.y, 14, 0, Math.PI * 2); octx.stroke();
      octx.beginPath(); octx.moveTo(s.x - 22, s.y); octx.lineTo(s.x - 8, s.y); octx.moveTo(s.x + 8, s.y); octx.lineTo(s.x + 22, s.y);
      octx.moveTo(s.x, s.y - 22); octx.lineTo(s.x, s.y - 8); octx.moveTo(s.x, s.y + 8); octx.lineTo(s.x, s.y + 22); octx.stroke();
    }
  }
}
function roundRect(x, y, w, h, r) {
  octx.beginPath(); octx.moveTo(x + r, y); octx.arcTo(x + w, y, x + w, y + h, r); octx.arcTo(x + w, y + h, x, y + h, r);
  octx.arcTo(x, y + h, x, y, r); octx.arcTo(x, y, x + w, y, r); octx.closePath();
}
function loop() {
  if (S.mode !== 'live') return;
  drawOverlay();
  const now = performance.now();
  if (!S.chipT || now - S.chipT > 400) { S.chipT = now; renderChips(); }
  requestAnimationFrame(loop);
}

/* ---------- 状態表示 ---------- */
function renderChips() {
  const el = $('#chips'); if (!el) return;
  const chips = [];
  const st = S.still;
  if (S.pos) {
    const src = S.pos.src === 'exif' ? '写真' : S.pos.src === 'manual' ? '入力' : 'GPS';
    chips.push(`<span class="chip${S.pos.acc > 100 ? ' warn' : ''}"><b>位置</b>${src}${S.pos.acc ? ` ±${Math.round(S.pos.acc)}m` : ''}</span>`);
  } else if (S.mode !== 'home') chips.push(`<span class="chip warn"><b>位置</b>取得中</span>`);
  if (S.mode === 'live') {
    chips.push(S.sensor.heading != null ? `<span class="chip"><b>方位</b><span class="num">${Math.round(C.normAz(S.sensor.heading + S.liveOffset.yaw))}°</span> ${dirName(C.normAz(S.sensor.heading + S.liveOffset.yaw))}</span>` : `<span class="chip warn"><b>方位</b>センサー待ち</span>`);
  } else if (st) {
    const yaw = C.normAz(st.yaw0 + st.adj.yaw);
    chips.push(`<span class="chip"><b>方位</b><span class="num">${Math.round(yaw)}°</span> ${dirName(yaw)}</span>`);
    const u = uncertainty();
    chips.push(`<span class="chip ${u.aligned ? 'good' : 'warn'}"><b>合わせ</b>${st.align && st.align.applied && !st.manualAfterAlign ? `自動 一致${Math.round(st.align.cover * 100)}%` : st.manual ? '手動' : '未'}</span>`);
  }
  if (S.progress) chips.push(`<span class="chip"><b>準備</b>${esc(S.progress)}</span>`);
  else if (S.ready) chips.push(`<span class="chip good"><b>山</b><span class="num">${S.analyzed.filter(a => a.label).length}</span>座が見える</span>`);
  el.innerHTML = chips.join('');
}

/* ---------- タップと判定結果 ---------- */
function handleTap(sx, sy) {
  if (S.mode === 'live') { if (!freeze()) return; }
  if (S.mode !== 'still' || !S.still) return;
  const st = S.still;
  const T = viewTransform(st.iw, st.ih, false);
  const ix = (sx - T.ox) / T.s, iy = (sy - T.oy) / T.s;
  if (ix < 0 || iy < 0 || ix > st.iw || iy > st.ih) return;
  const d = stillCamera().unproject(ix, iy);
  S.tap = { ix, iy, az: d.az, el: d.el };
  S.selected = null;
  drawOverlay();
  showResult();
}
function showResult(forcePeak) {
  if (!S.tap) return;
  if (!S.ready) {
    openSheet(`<h2>準備中です</h2><p class="sub">地形と山名のデータを準備しています(${esc(S.progress || '')})。完了すると自動で結果を表示します。</p>`);
    return;
  }
  const st = S.still, tap = S.tap;
  // タップは写真上の位置として保持し、合わせ直した後のカメラで方向を求め直す
  const dir = stillCamera().unproject(tap.ix, tap.iy);
  tap.az = dir.az; tap.el = dir.el;
  const T = viewTransform(st.iw, st.ih, false);
  const tapSigma = Math.atan(9 / (st.F * T.s)) * R2D;       // 指先のずれ(約9px)を角度に換算
  const u = uncertainty();
  const sAz = Math.hypot(u.az, tapSigma, 0.15), sEl = Math.hypot(u.el, tapSigma, 0.15);
  const elDeg = tap.el * R2D;
  const ranked = C.rankCandidates(S.cands, tap.az, elDeg, sAz, sEl);
  const j = C.judge(ranked);
  const terrain = C.terrainAt(S.dem, S.obs, S.pano.ctx, tap.az, tap.el, settings.maxDist);
  let chosen = forcePeak ? ranked.find(r => r.p.peak === forcePeak) : (j.top || null);
  S.selected = chosen ? chosen.p : null;
  drawOverlay();

  // 見えている地形の点に最も近い山頂
  let nearTerrain = null;
  if (terrain) {
    for (const a of S.cands) {
      const dd = C.distBearing(terrain.lat, terrain.lon, a.peak.lat, a.peak.lon).d;
      if (dd < 2500 && (!nearTerrain || dd < nearTerrain.dd)) nearTerrain = { a, dd };
    }
  }

  let head;
  const lvText = { high: '確度 高', mid: '確度 中', low: '確度 低', none: '該当なし' };
  if (forcePeak && chosen) {
    head = `<h2>${esc(chosen.p.peak.name)}</h2><p class="sub"><span class="level ${chosen === j.top ? j.level : 'low'}">${chosen === j.top ? lvText[j.level] : '別の候補'}</span>${peakLine(chosen.p)}</p>`;
  } else if (j.level !== 'none' && chosen) {
    const pre = j.level === 'high' ? '' : j.level === 'mid' ? 'おそらく ' : '候補: ';
    head = `<h2>${pre}${esc(chosen.p.peak.name)}</h2><p class="sub"><span class="level ${j.level}">${lvText[j.level]}</span>${peakLine(chosen.p)}</p>`;
  } else if (terrain && terrain.sky) {
    head = `<h2>空の部分です</h2><p class="sub"><span class="level none">該当なし</span>タップした位置は計算上の稜線より ${fmtDeg((tap.el - terrain.a) * R2D, 2)} 上です。山の上をタップしてください。</p>`;
  } else {
    head = `<h2>名前の付いた山頂はありません</h2><p class="sub"><span class="level none">該当なし</span>この方向に見えているのは ${terrain ? fmtKm(terrain.d) + ' 先、標高 ' + Math.round(terrain.h) + ' m の地形' : '地形'}です。${nearTerrain ? `近くの山頂は ${esc(nearTerrain.a.peak.name)}(${fmtKm(nearTerrain.dd)} 離れている)。` : ''}</p>`;
  }

  const reasons = [];
  const tapLine = `タップした方向: 方位 <span class="num">${tap.az.toFixed(1)}°</span>(${dirName(tap.az)})、仰角 <span class="num">${fmtDeg(elDeg, 2)}</span>`;
  if (chosen) {
    const p = chosen.p;
    const within = Math.abs(chosen.dAz) <= 2 * sAz && Math.abs(chosen.dEl) <= 2 * sEl;
    reasons.push(['方向が一致', within ? 'ok' : 'warn',
      `山頂は方位 <span class="num">${p.az.toFixed(1)}°</span>・仰角 <span class="num">${fmtDeg(p.el * R2D, 2)}</span> に見える計算です。タップした方向とのずれは 方位 <span class="num">${fmtSigned(chosen.dAz, 2)}</span>、仰角 <span class="num">${fmtSigned(chosen.dEl, 2)}</span>。`,
      `${tapLine}。想定誤差 方位±${sAz.toFixed(1)}°・仰角±${sEl.toFixed(1)}°`]);
    if (p.status === 'visible') {
      reasons.push(['手前の地形に隠れない', 'ok',
        p.blocker ? `手前で最も高く見える地形(${fmtKm(p.blocker.d)} 先、標高 ${Math.round(p.blocker.h)} m、仰角 ${fmtDeg(p.blocker.el * R2D, 2)})より ${fmtDeg(p.margin * R2D, 2)} 上に山頂が出ます。` : '手前に視線を遮る地形はありません。',
        '地球の丸みと大気による光の屈折を含めて計算']);
    } else if (p.status === 'marginal') {
      reasons.push(['見えるかどうかぎりぎり', 'warn',
        `山頂と手前の地形(${fmtKm(p.blocker.d)} 先、標高 ${Math.round(p.blocker.h)} m)の見かけの高さの差が ${fmtDeg(p.margin * R2D, 2)} しかなく、標高データの誤差の範囲内です。`,
        `誤差の許容幅 ±${fmtDeg(p.tol * R2D, 2)}`]);
    } else {
      reasons.push(['手前の地形に隠れる', 'bad', `手前の地形(${fmtKm(p.blocker.d)} 先、標高 ${Math.round(p.blocker.h)} m)に ${fmtDeg(-p.margin * R2D, 2)} 隠れるため、実際には見えない計算です。`, '']);
    }
    if (terrain && !terrain.sky) {
      const fromPeak = C.distBearing(terrain.lat, terrain.lon, p.peak.lat, p.peak.lon).d;
      const same = (nearTerrain && nearTerrain.a === p) || fromPeak < 1200;
      reasons.push([same ? 'タップ地点はこの山の上' : 'タップ地点の地形', same ? 'ok' : 'warn',
        same ? `タップした方向の視線は ${fmtKm(terrain.d)} 先(標高 ${Math.round(terrain.h)} m)で地面に当たります。そこに最も近い山頂がこの山で、山頂から水平に ${fmtKm(fromPeak)} の斜面です。`
          : `タップした方向の視線は ${fmtKm(terrain.d)} 先(標高 ${Math.round(terrain.h)} m)の地形に当たります。この山頂から水平に ${fmtKm(fromPeak)} 離れているため、${terrain.d < p.d ? '手前' : '奥'}の別の尾根をタップしている可能性があります。`,
        nearTerrain && nearTerrain.a !== p ? `その地点に最も近い山頂: ${esc(nearTerrain.a.peak.name)}(${fmtKm(nearTerrain.dd)})` : '']);
    }
    if (chosen === j.top && j.second) {
      reasons.push(['他の候補との差', j.sep >= 1.5 ? 'ok' : 'warn',
        `次に近い候補 ${esc(j.second.p.peak.name)} はタップ方向から ${j.second.ang.toFixed(2)}° 離れています(この山は ${chosen.ang.toFixed(2)}°)。`,
        j.sep >= 1.5 ? '想定誤差に対して十分に離れている' : '想定誤差に対して差が小さく、取り違えの可能性がある']);
    }
  } else {
    reasons.push(['タップした方向', 'warn', tapLine, '']);
  }
  reasons.push(['稜線の合わせ', u.aligned ? 'ok' : 'warn', esc(u.why) + '。',
    u.aligned ? alignDetail() : '「自動で合わせる」を押すか、白い稜線を指でずらして写真の山の形に重ねると確度が上がります。']);

  // 候補一覧は見えている山だけ。隠れて見えない山は件数と名前だけ添える
  const shown = ranked.filter(r => r.p.status !== 'hidden').slice(0, 5);
  const hiddenNear = ranked.filter(r => r.p.status === 'hidden' && r.ang < Math.max(2, 2 * sAz));
  const candRows = shown.map(r => {
    const reason = r === j.top ? '最も方向が合う' : r.p.status === 'marginal' ? `見えるかぎりぎり、方向が ${r.ang.toFixed(2)}° ずれる` : `方向が ${r.ang.toFixed(2)}° ずれる`;
    const stTxt = { visible: '見える', marginal: 'ぎりぎり' }[r.p.status];
    return `<tr class="${chosen && chosen.p === r.p ? 'sel' : ''}"><td><button type="button" data-peak="${S.analyzed.indexOf(r.p)}">${esc(r.p.peak.name)}</button><br><span class="num sub" style="font-size:11px">${Math.round(r.p.ele)} m ・ ${fmtKm(r.p.d)}</span></td>
      <td><span class="st ${r.p.status}">${stTxt}</span></td><td class="num">${r.ang.toFixed(2)}°</td><td style="font-size:12px;color:var(--mist)">${reason}</td></tr>`;
  }).join('');
  const hiddenNote = hiddenNear.length ? `<p class="sub" style="font-size:12px">この方向には、手前の地形に隠れて見えない山が ${hiddenNear.length} 座あります(${hiddenNear.slice(0, 3).map(r => esc(r.p.peak.name)).join('、')}${hiddenNear.length > 3 ? ' など' : ''})。見えないため候補から外しています。</p>` : '';

  const target = chosen ? { az: chosen.p.az, d: chosen.p.d, top: chosen.p.ele, name: chosen.p.peak.name, a: chosen.p }
    : terrain && !terrain.sky ? { az: tap.az, d: terrain.d, top: terrain.h, name: 'タップ地点' } : null;
  const gsiLink = target ? (() => { const pt = chosen ? chosen.p.peak : terrain; return `https://maps.gsi.go.jp/#13/${pt.lat.toFixed(6)}/${pt.lon.toFixed(6)}/`; })() : null;
  const where = target ? `${chosen ? esc(chosen.p.peak.name) + 'は' : 'タップした地点は'}、あなたから見て <strong>${dirName(target.az)}(方位 ${Math.round(target.az)}°)</strong>の方向、<strong>${fmtKm(target.d)}</strong> 先にあります。` : '';
  const ds = S.demStats;

  openSheet(`
    ${head}
    ${target ? `<h3>地図(上が北)</h3><p class="where">${where}</p><div id="map" class="map-lg"></div>
      <p class="sub" style="font-size:12px">オレンジの線が視線、薄い扇形がカメラに写っている範囲です。<a href="${gsiLink}" target="_blank" rel="noopener">地理院地図で開く</a></p>` : ''}
    <h3>判定の根拠</h3>
    <ul class="reasons">${reasons.map(([t, k, body, small]) => `<li><span class="mk ${k}">${k === 'ok' ? '✓' : k === 'warn' ? '!' : '×'}</span><div><strong>${t}</strong><br>${body}${small ? `<small>${small}</small>` : ''}</div></li>`).join('')}</ul>
    ${target ? `<h3>断面図(あなた → ${esc(target.name)})</h3><canvas class="profile" id="prof"></canvas><p class="sub" style="font-size:12px">点線は視線。地球の丸みと屈折を差し引いた高さで描いています(縦方向は強調)。</p>` : ''}
    ${shown.length ? `<h3>近くの候補</h3><div class="cands-wrap"><table class="cands"><thead><tr><th>山名</th><th>見通し</th><th>ずれ</th><th>理由</th></tr></thead><tbody>${candRows}</tbody></table></div>` : ''}
    ${hiddenNote}
    <h3>計算の条件</h3>
    <dl class="cond">
      <dt>観測地点</dt><dd class="num">${S.obs.lat.toFixed(5)}, ${S.obs.lon.toFixed(5)}(${S.pos.src === 'exif' ? '写真の位置情報' : S.pos.src === 'manual' ? '手入力' : 'GPS'}${S.pos.acc ? ` ±${Math.round(S.pos.acc)}m` : ''})</dd>
      <dt>目の高さ</dt><dd class="num">地面 ${Math.round(S.ground)} m + ${settings.eye} m = ${Math.round(S.obs.h)} m</dd>
      <dt>方位の出所</dt><dd>${esc(st.yawSrc)}${st.adj.yaw || st.adj.pitch ? `、補正 方位 ${fmtSigned(st.adj.yaw)}・上下 ${fmtSigned(st.adj.pitch)}` : ''}</dd>
      <dt>画角</dt><dd>${st.src === 'live' ? `ライブ設定 ${settings.liveFov}°(長辺)` : esc(st.fSrc)}${st.F !== st.F0 ? `、手動で ${(st.F / st.F0 * 100).toFixed(0)}% に調整` : ''}</dd>
      <dt>計算範囲</dt><dd>${settings.maxDist / 1000} km 以内、方位 0.1° 刻み</dd>
      <dt>標高</dt><dd>${S.demSource.credit}(3 km以内 約8 m、25 km以内 約30 m、それ以遠 約120 m の解像度)${ds && ds.total ? `、${ds.failed ? `<span style="color:var(--warn)">取得できなかったタイル ${ds.failed}/${ds.total} 枚</span>` : `${ds.total} 枚すべて取得`}` : ''}</dd>
      <dt>山名</dt><dd><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>${S.peaksError ? '(取得失敗)' : `(${S.peaks.length} 件、標高が不明・0 m の ${S.analyzed.filter(a => a.ele < 1).length} 件は除外)`}</dd>
    </dl>`);
  $('#sheet').querySelectorAll('button[data-peak]').forEach(b => b.onclick = () => {
    const a = S.analyzed[+b.dataset.peak];
    showResult(a.peak);
  });
  if (target) {
    drawProfile($('#prof'), target);
    showMap({ p: chosen ? chosen.p : null, terrain, others: shown.map(r => r.p).filter(x => !chosen || x !== chosen.p), view: viewInfo() });
  }
}
function peakLine(p) {
  return `標高 <span class="num">${Math.round(p.ele)}</span> m${p.eleSrc === 'dem' ? '(地形データ)' : ''}・<span class="num">${fmtKm(p.d)}</span> 先・${dirName(p.az)}${p.peak.kana ? `・${esc(p.peak.kana)}` : ''}`;
}
function alignDetail() {
  const st = S.still;
  if (st.align && st.align.applied && !st.manualAfterAlign) {
    const a = st.align;
    return `写真から読み取った稜線と計算上の稜線が ${Math.round(a.cover * 100)}% の幅で重なりました。次に良い別の合わせ方(方位 ${a.rivalDyaw != null ? fmtSigned(a.rivalDyaw) : '—'})より ${isFinite(a.distinct) ? a.distinct.toFixed(1) + '倍' : '大幅に'} よく合っています。`;
  }
  return `補正量 方位 ${fmtSigned(st.adj.yaw)}・上下 ${fmtSigned(st.adj.pitch)}`;
}
function drawProfile(cv, target) {
  if (!cv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const prof = C.profile(S.dem, S.obs, target.az, target.d, 260);
  const eye = S.obs.h, ty = target.top - C.curvatureDrop(target.d);
  let ymin = Math.min(eye, ...prof.map(p => p.y)), ymax = Math.max(eye, ty, ...prof.map(p => p.y));
  const pad = (ymax - ymin) * 0.12 + 20; ymin -= pad; ymax += pad;
  const L = 44, Rr = 10, Tp = 12, B = 22;
  const xs = d => L + d / (target.d * 1.04) * (W - L - Rr), ys = y => Tp + (ymax - y) / (ymax - ymin) * (H - Tp - B);
  const css = getComputedStyle(document.documentElement);
  const mist = css.getPropertyValue('--mist').trim(), snow = css.getPropertyValue('--snow').trim(), alpen = css.getPropertyValue('--alpen').trim();
  g.font = '10px ui-monospace, Menlo, monospace'; g.fillStyle = mist; g.strokeStyle = 'rgba(154,167,178,.18)'; g.lineWidth = 1;
  const stepM = niceStep((ymax - ymin) / 4);
  for (let v = Math.ceil(ymin / stepM) * stepM; v <= ymax; v += stepM) { g.beginPath(); g.moveTo(L, ys(v)); g.lineTo(W - Rr, ys(v)); g.stroke(); g.fillText(Math.round(v) + 'm', 2, ys(v) + 3); }
  const stepK = niceStep(target.d / 1000 / 4) * 1000;
  for (let d = 0; d <= target.d * 1.04; d += stepK) { g.fillText((d / 1000) + 'km', xs(d) - 8, H - 6); }
  g.beginPath(); g.moveTo(xs(0), ys(S.ground));
  for (const p of prof) g.lineTo(xs(p.d), ys(p.y));
  g.lineTo(xs(prof.length ? prof[prof.length - 1].d : 0), H - B); g.lineTo(xs(0), H - B); g.closePath();
  g.fillStyle = 'rgba(154,167,178,.22)'; g.fill();
  g.beginPath(); prof.forEach((p, i) => i ? g.lineTo(xs(p.d), ys(p.y)) : g.moveTo(xs(p.d), ys(p.y)));
  g.strokeStyle = snow; g.lineWidth = 1.4; g.stroke();
  g.setLineDash([4, 4]); g.strokeStyle = alpen; g.beginPath(); g.moveTo(xs(0), ys(eye)); g.lineTo(xs(target.d), ys(ty)); g.stroke(); g.setLineDash([]);
  g.fillStyle = alpen; g.beginPath(); g.arc(xs(0), ys(eye), 3.5, 0, 7); g.fill(); g.beginPath(); g.arc(xs(target.d), ys(ty), 3.5, 0, 7); g.fill();
  if (target.a && target.a.blocker) {
    const b = target.a.blocker, by = b.h - C.curvatureDrop(b.d);
    g.strokeStyle = target.a.status === 'hidden' ? '#ef8a80' : '#7fd1a5'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(xs(b.d), ys(by), 5, 0, 7); g.stroke();
  }
  g.fillStyle = snow; g.font = '11px ' + getComputedStyle(document.body).fontFamily;
  g.fillText('あなた', xs(0) + 5, ys(eye) - 6);
  const tw = g.measureText(target.name).width;
  g.fillText(target.name, Math.min(xs(target.d) - tw / 2, W - Rr - tw), Math.max(12, ys(ty) - 7));
}
function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }

let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => res(window.L); s.onerror = () => { leafletP = null; rej(new Error('地図を読み込めません')); };
    document.head.appendChild(s);
  });
  return leafletP;
}
let mapInst = null;
/* いまカメラが向いている方位と、写っている左右の範囲[度] */
function viewInfo() {
  if (S.mode === 'still' && S.still) {
    const st = S.still;
    return { yaw: C.normAz(st.yaw0 + st.adj.yaw), hfov: 2 * Math.atan((st.iw / 2) / st.F) * R2D };
  }
  if (S.mode === 'live') {
    const lc = liveCamera(); if (!lc) return null;
    const T = viewTransform(lc.iw, lc.ih, true);
    return { yaw: C.normAz(lc.cam.o.yaw), hfov: 2 * Math.atan((overlay.clientWidth / 2) / (lc.cam.F * T.s)) * R2D };
  }
  return null;
}
async function createMap(box) {
  let L;
  try { L = await loadLeaflet(); } catch (e) { box.innerHTML = '<p class="sub" style="padding:12px">地図を読み込めませんでした。</p>'; return null; }
  if (!document.body.contains(box)) return null;
  if (mapInst) { mapInst.remove(); mapInst = null; }
  const map = L.map(box, { zoomControl: false, attributionControl: true });
  mapInst = map;
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const North = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'north'); d.innerHTML = '<span>N</span>▲'; return d; } });
  new North({ position: 'topright' }).addTo(map);
  return { L, map };
}
function addWedge(L, map, view, r) {
  if (!view) return;
  const pts = [[S.obs.lat, S.obs.lon]];
  for (let i = 0; i <= 24; i++) { const q = C.destination(S.obs.lat, S.obs.lon, view.yaw - view.hfov / 2 + view.hfov * i / 24, r); pts.push([q.lat, q.lon]); }
  L.polygon(pts, { color: '#d9822b', weight: 1, dashArray: '3 4', fillColor: '#f0a35e', fillOpacity: 0.13, interactive: false }).addTo(map);
}
function addMe(L, map) {
  L.circleMarker([S.obs.lat, S.obs.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1f6feb', fillOpacity: 1 }).addTo(map)
    .bindTooltip('あなた', { permanent: true, direction: 'bottom', className: 'tip-me' });
}
const peakTip = a => `${esc(a.peak.name)} <span class="tip-sub">${dirName(a.az)} ${Math.round(a.az)}° ・ ${fmtKm(a.d)}</span>`;
async function showMap(o) {
  const box = $('#map'); if (!box) return;
  const m = await createMap(box); if (!m) return;
  const { L, map } = m;
  const me = [S.obs.lat, S.obs.lon];
  const pts = [me];
  const far = o.p ? o.p.d : o.terrain ? o.terrain.d : 5000;
  addWedge(L, map, o.view, Math.max(3000, far * 1.15));
  for (const a of (o.others || []).slice(0, 4)) {
    L.circleMarker([a.peak.lat, a.peak.lon], { radius: 4, color: '#555', weight: 1.5, fillColor: '#fff', fillOpacity: 0.95 }).addTo(map).bindTooltip(esc(a.peak.name));
  }
  if (o.terrain && !o.terrain.sky && (!o.p || C.distBearing(o.terrain.lat, o.terrain.lon, o.p.peak.lat, o.p.peak.lon).d > 1200)) {
    const ll = [o.terrain.lat, o.terrain.lon];
    L.polyline([me, ll], { color: '#3b6ea8', weight: 2, dashArray: '4 4' }).addTo(map);
    L.circleMarker(ll, { radius: 4, color: '#3b6ea8', fillColor: '#3b6ea8', fillOpacity: 1 }).addTo(map).bindTooltip('タップした地点の地形');
    pts.push(ll);
  }
  if (o.p) {
    const ll = [o.p.peak.lat, o.p.peak.lon];
    L.polyline([me, ll], { color: '#d9822b', weight: 3 }).addTo(map);
    L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: '#d9822b', fillOpacity: 1 }).addTo(map)
      .bindTooltip(peakTip(o.p), { permanent: true, direction: 'top', className: 'tip-peak' });
    pts.push(ll);
  }
  addMe(L, map);
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}
/* いま向いている方向の俯瞰地図 */
async function openMapView() {
  if (!S.ready) { toast('地形と山名のデータを準備中です。完了してから開いてください。'); return; }
  const v = viewInfo();
  const inView = S.analyzed.filter(a => a.label && (!v || Math.abs(C.angDiff(a.az, v.yaw)) <= v.hfov / 2)).slice(0, 12);
  const rows = inView.map(a => `<tr><td>${esc(a.peak.name)}<br><span class="num sub" style="font-size:11px">${Math.round(a.ele)} m</span></td><td class="num">${dirName(a.az)} ${Math.round(a.az)}°</td><td class="num">${fmtKm(a.d)}</td></tr>`).join('');
  openSheet(`
    <h2>いま向いている方向</h2>
    <p class="sub">${v ? `${dirName(v.yaw)}(方位 ${Math.round(v.yaw)}°)を中心に幅 ${Math.round(v.hfov)}° の範囲` : '全方位'}で、見えている山 ${inView.length} 座を表示しています。</p>
    <div id="map" class="map-lg"></div>
    ${rows ? `<div class="cands-wrap" style="margin-top:12px"><table class="cands"><thead><tr><th>山名</th><th>方位</th><th>距離</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`);
  const box = $('#map');
  const m = await createMap(box); if (!m) return;
  const { L, map } = m;
  const r = inView.length ? Math.max(...inView.map(a => a.d)) * 1.1 : 20000;
  addWedge(L, map, v, r);
  const pts = [[S.obs.lat, S.obs.lon]];
  inView.forEach((a, i) => {
    const ll = [a.peak.lat, a.peak.lon];
    L.polyline([pts[0], ll], { color: '#d9822b', weight: 1, opacity: 0.45 }).addTo(map);
    L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.5, fillColor: '#d9822b', fillOpacity: 1 }).addTo(map)
      .bindTooltip(esc(a.peak.name), { permanent: i < 6, direction: 'top', className: 'tip-peak' });
    pts.push(ll);
  });
  addMe(L, map);
  if (v) { const q = C.destination(S.obs.lat, S.obs.lon, v.yaw, r); pts.push([q.lat, q.lon]); }
  map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

/* ---------- シート ---------- */
function openSheet(html) {
  const el = $('#sheet');
  el.removeAttribute('data-n');
  $('#toast').hidden = true;
  el.innerHTML = `<div class="sheet-grip"><span class="bar"></span><button class="icon-btn" type="button" id="sheetClose" aria-label="閉じる">閉じる</button></div>` + html;
  el.hidden = false;
  el.scrollTop = 0;
  $('#sheetClose').onclick = closeSheet;
  if (!S.sheetOpen) { S.sheetOpen = true; if (S.mode === 'still') resizeOverlay(); }
}
function closeSheet() {
  const el = $('#sheet');
  el.hidden = true; el.innerHTML = '';
  if (mapInst) { mapInst.remove(); mapInst = null; }
  if (S.sheetOpen) { S.sheetOpen = false; if (S.mode === 'still') resizeOverlay(); }
}
function openSettings() {
  openSheet(`
    <h2>設定</h2>
    <label class="field">目の高さ(地面から、m)<input type="number" id="setEye" min="0" max="500" step="0.1" value="${settings.eye}">
      <small>マンションの上の階から見る場合は、その高さを入れてください(例: 5階なら約14m)。</small></label>
    <label class="field">調べる範囲<select id="setDist">
      ${[60000, 120000, 200000].map(v => `<option value="${v}" ${v === settings.maxDist ? 'selected' : ''}>${v / 1000} km 以内${v === 200000 ? '(読み込みに時間がかかる)' : ''}</option>`).join('')}</select></label>
    <label class="field">ライブ映像の画角(長辺、度)<input type="number" id="setFov" min="20" max="110" step="0.5" value="${settings.liveFov}">
      <small>山名が実際より外側・内側にずれて並ぶときに調整します。写真では2本指の広げ・縮めで調整できます。</small></label>
    <label class="field" style="grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" id="setHidden" ${settings.showHidden ? 'checked' : ''}> 手前の地形に隠れた山も表示する</label>
    <div class="row"><button class="btn primary" id="setSave" type="button">保存</button></div>
    <p class="credit">標高: 国土地理院 標高タイル(取得できない場合は Terrain Tiles / AWS Open Data)。山名: © OpenStreetMap contributors。地図: 国土地理院。</p>`);
  $('#setSave').onclick = () => {
    const eye = parseFloat($('#setEye').value), dist = parseInt($('#setDist').value, 10), fov = parseFloat($('#setFov').value);
    if (eye >= 0 && eye <= 500) settings.eye = eye;
    if ([60000, 120000, 200000].includes(dist)) settings.maxDist = dist;
    if (fov >= 20 && fov <= 110) settings.liveFov = fov;
    settings.showHidden = $('#setHidden').checked;
    saveSettings();
    closeSheet();
    if (S.pos && needsReload(S.pos)) prepare(S.pos);
    drawOverlay();
  };
}

/* ---------- 操作 ----------
   タップ=判定、2本指=拡大・縮小(画像と重ね表示を一緒に拡大)、
   1本指ドラッグ=拡大中は表示の移動、等倍のときは稜線の合わせ */
const pointers = new Map();
let gesture = null;
const mid = () => { const [a, b] = [...pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
function snapshotAlign() {
  if (S.mode === 'still' && S.still) return { still: { ...S.still.adj }, manual: S.still.manual, mAfter: S.still.manualAfterAlign, live: { ...S.liveOffset } };
  return { live: { ...S.liveOffset } };
}
function restoreAlign(snap) {
  if (!snap) return;
  if (snap.still && S.still) { S.still.adj = snap.still; S.still.manual = snap.manual; S.still.manualAfterAlign = snap.mAfter; }
  S.liveOffset = snap.live;
}
$('#stage').addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { $('#stage').setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントなど */ }
  if (pointers.size === 1) {
    gesture = { type: 'pan', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), moved: false, snap: snapshotAlign() };
  } else if (pointers.size === 2) {
    // 2本目の指が触れたら、1本目で動いてしまった合わせを取り消して拡大に切り替える
    if (gesture && gesture.type === 'pan') restoreAlign(gesture.snap);
    const m = mid();
    if (S.mode === 'still' && S.still) {
      const st = S.still;
      if (!S.stillView) S.stillView = { z: 1, cx: st.iw / 2, cy: st.ih / 2 };
      const T = viewTransform(st.iw, st.ih, false);
      gesture = { type: 'pinch', d0: Math.max(10, m.d), z0: S.stillView.z, ip: { x: (m.x - T.ox) / T.s, y: (m.y - T.oy) / T.s } };
    } else if (S.mode === 'live') {
      gesture = { type: 'pinch', d0: Math.max(10, m.d), z0: S.liveZoom || 1 };
    }
    drawOverlay();
  }
});
$('#stage').addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.type === 'pan') {
    const dx = e.clientX - gesture.lx, dy = e.clientY - gesture.ly;
    if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) gesture.moved = true;
    if (!gesture.moved) return;
    gesture.lx = e.clientX; gesture.ly = e.clientY;
    if (S.mode === 'still' && S.still) {
      const st = S.still, T = viewTransform(st.iw, st.ih, false);
      if (T.z > 1.05) {
        // 拡大中は表示を動かす
        S.stillView.cx -= dx / T.s; S.stillView.cy -= dy / T.s;
        clampStillView(); drawStill();
      } else {
        st.adj.yaw -= Math.atan(dx / (st.F * T.s)) * R2D;
        st.adj.pitch += Math.atan(dy / (st.F * T.s)) * R2D;
        st.manual = true; if (st.align && st.align.applied) st.manualAfterAlign = true;
        if (st.src === 'live') { S.liveOffset.yaw = st.liveOffset.yaw + st.adj.yaw; S.liveOffset.pitch = st.liveOffset.pitch + st.adj.pitch; }
      }
      drawOverlay();
    } else if (S.mode === 'live') {
      const lc = liveCamera(); if (!lc) return;
      const T = viewTransform(lc.iw, lc.ih, true);
      S.liveOffset.yaw -= Math.atan(dx / (lc.cam.F * T.s)) * R2D;
      S.liveOffset.pitch += Math.atan(dy / (lc.cam.F * T.s)) * R2D;
    }
  } else if (gesture.type === 'pinch' && pointers.size === 2) {
    const m = mid();
    if (S.mode === 'still' && S.still) {
      const st = S.still, v = S.stillView;
      v.z = Math.max(1, Math.min(MAX_ZOOM_STILL, gesture.z0 * m.d / gesture.d0));
      // 指の間にある画像上の点が、指の中点に留まるように中心を動かす
      const b = baseTransform(st.iw, st.ih, false), sc = b.s * v.z;
      const Sx = b.ox + st.iw / 2 * b.s, Sy = b.oy + st.ih / 2 * b.s;
      v.cx = gesture.ip.x - (m.x - Sx) / sc;
      v.cy = gesture.ip.y - (m.y - Sy) / sc;
      clampStillView(); drawStill(); drawOverlay();
    } else if (S.mode === 'live') {
      S.liveZoom = Math.max(1, Math.min(MAX_ZOOM_LIVE, gesture.z0 * m.d / gesture.d0));
      applyLiveZoom();
    }
    updateZoomUi();
  }
});
const endPointer = e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'pan' && !gesture.moved && performance.now() - gesture.t0 < 600 && e.type === 'pointerup') handleTap(e.clientX, e.clientY);
  if (gesture && gesture.type === 'pan' && gesture.moved) { renderChips(); if (S.tap && S.mode === 'still') showResult(); }
  if (gesture && gesture.type === 'pinch' && pointers.size < 2) {
    if (S.mode === 'still' && S.stillView && S.stillView.z <= 1.02) { S.stillView = null; drawStill(); drawOverlay(); }
    if (S.mode === 'live' && S.liveZoom <= 1.02) { S.liveZoom = 1; applyLiveZoom(); }
    updateZoomUi();
    gesture = pointers.size ? { type: 'none' } : null;   // 残った1本の指では何もしない
    return;
  }
  if (!pointers.size) gesture = null;
};
$('#stage').addEventListener('pointerup', endPointer);
$('#stage').addEventListener('pointercancel', endPointer);

/* ---------- ボタン ---------- */
$('#btnLive').onclick = () => startLive();
$('#btnPhoto').onclick = () => $('#fileInput').click();
$('#btnPhoto2').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadPhoto(f); };
$('#btnShutter').onclick = () => { if (freeze()) toast('山をタップすると名前と根拠を表示します。'); };
$('#btnAlign').onclick = () => { if (S.still) { S.still.manualAfterAlign = false; autoAlignStill(false); } };
$('#btnReset').onclick = () => {
  const st = S.still; if (!st) return;
  st.adj = { yaw: 0, pitch: 0 }; st.F = st.F0; st.manual = false; st.align = null; st.manualAfterAlign = false;
  if (st.src === 'live') S.liveOffset = { ...st.liveOffset };
  drawOverlay(); renderChips(); if (S.tap) showResult();
};
$('#btnBack').onclick = () => {
  if (S.mode === 'still' && S.still && S.still.src === 'live' && S.stream) { backToLive(); loop(); return; }
  stopLive(); stopGeo(); S.still = null; S.tap = null; show('home');
};
$('#btnSettings').onclick = openSettings;
$('#btnMap').onclick = () => openMapView();
$('#btnZoom').onclick = () => {
  if (S.mode === 'live') { S.liveZoom = 1; applyLiveZoom(); }
  else if (S.mode === 'still') { S.stillView = null; drawStill(); drawOverlay(); }
  updateZoomUi();
};
// iPhoneのSafariでページ全体が拡大されないようにする(拡大はアプリ側で行う)
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
$('#btnSettingsHome').onclick = openSettings;
window.addEventListener('resize', () => { resizeOverlay(); });
if (!window.isSecureContext) $('#secureBanner').hidden = false;

// 検証用の窓口(画面からは使わない)
window.__yama = { S, settings, prepare, handleTap, showResult, autoAlignStill, drawOverlay, viewTransform,
  imgToScreen: (x, y) => { const st = S.still, T = viewTransform(st.iw, st.ih, false); return [T.ox + x * T.s, T.oy + y * T.s]; } };
show('home');
})();
