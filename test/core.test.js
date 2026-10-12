/* 合成地形による判定ロジックの検証 */
const C = require('../src/core.js');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK  ' : 'NG  ') + msg); if (!cond) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 観測地点(長野市付近を想定した任意の座標)
const OBS = { lat: 36.65, lon: 138.19 };

// 合成地形: 円錐状の山を並べる
function makeTerrain(mounts) {
  return (lat, lon) => {
    let h = 350;
    for (const m of mounts) {
      const { d } = C.distBearing(lat, lon, m.lat, m.lon);
      h = Math.max(h, m.h - d * m.slope);
    }
    return h;
  };
}
function buildDEM(fn, maxDist) {
  const tiers = [{ z: 14, maxDist: 3000 }, { z: 12, maxDist: 25000 }, { z: 10, maxDist: maxDist }];
  const dem = new C.DEM(tiers);
  for (const t of tiers) {
    for (const tile of C.tilesForRadius(OBS.lat, OBS.lon, t.maxDist, t.z)) {
      const arr = new Float32Array(65536);
      const n = 256 * 2 ** t.z;
      for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
        const gx = tile.x * 256 + px + 0.5, gy = tile.y * 256 + py + 0.5;
        const lon = gx / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / n))) * 180 / Math.PI;
        arr[py * 256 + px] = fn(lat, lon);
      }
      dem.setTile(t.z, tile.x, tile.y, arr);
    }
  }
  return dem;
}

// --- 1. 測地計算 ---
{
  const p = C.destination(OBS.lat, OBS.lon, 47.3, 51234);
  const r = C.distBearing(OBS.lat, OBS.lon, p.lat, p.lon);
  ok(near(r.d, 51234, 1) && near(r.az, 47.3, 0.01), `destination/distBearing 往復 (d=${r.d.toFixed(1)}, az=${r.az.toFixed(3)})`);
  // 地球の丸み: 100km先で約 (1-0.13)*100000^2/(2R) ≒ 683m 下がる
  ok(near(C.curvatureDrop(100000), 682.8, 1), `100km先の見かけの沈み込み ${C.curvatureDrop(100000).toFixed(1)}m`);
}

// --- 2. 見通し判定 ---
const far = { ...C.destination(OBS.lat, OBS.lon, 30, 40000), h: 2500, slope: 0.25, name: '遠い山' };
const nearHill = { ...C.destination(OBS.lat, OBS.lon, 30, 4000), h: 900, slope: 0.3, name: '手前の丘' };
const side = { ...C.destination(OBS.lat, OBS.lon, 80, 25000), h: 1800, slope: 0.25, name: '横の山' };
{
  const terrain = makeTerrain([far, nearHill, side]);
  const dem = buildDEM(terrain, 60000);
  const h0 = dem.sampleFinest(OBS.lat, OBS.lon) + 1.6;
  ok(near(h0, 351.6, 0.5), `観測者の高さ ${h0.toFixed(1)}m`);
  const obs = { ...OBS, h: h0 };
  const ctx = C.rayContext(dem, obs, 60000);
  const aFar = C.analyzePeak(dem, obs, ctx, { lat: far.lat, lon: far.lon, ele: 2500, name: far.name });
  const aHill = C.analyzePeak(dem, obs, ctx, { lat: nearHill.lat, lon: nearHill.lon, ele: 900, name: nearHill.name });
  const aSide = C.analyzePeak(dem, obs, ctx, { lat: side.lat, lon: side.lon, ele: 1800, name: side.name });
  // 手前の丘: 4km先で +548m → 約7.8°。遠い山: 40km先で +2148m - 110m → 約2.9°。遠い山は隠れる
  console.log('    遠い山 el=%s° 手前の最大=%s°', (aFar.el * C.R2D).toFixed(2), (aFar.blocker.el * C.R2D).toFixed(2));
  ok(aFar.status === 'hidden', `手前の丘に隠れる山を「隠れる」と判定 (${aFar.status})`);
  ok(aHill.status === 'visible', `手前の丘は「見える」 (${aHill.status})`);
  ok(aSide.status === 'visible', `別方向の山は「見える」 (${aSide.status})`);
  ok(near(aSide.az, 80, 0.01) && near(aSide.d, 25000, 2), `方位・距離 az=${aSide.az.toFixed(3)} d=${aSide.d.toFixed(0)}`);
  const expect = Math.atan2(1800 - h0 - C.curvatureDrop(25000), 25000) * C.R2D;
  ok(near(aSide.el * C.R2D, expect, 1e-6), `仰角 ${(aSide.el * C.R2D).toFixed(3)}°`);

  // パノラマ: 方位80°の稜線は横の山頂の仰角とほぼ一致
  const pano = C.createPanorama(dem, obs, 60000, 0.1);
  const t0 = Date.now();
  C.computePanoramaRange(dem, pano, 0, pano.n);
  C.indexRidges(pano);
  console.log('    パノラマ計算 %d ms (合成データ, 3600方位)', Date.now() - t0);
  const sky80 = C.skyAt(pano, 80) * C.R2D;
  ok(near(sky80, expect, 0.05), `方位80°の稜線 ${sky80.toFixed(3)}° ≒ 山頂 ${expect.toFixed(3)}°`);
  const i30 = Math.round(30 / 0.1);
  ok(near(pano.skyD[i30], 4000, 150), `方位30°の稜線は手前の丘 (距離 ${pano.skyD[i30].toFixed(0)}m)`);

  // タップ地点: 横の山の山頂方向をタップ → 最有力候補は横の山
  const ranked = C.rankCandidates([aFar, aHill, aSide], 80.2, expect - 0.1, 0.4, 0.4);
  const j = C.judge(ranked);
  ok(j.top && j.top.p.peak.name === '横の山' && j.level === 'high', `タップ判定: ${j.top && j.top.p.peak.name} / 確度 ${j.level}`);
  // 隠れている遠い山の方向をタップ → 遠い山は選ばれない
  const r2 = C.rankCandidates([aFar, aHill, aSide], 30, aFar.el * C.R2D, 0.4, 0.4);
  const j2 = C.judge(r2);
  ok(!j2.top || j2.top.p.peak.name !== '遠い山', `隠れた山は候補の首位にならない (首位: ${j2.top ? j2.top.p.peak.name : 'なし'})`);
  // 見えている地形の点
  const tp = C.terrainAt(dem, obs, ctx, 30, aHill.el - 0.002, 60000);
  ok(tp && !tp.sky && near(tp.d, 4000, 300), `方位30°で見えている地形は約4km先 (${tp && tp.d.toFixed(0)}m)`);

  // --- 4. 自動合わせ ---
  const W = 640, H = 480, hfov = 60;
  const F = C.focalPxFromFov(hfov, W);
  const truth = { yaw: 70, pitch: 1.2, roll: 0, F, cx: W / 2, cy: H / 2 };
  const cam = C.makeCamera(truth);
  const ys = C.predictSkylineColumns(pano, cam, W, H);
  const rgba = new Uint8ClampedArray(W * H * 4);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sky = !(ys[x] <= y + 0.5);
    const i = (y * W + x) * 4;
    const n = (rnd() - 0.5) * 20;
    if (sky) { rgba[i] = 150 + n; rgba[i + 1] = 190 + n; rgba[i + 2] = 235 + n; }
    else { rgba[i] = 70 + n; rgba[i + 1] = 90 + n; rgba[i + 2] = 80 + n; }
    rgba[i + 3] = 255;
  }
  const field = C.buildEdgeField(rgba, W, H);
  const t1 = Date.now();
  const res = C.autoAlign(pano, field, { yaw: truth.yaw + 7, pitch: truth.pitch - 2.5, roll: 0, F }, { yaw: 20, pitch: 6 });
  console.log('    自動合わせ %d ms, 補正 yaw %s° pitch %s°, 一致率 %s, 別解比 %s', Date.now() - t1,
    res.dyaw.toFixed(2), res.dpitch.toFixed(2), res.cover.toFixed(2), res.distinct.toFixed(2));
  ok(near(res.dyaw, -7, 0.15) && near(res.dpitch, 2.5, 0.1), '自動合わせで方位7°・仰角2.5°のずれを補正');
}

