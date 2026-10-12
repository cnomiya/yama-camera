/* 山座同定カメラ — 判定ロジック(DOM非依存。ブラウザとNodeの両方で動く) */
(function (root) {
'use strict';

const R_EARTH = 6371008.8;      // 地球の平均半径 [m]
const REFRACTION_K = 0.13;      // 大気差(光の屈折)係数。測量で一般的に用いられる値
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const normAz = a => { a %= 360; return a < 0 ? a + 360 : a; };
const angDiff = (a, b) => ((a - b) % 360 + 540) % 360 - 180;   // a-b を -180..180 に

/* ---------- 測地計算(球面) ---------- */
function distBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { d, az: normAz(Math.atan2(y, x) * R2D) };
}
function destination(lat, lon, azDeg, d) {
  const p1 = lat * D2R, l1 = lon * D2R, th = azDeg * D2R, dr = d / R_EARTH;
  const sp2 = Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(th);
  const p2 = Math.asin(sp2);
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * sp2);
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}
/* 地球の丸みと大気差を考慮した見かけの仰角 [rad] */
function curvatureDrop(d) { return d * d * (1 - REFRACTION_K) / (2 * R_EARTH); }
function apparentElev(dh, d) { return Math.atan2(dh - curvatureDrop(d), Math.max(d, 1e-6)); }

/* ---------- Webメルカトルのタイル座標 ---------- */
const lonToPx = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const latToPx = (lat, z) => { const s = Math.sin(lat * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };

function tilesForRadius(lat, lon, radius, z) {
  const dN = destination(lat, lon, 0, radius), dS = destination(lat, lon, 180, radius);
  const dE = destination(lat, lon, 90, radius), dW = destination(lat, lon, 270, radius);
  const x0 = Math.floor(lonToPx(dW.lon, z) / 256), x1 = Math.floor(lonToPx(dE.lon, z) / 256);
  const y0 = Math.floor(latToPx(dN.lat, z) / 256), y1 = Math.floor(latToPx(dS.lat, z) / 256);
  const cx = lonToPx(lon, z), cy = latToPx(lat, z);
  const rpx = (lonToPx(dE.lon, z) - lonToPx(dW.lon, z)) / 2;
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    // 円と交わるタイルだけ
    const nx = Math.max(x * 256, Math.min(cx, x * 256 + 256)), ny = Math.max(y * 256, Math.min(cy, y * 256 + 256));
    if (Math.hypot(nx - cx, ny - cy) <= rpx * 1.02) out.push({ z, x, y });
  }
  return out;
}

/* 標高PNGのデコード */
function decodeGSI(rgba) {        // 国土地理院 標高タイル(PNG)の仕様
  const n = rgba.length / 4, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const x = r * 65536 + g * 256 + b;
    out[i] = x === 8388608 ? 0 : (x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01);   // 無効値(海など)は0m
  }
  return out;
}
function decodeTerrarium(rgba) {  // Mapzen Terrarium形式
  const n = rgba.length / 4, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768);
  return out;
}

