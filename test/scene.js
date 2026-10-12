/* E2Eテスト用の合成地形(Python側 e2e.py と同じ式)と、そこから「写真」を描く */
const C = require('../src/core.js');
const OBS = { lat: 36.65, lon: 138.19 };
const MOUNTS = [
  { name: 'テスト岳', az: 250, d: 18000, A: 2100, sigma: 3000 },
  { name: '見本山', az: 270, d: 30000, A: 2600, sigma: 4000 },
  { name: '前山', az: 262, d: 6000, A: 600, sigma: 1200 },
  { name: '隠れ山', az: 249, d: 40000, A: 1700, sigma: 2500 },
  { name: '東の峰', az: 90, d: 12000, A: 1200, sigma: 2000 },
];
for (const m of MOUNTS) Object.assign(m, C.destination(OBS.lat, OBS.lon, m.az, m.d), { ele: 300 + m.A });
const KX = 111320 * Math.cos(OBS.lat * Math.PI / 180), KY = 110540;
function terrain(lat, lon) {
  let h = 300;
  for (const m of MOUNTS) {
    const dx = (lon - m.lon) * KX, dy = (lat - m.lat) * KY;
    h += m.A * Math.exp(-(dx * dx + dy * dy) / (m.sigma * m.sigma));
  }
  return Math.round(h * 100) / 100;
}
module.exports = { OBS, MOUNTS, terrain };

if (require.main === module) {
  // 写真を描く: 真の向き 255°、上向き 1.5°。EXIFには 261°(6°ずれ)を書く
  const fs = require('fs');
  const W = 1600, H = 1200, f35 = 26;
  const F = C.focalPxFrom35mm(f35, W, H);
  const maxDist = 120000;
  const dem = new C.DEM([{ z: 14, maxDist: 3000 }, { z: 12, maxDist: 25000 }, { z: 10, maxDist }]);
  for (const t of dem.tiers) for (const tile of C.tilesForRadius(OBS.lat, OBS.lon, t.maxDist, t.z)) {
    const arr = new Float32Array(65536), n = 256 * 2 ** t.z;
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const gx = tile.x * 256 + px + 0.5, gy = tile.y * 256 + py + 0.5;
      arr[py * 256 + px] = terrain(Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / n))) * 180 / Math.PI, gx / n * 360 - 180);
    }
    dem.setTile(t.z, tile.x, tile.y, arr);
  }
  const obs = { ...OBS, h: dem.sampleFinest(OBS.lat, OBS.lon) + 1.6 };
  const pano = C.createPanorama(dem, obs, maxDist, 0.1);
  C.computePanoramaRange(dem, pano, 0, pano.n); C.indexRidges(pano);
  const cam = C.makeCamera({ yaw: 255, pitch: 1.5, roll: 0, F, cx: W / 2, cy: H / 2 });
  const ys = C.predictSkylineColumns(pano, cam, W, H);
  const buf = Buffer.alloc(W * H * 3);
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sky = !(ys[x] <= y + 0.5), i = (y * W + x) * 3, n = (rnd() - 0.5) * 18;
    if (sky) { const t = y / H; buf[i] = 120 + 60 * t + n; buf[i + 1] = 165 + 40 * t + n; buf[i + 2] = 225 + 15 * t + n; }
    else { const t = Math.min(1, (y - ys[x]) / 300); buf[i] = 90 - 40 * t + n; buf[i + 1] = 105 - 35 * t + n; buf[i + 2] = 120 - 50 * t + n; }
  }
  fs.writeFileSync(process.argv[2], buf);
  // 正解: 各山頂の画像上の位置
  const truth = MOUNTS.map(m => {
    const a = C.analyzePeak(dem, obs, pano.ctx, { lat: m.lat, lon: m.lon, ele: m.ele, name: m.name });
    const p = cam.project(a.az, a.el);
    return { name: m.name, status: a.status, x: p && p.x, y: p && p.y };
  });
  fs.writeFileSync(process.argv[3], JSON.stringify({ W, H, f35, truth }, null, 1));
  console.log(JSON.stringify(truth));
}