// --- 2b. 重なった尾根の輪郭 ---
{
  const front = { ...C.destination(OBS.lat, OBS.lon, 200, 10000), h: 1200, slope: 0.2 };
  const back = { ...C.destination(OBS.lat, OBS.lon, 200, 40000), h: 4500, slope: 0.2 };
  const dem = buildDEM(makeTerrain([front, back]), 60000);
  const obs = { ...OBS, h: dem.sampleFinest(OBS.lat, OBS.lon) + 1.6 };
  const pano = C.createPanorama(dem, obs, 60000, 0.5);
  C.computePanoramaRange(dem, pano, 0, pano.n);
  C.indexRidges(pano);
  const i = Math.round(200 / 0.5), s0 = pano.ridges.start[i], s1 = pano.ridges.start[i + 1];
  const ds = Array.from(pano.ridges.d.slice(s0, s1)).map(v => Math.round(v));
  ok(ds.some(v => Math.abs(v - 10000) < 300) && Math.abs(pano.skyD[i] - 40000) < 400,
    `手前の尾根(10km)の輪郭と、奥の山(40km)の稜線を両方検出 (輪郭 ${ds.join(',')}m / 稜線 ${pano.skyD[i].toFixed(0)}m)`);
}

// --- 3. 投影 ---
{
  const cam = C.makeCamera({ yaw: 123.4, pitch: 3, roll: -8, F: 1500, cx: 960, cy: 720 });
  const p = cam.project(140, 2 * C.D2R);
  const q = cam.unproject(p.x, p.y);
  ok(near(q.az, 140, 1e-6) && near(q.el * C.R2D, 2, 1e-6), `投影→逆投影の往復 (az=${q.az.toFixed(6)})`);
  const c = cam.project(123.4, 3 * C.D2R);
  ok(near(c.x, 960, 1e-6) && near(c.y, 720, 1e-6), '視線中央は画像中心');
  const t = C.cameraTiltFromOrientation(90, 0);
  ok(near(t.pitch, 0, 1e-9) && near(t.roll, 0, 1e-9), '縦持ち垂直: 仰角0° 回転0°');
  const t2 = C.cameraTiltFromOrientation(100, 0);
  ok(near(t2.pitch, 10, 1e-6), `上端を奥へ10°倒す→カメラは上を向く (${t2.pitch.toFixed(3)}°)`);
  const t3 = C.cameraTiltFromOrientation(80, 90);
  ok(near(t3.roll, 10, 1e-6) && near(t3.pitch, 0, 1e-6), `時計回り10°回転 (${t3.roll.toFixed(3)}°)`);
  ok(near(C.declinationJP(36.65, 138.19), 7.7, 0.6), `長野付近の偏角 ${C.declinationJP(36.65, 138.19).toFixed(2)}°`);
}

process.exitCode = fails ? 1 : 0;
console.log(fails ? `\n${fails}件 失敗` : '\nすべて成功');