/* ---------- 標高モデル(距離に応じて解像度を切り替える) ---------- */
const SEA = new Float32Array(65536);
class DEM {
  constructor(tiers) {             // tiers: [{z, maxDist}] 近い順
    this.tiers = tiers.slice().sort((a, b) => a.maxDist - b.maxDist);
    this.tiles = new Map();
    this._k = -1; this._a = null;
  }
  key(z, x, y) { return z * 1e10 + x * 1e5 + y; }
  setTile(z, x, y, arr) { this.tiles.set(this.key(z, x, y), arr || SEA); }
  hasTile(z, x, y) { return this.tiles.has(this.key(z, x, y)); }
  _px(z, gx, gy) {
    const k = z * 1e10 + (gx >> 8) * 1e5 + (gy >> 8);
    let a;
    if (k === this._k) a = this._a; else { a = this.tiles.get(k); if (a === undefined) return NaN; this._k = k; this._a = a; }
    return a[((gy & 255) << 8) | (gx & 255)];
  }
  sampleZ(lat, lon, z) {
    const fx = lonToPx(lon, z) - 0.5, fy = latToPx(lat, z) - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const a = this._px(z, x0, y0), b = this._px(z, x0 + 1, y0), c = this._px(z, x0, y0 + 1), d = this._px(z, x0 + 1, y0 + 1);
    if (a !== a || b !== b || c !== c || d !== d) return NaN;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  tierIndex(dist) { for (let i = 0; i < this.tiers.length; i++) if (dist <= this.tiers[i].maxDist) return i; return this.tiers.length - 1; }
  sampleTier(lat, lon, ti) {
    for (let i = ti; i < this.tiers.length; i++) { const v = this.sampleZ(lat, lon, this.tiers[i].z); if (v === v) return v; }
    return NaN;
  }
  sample(lat, lon, dist) { return this.sampleTier(lat, lon, this.tierIndex(dist || 0)); }
  /* 最も細かい層で読める標高(山頂や現在地の標高用) */
  sampleFinest(lat, lon) { return this.sampleTier(lat, lon, 0); }
}

/* ---------- 光線の歩進距離 ---------- */
function makeSteps(maxD) {
  const ds = [];
  let d = 20;
  while (d <= maxD) { ds.push(d); d += Math.max(12, d * 0.006); }
  ds.push(maxD);
  return Float64Array.from(ds);
}
function rayContext(dem, obs, maxD) {
  const ds = makeSteps(maxD), n = ds.length;
  const sinD = new Float64Array(n), cosD = new Float64Array(n), drop = new Float64Array(n), tier = new Int8Array(n);
  for (let k = 0; k < n; k++) {
    const dr = ds[k] / R_EARTH; sinD[k] = Math.sin(dr); cosD[k] = Math.cos(dr);
    drop[k] = curvatureDrop(ds[k]); tier[k] = dem.tierIndex(ds[k]);
  }
  const p1 = obs.lat * D2R;
  return { ds, n, sinD, cosD, drop, tier, sp1: Math.sin(p1), cp1: Math.cos(p1), l1: obs.lon * D2R };
}
/* 1方位ぶんの光線を歩進し、各点で cb(k, d, lat, lon, h, angle) を呼ぶ。cb が false を返すと打ち切り */
function marchRay(dem, obs, ctx, azDeg, limitD, cb) {
  const th = azDeg * D2R, st = Math.sin(th), ct = Math.cos(th);
  const { ds, n, sinD, cosD, drop, tier, sp1, cp1, l1 } = ctx;
  let missing = 0, total = 0;
  for (let k = 0; k < n; k++) {
    const d = ds[k];
    if (d > limitD) break;
    const sp2 = sp1 * cosD[k] + cp1 * sinD[k] * ct;
    const lat = Math.asin(sp2) * R2D;
    const lon = (l1 + Math.atan2(st * sinD[k] * cp1, cosD[k] - sp1 * sp2)) * R2D;
    const h = dem.sampleTier(lat, lon, tier[k]);
    total++;
    if (h !== h) { missing++; continue; }
    const a = Math.atan2(h - obs.h - drop[k], d);
    if (cb(k, d, lat, lon, h, a) === false) break;
  }
  return { missing, total };   // 標高データが欠けていた点の数
}

/* ---------- 360°パノラマ(稜線)の計算 ---------- */
function createPanorama(dem, obs, maxDist, azStep) {
  azStep = azStep || 0.1;
  const n = Math.round(360 / azStep);
  return {
    obs, maxDist, azStep, n,
    ctx: rayContext(dem, obs, maxDist),
    sky: new Float32Array(n).fill(NaN),   // 稜線の仰角 [rad]
    skyD: new Float32Array(n),            // 稜線までの距離 [m]
    ridgeIdx: [], ridgeEl: [], ridgeD: [], // 重なって見える尾根の輪郭
    done: 0,
  };
}
function computePanoramaRange(dem, pano, i0, i1) {
  const { obs, ctx, maxDist } = pano;
  for (let i = i0; i < i1 && i < pano.n; i++) {
    const az = i * pano.azStep;
    let maxA = -Infinity, maxD = 0, inRun = false, cand = null, minSince = Infinity;
    marchRay(dem, obs, ctx, az, maxDist, (k, d, lat, lon, h, a) => {
      if (a > maxA) {
        if (!inRun && cand) {
          const dip = Math.max(0.0009, Math.atan(12 / cand.d));      // 0.05° または 12m 相当
          if (cand.a - minSince > dip && cand.d > 150) { pano.ridgeIdx.push(i); pano.ridgeEl.push(cand.a); pano.ridgeD.push(cand.d); }
          cand = null;
        }
        maxA = a; maxD = d; inRun = true;
      } else {
        if (inRun) { cand = { a: maxA, d: maxD }; minSince = a; inRun = false; }
        else if (a < minSince) minSince = a;
      }
    });
    pano.sky[i] = maxA === -Infinity ? NaN : maxA;
    pano.skyD[i] = maxD;
    pano.done = i + 1;
  }
}
function skyAt(pano, azDeg) {
  const f = normAz(azDeg) / pano.azStep, i0 = Math.floor(f) % pano.n, i1 = (i0 + 1) % pano.n, t = f - Math.floor(f);
  return pano.sky[i0] * (1 - t) + pano.sky[i1] * t;
}

/* ---------- 山頂の見通し判定 ---------- */
function analyzePeak(dem, obs, ctx, peak) {
  const { d, az } = distBearing(obs.lat, obs.lon, peak.lat, peak.lon);
  if (d < 80) return null;
  let hp = peak.ele, eleSrc = 'osm';
  if (!(hp > -100)) { hp = dem.sampleFinest(peak.lat, peak.lon); eleSrc = 'dem'; }
  if (!(hp > -100)) return null;
  const el = apparentElev(hp - obs.h, d);
  // 山頂自身の斜面(山頂から手前へ続く高い部分)は遮蔽物として数えない。
  // なだらかな山では、山頂より手前の肩が見かけ上わずかに高く見えるため。
  const pts = [];
  const cov = marchRay(dem, obs, ctx, az, d - 30, (k, dd, lat, lon, h, a) => { pts.push(dd, h, a, lat, lon); });
  const missingRatio = cov.total ? cov.missing / cov.total : 1;
  const thr = Math.max(80, 0.12 * (hp - obs.h));
  let cut = pts.length;
  while (cut >= 5 && pts[cut - 4] >= hp - thr) cut -= 5;
  const minEx = d - Math.max(150, d * 0.01);
  let fg = -Infinity, fgD = 0, fgH = 0, fgLat = 0, fgLon = 0;
  for (let i = 0; i < cut; i += 5) {
    if (pts[i] > minEx) break;
    if (pts[i + 2] > fg) { fg = pts[i + 2]; fgD = pts[i]; fgH = pts[i + 1]; fgLat = pts[i + 3]; fgLon = pts[i + 4]; }
  }
  // 標高データの誤差を角度に換算した許容幅(遠いほど粗いデータを使うので広げる)
  const tolH = 12 + d * 0.0003;
  const tol = Math.atan(tolH / d);
  const margin = fg === -Infinity ? Infinity : el - fg;
  let status = margin > tol ? 'visible' : (margin < -tol ? 'hidden' : 'marginal');
  // 途中の標高データが欠けていると遮る地形を見落とすため、判定できないものとして扱う
  if (missingRatio > 0.03 && status !== 'hidden') status = 'unknown';
  return {
    peak, d, az, el, ele: hp, eleSrc, status, margin, tol, missingRatio,
    blocker: fg === -Infinity ? null : { d: fgD, h: fgH, el: fg, lat: fgLat, lon: fgLon },
  };
}

/* 山頂が「見える輪郭」の上にあるか(空との境目、または手前の尾根に重なる奥の尾根の輪郭)。
   輪郭上にない山頂は、斜面の途中にあって見分けにくい */
function onOutline(pano, a) {
  const tolEl = Math.max(0.12 * D2R, Math.atan(25 / a.d));
  const sky = skyAt(pano, a.az);
  if (a.el >= sky - tolEl) return 'sky';
  const R = pano.ridges;
  if (!R) return null;
  const i0 = Math.round(normAz(a.az) / pano.azStep);
  for (let di = -2; di <= 2; di++) {
    const i = ((i0 + di) % pano.n + pano.n) % pano.n;
    for (let k = R.start[i]; k < R.start[i + 1]; k++) {
      if (Math.abs(R.el[k] - a.el) <= tolEl && Math.abs(R.d[k] - a.d) <= Math.max(1500, a.d * 0.12)) return 'ridge';
    }
  }
  return null;
}

/* 指定方向で実際に見えている地形の点(その方向の視線が最初に地面に当たる点) */
function terrainAt(dem, obs, ctx, azDeg, elRad, maxDist) {
  let hit = null, best = null;
  marchRay(dem, obs, ctx, azDeg, maxDist, (k, d, lat, lon, h, a) => {
    if (!best || a > best.a) best = { d, lat, lon, h, a };
    if (a >= elRad) { hit = { d, lat, lon, h, a, sky: false }; return false; }
  });
  if (hit) return hit;
  return best ? Object.assign(best, { sky: true }) : null;   // 稜線より上(空)をタップした場合は稜線の点
}

/* 断面(観測者→目標)。y は地球の丸みを差し引いた高さ */
function profile(dem, obs, azDeg, dTarget, n) {
  n = n || 240;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = dTarget * 1.04 * i / n;
    const p = destination(obs.lat, obs.lon, azDeg, d);
    const h = dem.sample(p.lat, p.lon, d);
    if (h === h) out.push({ d, h, y: h - curvatureDrop(d) });
  }
  return out;
}

/* ---------- タップ地点の候補順位付け ---------- */
/* sAz, sEl: 方位・仰角の想定誤差[度](1σ相当)。z はその誤差で正規化したずれ */
function rankCandidates(analyzed, tapAz, tapElDeg, sAz, sEl) {
  const c = Math.cos(tapElDeg * D2R);
  const list = [];
  for (const p of analyzed) {
    if (!p) continue;
    const dAz = angDiff(p.az, tapAz), dEl = p.el * R2D - tapElDeg;
    const ang = Math.hypot(dAz * c, dEl);
    const z = Math.hypot(dAz * c / sAz, dEl / sEl);
    if (z > 5 && ang > 1.5) continue;
    let score = z;
    if (p.status === 'hidden') score += 100;
    else if (p.status === 'marginal') score += 0.5;
    // 稜線・尾根の輪郭上にない山頂(斜面の途中の地点)は、指した山である可能性を下げる
    if (p.outline === null) score += 1.5;
    list.push({ p, dAz, dEl, ang, z, score });
  }
  list.sort((a, b) => a.score - b.score);
  return list;
}
/* 確度の判定 */
function judge(ranked) {
  const vis = ranked.filter(r => r.p.status !== 'hidden');
  if (!vis.length) return { level: 'none', top: null };
  const top = vis[0], second = vis[1];
  if (top.z > 3) return { level: 'none', top };
  const sep = second ? second.score - top.score : Infinity;
  if (top.z <= 1.5 && sep >= 1.5 && top.p.status === 'visible') return { level: 'high', top, second, sep };
  if (top.z <= 2.5 && sep >= 0.7) return { level: 'mid', top, second, sep };
  return { level: 'low', top, second, sep };
}
/* 尾根の輪郭点を方位ごとに引けるよう並べ替える */
function indexRidges(pano) {
  const n = pano.n, cnt = new Int32Array(n + 1);
  for (const i of pano.ridgeIdx) cnt[i + 1]++;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const pos = cnt.slice(0, n), el = new Float32Array(pano.ridgeIdx.length), d = new Float32Array(pano.ridgeIdx.length);
  for (let k = 0; k < pano.ridgeIdx.length; k++) { const i = pano.ridgeIdx[k], j = pos[i]++; el[j] = pano.ridgeEl[k]; d[j] = pano.ridgeD[k]; }
  pano.ridges = { start: cnt, el, d };
}

/* ---------- カメラ投影 ---------- */
function makeCamera(o) {  // o: {yaw[deg], pitch[deg], roll[deg], F[px], cx, cy}
  const y = o.yaw * D2R, p = o.pitch * D2R, r = (o.roll || 0) * D2R;
  const sy = Math.sin(y), cy_ = Math.cos(y), sp = Math.sin(p), cp = Math.cos(p), sr = Math.sin(r), cr = Math.cos(r);
  const f = [sy * cp, cy_ * cp, sp];
  const r0 = [cy_, -sy, 0], u0 = [-sy * sp, -cy_ * sp, cp];
  const R = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
  const U = [u0[0] * cr + r0[0] * sr, u0[1] * cr + r0[1] * sr, u0[2] * cr + r0[2] * sr];
  const F = o.F, cx = o.cx, cyy = o.cy;
  return {
    o, F, cx, cy: cyy,
    project(azDeg, elRad) {
      const a = azDeg * D2R, ce = Math.cos(elRad);
      const dx = Math.sin(a) * ce, dy = Math.cos(a) * ce, dz = Math.sin(elRad);
      const zc = dx * f[0] + dy * f[1] + dz * f[2];
      if (zc <= 0.02) return null;
      return { x: cx + F * (dx * R[0] + dy * R[1] + dz * R[2]) / zc, y: cyy - F * (dx * U[0] + dy * U[1] + dz * U[2]) / zc };
    },
    unproject(x, yy) {
      const a = (x - cx) / F, b = (cyy - yy) / F;
      const v = [f[0] + a * R[0] + b * U[0], f[1] + a * R[1] + b * U[1], f[2] + a * R[2] + b * U[2]];
      const L = Math.hypot(v[0], v[1], v[2]);
      return { az: normAz(Math.atan2(v[0], v[1]) * R2D), el: Math.asin(v[2] / L) };   // el [rad]
    },
  };
}
/* 端末の傾き(DeviceOrientationのβ,γ)から背面カメラの仰角と回転を求める */
function cameraTiltFromOrientation(betaDeg, gammaDeg) {
  const b = betaDeg * D2R, g = gammaDeg * D2R;
  const cb = Math.cos(b), sb = Math.sin(b), sg = Math.sin(g), cg = Math.cos(g);
  return { pitch: Math.asin(Math.max(-1, Math.min(1, -cb * cg))) * R2D, roll: Math.atan2(cb * sg, sb) * R2D };
}
/* 35mm換算焦点距離 → 画像対角の焦点距離[px] */
function focalPxFrom35mm(f35, w, h) { return Math.hypot(w, h) * f35 / 43.2666; }
function focalPxFromFov(hfovDeg, w) { return (w / 2) / Math.tan(hfovDeg * D2R / 2); }

/* 磁北→真北の補正に使う偏角の概算値[度、西偏が正]。
   国土地理院 磁気図2020.0年値の近似式として知られる式。係数は公式資料で再確認していない。 */
function declinationJP(lat, lon) {
  const dp = lat - 37, dl = lon - 138;
  const min = 7 * 60 + 40.585 + 18.750 * dp - 6.761 * dl - 0.059 * dp * dp - 0.014 * dp * dl - 0.579 * dl * dl;
  return min / 60;
}

/* ---------- 写真の稜線との自動合わせ ---------- */
/* rgba(縮小画像)から、縦方向の明暗・色の変化が強い点(稜線の候補)と、各列での最近傍距離を求める */
function buildEdgeField(rgba, w, h) {
  const L = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b; B[i] = b - (r + g) / 2;
  }
  // 縦方向の差分(上下2px)
  const G = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const up = (y - 2) * w + x + dx, dn = (y + 2) * w + x + dx;
      s += Math.abs(L[up] - L[dn]) + 0.6 * Math.abs(B[up] - B[dn]);
    }
    G[y * w + x] = s / 3;
  }
  // 列ごとに、上位の強い変化を稜線候補にする(列内で非最大抑制)
  const vals = Array.from(G).filter(v => v > 0).sort((a, b) => a - b);
  const thr = Math.max(8, vals[Math.floor(vals.length * 0.9)] || 8);
  const cap = Math.round(h * 0.08);
  const dist = new Float32Array(w * h).fill(cap);
  for (let x = 0; x < w; x++) {
    // 縦方向の極大(平らに並ぶ場合はその中央)を稜線候補にする
    const edges = [];
    for (let y = 3; y < h - 3; y++) {
      const v = G[y * w + x];
      if (!(v >= thr && v >= G[(y - 1) * w + x] && v >= G[(y + 1) * w + x])) continue;
      let y2 = y;
      while (y2 + 1 < h - 3 && G[(y2 + 1) * w + x] === v) y2++;
      edges.push((y + y2) / 2);
      y = y2;
    }
    if (!edges.length) continue;
    let j = 0;
    for (let y = 0; y < h; y++) {
      while (j + 1 < edges.length && Math.abs(edges[j + 1] - y) <= Math.abs(edges[j] - y)) j++;
      dist[y * w + x] = Math.min(cap, Math.abs(edges[j] - y));
    }
  }
  return { w, h, dist, cap };
}
/* カメラ cam(縮小画像の座標系)で予測される稜線の y を列ごとに求める */
function predictSkylineColumns(pano, cam, w, h) {
  const ys = new Float32Array(w).fill(NaN);
  const halfFov = Math.atan((w / 2) / cam.F) * R2D + 3;
  const step = Math.min(0.1, Math.atan(1 / cam.F) * R2D);
  for (let da = -halfFov; da <= halfFov; da += step) {
    const az = cam.o.yaw + da, el = skyAt(pano, az);
    if (el !== el) continue;
    const p = cam.project(az, el);
    if (!p) continue;
    const x = Math.round(p.x);
    if (x < 0 || x >= w || p.y < 0 || p.y >= h) continue;
    if (ys[x] !== ys[x] || p.y < ys[x]) ys[x] = p.y;
  }
  // 丸め誤差で空いた数列ぶんの隙間を線形に埋める
  let last = -1;
  for (let x = 0; x < w; x++) {
    if (ys[x] !== ys[x]) continue;
    if (last >= 0 && x - last > 1 && x - last <= 4) for (let k = last + 1; k < x; k++) ys[k] = ys[last] + (ys[x] - ys[last]) * (k - last) / (x - last);
    last = x;
  }
  return ys;
}
function alignCost(field, ys) {
  let s = 0, n = 0, close = 0;
  for (let x = 0; x < field.w; x++) {
    const y = ys[x];
    if (y !== y) continue;
    // 距離場を上下で線形補間して、1画素未満のずれも評価する
    const yi = Math.max(0, y - 0.5);          // 画素の中心は +0.5 の位置
    const y0 = Math.min(field.h - 2, Math.floor(yi)), t = yi - y0;
    const v = field.dist[y0 * field.w + x] * (1 - t) + field.dist[(y0 + 1) * field.w + x] * t;
    s += v; n++; if (v <= 2) close++;
  }
  if (n < field.w * 0.3) return { cost: Infinity, cover: 0, n };
  return { cost: s / n, cover: close / n, n };
}
function autoAlign(pano, field, base, ranges) {
  // base: {yaw,pitch,roll,F} 縮小画像座標でのカメラ。ranges: {yaw, pitch}
  const w = field.w, h = field.h;
  const evalAt = (yaw, pitch) => {
    const cam = makeCamera({ yaw, pitch, roll: base.roll, F: base.F, cx: w / 2, cy: h / 2 });
    return alignCost(field, predictSkylineColumns(pano, cam, w, h));
  };
  const results = [];
  for (let dy = -ranges.yaw; dy <= ranges.yaw + 1e-9; dy += 0.5)
    for (let dp = -ranges.pitch; dp <= ranges.pitch + 1e-9; dp += 0.25) {
      const r = evalAt(base.yaw + dy, base.pitch + dp);
      results.push({ dy, dp, ...r });
    }
  results.sort((a, b) => a.cost - b.cost);
  let best = results[0];
  if (!best || best.cost === Infinity) return null;
  // 局所的に細かく詰める
  for (const [sy, sp] of [[0.2, 0.1], [0.05, 0.03]]) {
    let b2 = best;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const dy = best.dy + i * sy, dp = best.dp + j * sp;
      const r = evalAt(base.yaw + dy, base.pitch + dp);
      if (r.cost < b2.cost) b2 = { dy, dp, ...r };
    }
    best = b2;
  }
  // 2番目に良い別解(方位が2°以上離れたもの)と比べて、合わせの確かさを見る
  const rival = results.find(r => Math.abs(r.dy - best.dy) >= 2 && r.cost < Infinity);
  const costs = results.filter(r => r.cost < Infinity).map(r => r.cost).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)];
  return {
    dyaw: best.dy, dpitch: best.dp, cost: best.cost, cover: best.cover,
    rivalCost: rival ? rival.cost : Infinity, rivalDyaw: rival ? rival.dy : null, median,
    distinct: rival ? rival.cost / Math.max(best.cost, 0.3) : Infinity,
  };
}

/* ---------- EXIF(JPEG)の読み取り ---------- */
function parseExif(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off), len = v.getUint16(off + 2);
    if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
    if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
    off += 2 + len;
  }
  return null;
}
function readTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le), s32 = o => v.getInt32(o, le);
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const readIFD = (o) => {
    const tags = {};
    if (o + 2 > v.byteLength) return tags;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const size = (typeSize[type] || 1) * cnt;
      const vo = size <= 4 ? e + 8 : t + u32(e + 8);
      if (vo + size > v.byteLength) continue;
      let val;
      if (type === 2) { val = ''; for (let k = 0; k < cnt; k++) { const c = v.getUint8(vo + k); if (c) val += String.fromCharCode(c); } }
      else if (type === 3) val = cnt === 1 ? u16(vo) : Array.from({ length: cnt }, (_, k) => u16(vo + 2 * k));
      else if (type === 4) val = cnt === 1 ? u32(vo) : Array.from({ length: cnt }, (_, k) => u32(vo + 4 * k));
      else if (type === 5 || type === 10) {
        const rd = k => { const a = type === 5 ? u32(vo + 8 * k) : s32(vo + 8 * k), b = type === 5 ? u32(vo + 8 * k + 4) : s32(vo + 8 * k + 4); return b ? a / b : NaN; };
        val = cnt === 1 ? rd(0) : Array.from({ length: cnt }, (_, k) => rd(k));
      }
      else if (type === 1 || type === 7) val = cnt === 1 ? v.getUint8(vo) : Array.from({ length: Math.min(cnt, 64) }, (_, k) => v.getUint8(vo + k));
      else val = null;
      tags[tag] = val;
    }
    return tags;
  };
  const ifd0 = readIFD(t + u32(t + 4));
  const exif = ifd0[0x8769] ? readIFD(t + ifd0[0x8769]) : {};
  const gps = ifd0[0x8825] ? readIFD(t + ifd0[0x8825]) : {};
  const dms = a => Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : NaN;
  const out = {
    orientation: ifd0[0x0112] || 1,
    make: ifd0[0x010F] || '', model: ifd0[0x0110] || '',
    f35: exif[0xA405] || null, focal: exif[0x920A] || null,
    pxW: exif[0xA002] || null, pxH: exif[0xA003] || null,
    date: exif[0x9003] || ifd0[0x0132] || null,
  };
  if (gps[2] && gps[4]) {
    out.lat = dms(gps[2]) * (gps[1] === 'S' ? -1 : 1);
    out.lon = dms(gps[4]) * (gps[3] === 'W' ? -1 : 1);
    if (gps[6] != null) out.alt = gps[6] * (gps[5] === 1 ? -1 : 1);
    if (gps[0x11] != null) { out.dir = gps[0x11]; out.dirRef = gps[0x10] || 'T'; }
    if (gps[0x1F] != null) out.hErr = gps[0x1F];
  }
  return out;
}

const Core = {
  R_EARTH, REFRACTION_K, D2R, R2D, normAz, angDiff, distBearing, destination, curvatureDrop, apparentElev,
  lonToPx, latToPx, tilesForRadius, decodeGSI, decodeTerrarium, DEM, makeSteps, rayContext, marchRay,
  createPanorama, computePanoramaRange, skyAt, onOutline, analyzePeak, terrainAt, profile, rankCandidates, judge, indexRidges,
  makeCamera, cameraTiltFromOrientation, focalPxFrom35mm, focalPxFromFov, declinationJP,
  buildEdgeField, predictSkylineColumns, alignCost, autoAlign, parseExif,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);
