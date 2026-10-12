"""ブラウザ上での動作確認(合成データを国土地理院・Overpassの代わりに返す)"""
import asyncio, io, json, math, os, subprocess, sys, threading, http.server, functools
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SP = sys.argv[1]
MOUNTS = json.loads(subprocess.check_output(['node', '-e', "console.log(JSON.stringify(require('./test/scene.js').MOUNTS))"], cwd=ROOT))
TRUTH = json.load(open(os.path.join(SP, 'truth.json')))
OBS = (36.65, 138.19)
KX = 111320 * math.cos(OBS[0] * math.pi / 180); KY = 110540
LEAFLET = os.environ.get('LEAFLET_DIR', os.path.join(SP, 'npm/node_modules/leaflet/dist'))

FALLBACK = len(sys.argv) > 2 and sys.argv[2] == 'fallback'
VIEW = {'width': 1280, 'height': 800} if FALLBACK else {'width': 390, 'height': 844}

def terrain(lat, lon):
    h = 300.0
    for m in MOUNTS:
        dx = (lon - m['lon']) * KX; dy = (lat - m['lat']) * KY
        h += m['A'] * math.exp(-(dx * dx + dy * dy) / (m['sigma'] ** 2))
    return h

def dest(lat, lon, az, d):
    R = 6371008.8; p1 = math.radians(lat); l1 = math.radians(lon); th = math.radians(az); dr = d / R
    p2 = math.asin(math.sin(p1) * math.cos(dr) + math.cos(p1) * math.sin(dr) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(dr) * math.cos(p1), math.cos(dr) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)

# 表示から外れるべき山: 標高0mの登録、斜面の途中の名前付き地点、標高データが欠けた方向の山
EXTRA = []
_lat, _lon = dest(OBS[0], OBS[1], 250, 15500)
EXTRA.append({'name': '斜面の峰', 'lat': _lat, 'lon': _lon, 'ele': round(terrain(_lat, _lon))})
_lat, _lon = dest(OBS[0], OBS[1], 258, 18000)
EXTRA.append({'name': 'ゼロ山', 'lat': _lat, 'lon': _lon, 'ele': 0})
BROKEN_TILE = None

def tile_png(z, x, y, terrarium=False):
    n = 256 * 2 ** z
    px = np.arange(256) + 0.5
    gx = x * 256 + px; gy = y * 256 + px
    lon = gx / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * gy / n))))
    LON, LAT = np.meshgrid(lon, lat)
    h = np.full(LON.shape, 300.0)
    for m in MOUNTS:
        dx = (LON - m['lon']) * KX; dy = (LAT - m['lat']) * KY
        h += m['A'] * np.exp(-(dx * dx + dy * dy) / (m['sigma'] ** 2))
    if terrarium:
        v = h + 32768
        r_ = np.floor(v / 256); g_ = np.floor(v - r_ * 256); b_ = np.round((v - r_ * 256 - g_) * 256).clip(0, 255)
        rgb = np.stack([r_, g_, b_], axis=-1).astype(np.uint8)
    else:
        v = np.round(h * 100).astype(np.int64)
        rgb = np.stack([(v >> 16) & 255, (v >> 8) & 255, v & 255], axis=-1).astype(np.uint8)
    b = io.BytesIO(); Image.fromarray(rgb, 'RGB').save(b, 'PNG'); return b.getvalue()

def overpass_json():
    return json.dumps({'elements': [{'type': 'node', 'id': i + 1, 'lat': m['lat'], 'lon': m['lon'],
        'tags': {'natural': 'peak', 'name': m['name'], 'ele': str(round(m['ele']))}} for i, m in enumerate(MOUNTS + EXTRA)]})

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a: None
    s = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), h)
    threading.Thread(target=s.serve_forever, daemon=True).start()

async def route(r):
    u = r.request.url
    if FALLBACK and '/xyz/dem_png/' in u:
        return await r.abort()
    if FALLBACK and '/terrarium/' in u:
        z, x, y = u.split('/terrarium/')[1].replace('.png', '').split('/')
        return await r.fulfill(status=200, body=tile_png(int(z), int(x), int(y), True), headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png'})
    if '/xyz/dem_png/' in u and BROKEN_TILE and any(u.endswith(b) for b in BROKEN_TILE):
        return await r.fulfill(status=500, body=b'error')
    if '/xyz/dem_png/' in u:
        z, x, y = u.split('/xyz/dem_png/')[1].replace('.png', '').split('/')
        return await r.fulfill(status=200, body=tile_png(int(z), int(x), int(y)), headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png'})
    if 'overpass' in u:
        return await r.fulfill(status=200, body=overpass_json(), headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'})
    if 'cdnjs.cloudflare.com/ajax/libs/leaflet' in u:
        f = 'leaflet.css' if u.endswith('.css') else 'leaflet.js'
        return await r.fulfill(status=200, path=os.path.join(LEAFLET, f), headers={'Content-Type': 'text/css' if f.endswith('css') else 'application/javascript'})
    if '/xyz/std/' in u or '/xyz/pale/' in u:
        b = io.BytesIO(); Image.new('RGB', (256, 256), (230, 228, 220)).save(b, 'PNG')
        return await r.fulfill(status=200, body=b.getvalue(), headers={'Content-Type': 'image/png'})
    if u.startswith('http://127.0.0.1'):
        return await r.continue_()
    return await r.abort()

results = []
def check(cond, msg):
    results.append(cond); print(('OK  ' if cond else 'NG  ') + msg)

async def main():
    global BROKEN_TILE
    # 東の峰(東 12km)に向かう光線が通る z12 タイル
    # (細かいタイルが欠けても粗いタイルで補うので、両方を欠けさせる)
    la, lo = dest(OBS[0], OBS[1], 90, 6000)
    BROKEN_TILE = []
    for z in (12, 10):
        n = 256 * 2 ** z
        tx = int((lo + 180) / 360 * n / 256); s_ = math.sin(math.radians(la))
        ty = int((0.5 - math.log((1 + s_) / (1 - s_)) / (4 * math.pi)) * n / 256)
        BROKEN_TILE.append(f'/{z}/{tx}/{ty}.png')
    serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        ctx = await b.new_context(viewport=VIEW, device_scale_factor=2 if not FALLBACK else 1, is_mobile=not FALLBACK, has_touch=not FALLBACK,
                                  geolocation={'latitude': OBS[0], 'longitude': OBS[1], 'accuracy': 8}, permissions=['geolocation', 'camera'])
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        await page.route('**/*', route)
        await page.goto('http://127.0.0.1:8765/index.html')
        await page.screenshot(path=os.path.join(SP, 'shot_home.png'))

        # --- 写真から調べる ---
        await page.set_input_files('#fileInput', os.path.join(SP, 'photo.jpg'))
        await page.wait_for_function('window.__yama.S.ready && window.__yama.S.still.align', timeout=120000)
        st = await page.evaluate('({adj: window.__yama.S.still.adj, align: window.__yama.S.still.align, yaw0: window.__yama.S.still.yaw0})')
        print('    自動合わせ結果:', json.dumps({'adj': st['adj'], 'cover': st['align'].get('cover'), 'distinct': st['align'].get('distinct')}))
        check(st['align'].get('applied') and abs(st['adj']['yaw'] + 6) < 0.25 and abs(st['adj']['pitch'] - 1.5) < 0.25,
              f"写真のEXIF方位の6°ずれを自動で補正 (補正 {st['adj']['yaw']:.2f}°, 上下 {st['adj']['pitch']:.2f}°)")
        await page.screenshot(path=os.path.join(SP, 'shot_photo_aligned.png'))

        # 正解位置(画像座標)を画面座標に変換してタップ
        async def tap_peak(name, dy=6):
            t = next(t for t in TRUTH['truth'] if t['name'] == name)
            xy = await page.evaluate(f"window.__yama.imgToScreen({t['x']}, {t['y']})")
            await page.evaluate("document.querySelector('#sheet').dataset.n = 'old'")
            await page.mouse.click(xy[0], xy[1] + dy)
            await page.wait_for_function("!document.querySelector('#sheet').hidden && document.querySelector('#sheet').dataset.n !== 'old'")
            return await page.inner_text('#sheet h2'), await page.inner_text('#sheet .level')

        h2, lv = await tap_peak('テスト岳')
        check('テスト岳' in h2 and '高' in lv, f'テスト岳の山頂付近をタップ → 「{h2}」{lv}')
        await page.wait_for_selector('#map .leaflet-tooltip', timeout=20000)
        tips = await page.eval_on_selector_all('#map .leaflet-tooltip', 'els => els.map(e => e.textContent)')
        check(any('テスト岳' in t and '西南西' in t for t in tips) and any('あなた' in t for t in tips), f'判定結果の先頭に地図: {tips}')
        wedge = await page.evaluate("document.querySelectorAll('#map path.leaflet-interactive, #map svg path').length")
        check(wedge >= 2, f'地図に視線と写っている範囲を描画 (図形 {wedge} 個)')
        info = await page.evaluate('''(() => { const A = window.__yama.S.analyzed; const f = n => A.find(a => a.peak.name === n);
          return Object.fromEntries(['テスト岳','見本山','前山','隠れ山','東の峰','斜面の峰','ゼロ山'].map(n => { const a = f(n); return [n, a ? {label: a.label, status: a.status, outline: a.outline, valid: a.valid, miss: a.missingRatio} : null]; })); })()''')
        print('    山ごとの判定:', json.dumps(info, ensure_ascii=False))
        check(info['テスト岳']['label'] and info['見本山']['label'] and info['前山']['label'], '稜線上の見える山は山名を表示')
        check(not info['隠れ山']['label'], '隠れて見えない山は表示しない')
        check(not info['ゼロ山']['label'] and not info['ゼロ山']['valid'], '標高0mの山は表示も候補もしない')
        check(info['斜面の峰']['status'] == 'visible' and not info['斜面の峰']['label'], '斜面の途中の地点は山名を表示しない')
        txt = await page.inner_text('#sheet')
        if not FALLBACK:
            check(info['東の峰']['status'] == 'unknown' and not info['東の峰']['label'], '標高データが欠けた方向の山は「判定できない」として外す')
            check('取得できなかったタイル 2/' in txt, '計算の条件に標高データの欠けを表示')
        await page.screenshot(path=os.path.join(SP, 'shot_result' + ('_pc' if FALLBACK else '') + '.png'))
        src = await page.evaluate('window.__yama.S.demSource.name')
        print('    標高データ源:', src)
        if FALLBACK: check('Terrarium' in src, '国土地理院が取得できないとき Terrarium に切り替わる')
        await page.evaluate("document.querySelector('#sheet').scrollTop = 560")
        await page.wait_for_timeout(300)
        await page.screenshot(path=os.path.join(SP, 'shot_result_mid' + ('_pc' if FALLBACK else '') + '.png'))
        await page.evaluate("document.querySelector('#sheet').scrollTop = 99999")
        await page.wait_for_timeout(800)
        await page.screenshot(path=os.path.join(SP, 'shot_result_bottom.png'))
        txt = await page.inner_text('#sheet')
        h2h, lvh = await tap_peak('隠れ山', 0)
        txt = await page.inner_text('#sheet')
        check('隠れ山' not in h2h and '隠れ山' in txt and '隠れて見えない山が' in txt, f'隠れ山の位置をタップ → 「{h2h}」と判定し、隠れ山は隠れている旨だけ添える')
        rows = await page.eval_on_selector_all('#sheet table.cands button', 'els => els.map(e => e.textContent)')
        check('隠れ山' not in rows and 'ゼロ山' not in rows, f'候補一覧: {rows}')
        h2, lv = await tap_peak('見本山')
        check('見本山' in h2, f'見本山をタップ → 「{h2}」{lv}')
        h2, lv = await tap_peak('前山')
        check('前山' in h2, f'前山をタップ → 「{h2}」{lv}')
        # 空をタップ
        await page.evaluate("document.querySelector('#sheet').dataset.n = 'old'")
        sky = await page.evaluate("window.__yama.imgToScreen(800, 150)")
        await page.mouse.click(sky[0], sky[1])
        await page.wait_for_function("document.querySelector('#sheet').dataset.n !== 'old'")
        h2 = await page.inner_text('#sheet h2')
        check('空' in h2, f'空をタップ → 「{h2}」')

        # --- 地図ボタン ---
        await page.click('#sheetClose')
        await page.click('#btnMap')
        await page.wait_for_selector('#map .leaflet-tooltip', timeout=20000)
        tips = await page.eval_on_selector_all('#map .leaflet-tooltip', 'els => els.map(e => e.textContent)')
        check(set(['テスト岳', '見本山', '前山']) <= set(tips), f'地図ボタンで向いている方向の山を俯瞰表示: {tips}')
        await page.wait_for_timeout(1500)
        await page.screenshot(path=os.path.join(SP, 'shot_map.png'))
        await page.evaluate("document.querySelector('#sheet').scrollTop = 250")
        await page.wait_for_timeout(500)
        await page.screenshot(path=os.path.join(SP, 'shot_map2.png'))
        # --- ピンチで拡大: 画像と重ね表示が一緒に拡大され、合わせはずれない ---
        await page.click('#sheetClose')
        await page.evaluate('''() => { window.__pinch = (x, y, d0, d1, steps = 8) => {
          const t = document.querySelector('#overlay');
          const ev = (type, id, px, py) => t.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: px, clientY: py, bubbles: true, pointerType: 'touch' }));
          ev('pointerdown', 11, x - d0 / 2, y); ev('pointerdown', 12, x + d0 / 2, y);
          for (let i = 1; i <= steps; i++) { const d = d0 + (d1 - d0) * i / steps; ev('pointermove', 11, x - d / 2, y); ev('pointermove', 12, x + d / 2, y); }
          ev('pointerup', 11, x - d1 / 2, y); ev('pointerup', 12, x + d1 / 2, y);
        }; }''')
        t = next(t for t in TRUTH['truth'] if t['name'] == 'テスト岳')
        before = await page.evaluate('({adj: {...window.__yama.S.still.adj}, F: window.__yama.S.still.F})')
        sx, sy = await page.evaluate(f"window.__yama.imgToScreen({t['x']}, {t['y']})")
        await page.evaluate(f'window.__pinch({sx}, {sy}, 60, 180)')
        after = await page.evaluate('({adj: {...window.__yama.S.still.adj}, F: window.__yama.S.still.F, view: window.__yama.S.stillView})')
        sx2, sy2 = await page.evaluate(f"window.__yama.imgToScreen({t['x']}, {t['y']})")
        check(after['view'] and abs(after['view']['z'] - 3) < 0.05, f"2本指で約3倍に拡大 (×{after['view']['z']:.2f})" if after['view'] else '拡大されない')
        check(after['adj'] == before['adj'] and after['F'] == before['F'], '拡大しても稜線の合わせ(方位・上下・画角)は変わらない')
        check(abs(sx2 - sx) < 1.5 and abs(sy2 - sy) < 1.5, f'指の間にあった山頂が同じ画面位置に留まる (ずれ {abs(sx2 - sx):.2f}, {abs(sy2 - sy):.2f}px)')
        # 拡大後の表示上で山頂の位置に重ね表示(点)が描かれている
        px = await page.evaluate(f'''(() => {{ const c = document.querySelector('#overlay'), r = devicePixelRatio;
          const d = c.getContext('2d').getImageData(Math.round({sx2} * r) - 3, Math.round({sy2} * r) - 3, 7, 7).data; let m = 0;
          for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i + 3]); return m; }})()''')
        check(px > 200, f'拡大後も山頂の位置に印が重なる (不透明度 {px})')
        await page.screenshot(path=os.path.join(SP, 'shot_zoom.png'))
        h2, lv = await tap_peak('テスト岳', 0)
        check('テスト岳' in h2 and '高' in lv, f'拡大した状態でタップ → 「{h2}」{lv}')
        await page.click('#sheetClose')
        await page.click('#btnZoom')
        check(await page.evaluate('window.__yama.S.stillView') is None, '「等倍に戻す」で元の表示に戻る')
        # --- ライブ(偽カメラ + 方位イベント) ---
        if await page.evaluate("!document.querySelector('#sheet').hidden"): await page.click('#sheetClose')
        await page.click('#btnBack')
        await page.click('#btnLive')
        await page.evaluate("""setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, {alpha: 0, beta: 90, gamma: 0, webkitCompassHeading: 255 + 7.5, webkitCompassAccuracy: 10}); window.dispatchEvent(e); }, 50)""")
        await page.wait_for_function('window.__yama.S.ready && window.__yama.S.mode === "live"', timeout=120000)
        await page.wait_for_timeout(600)
        live = await page.evaluate('({h: window.__yama.S.sensor.heading, pitch: window.__yama.S.sensor.pitch, pos: window.__yama.S.pos})')
        check(abs(live['h'] - (255 + 7.5 - 7.55)) < 0.3 and abs(live['pitch']) < 0.1, f"コンパス値(磁北)を真北に補正: {live['h']:.2f}°")
        await page.screenshot(path=os.path.join(SP, 'shot_live.png'))
        off0 = await page.evaluate('({...window.__yama.S.liveOffset})')
        await page.evaluate('window.__pinch(195, 420, 80, 200)')
        lz = await page.evaluate('({z: window.__yama.S.liveZoom, tf: document.querySelector("#video").style.transform, off: {...window.__yama.S.liveOffset}})')
        check(abs(lz['z'] - 2.5) < 0.05 and 'scale(2.5' in lz['tf'] and lz['off'] == off0, f"ライブ映像も2本指で拡大し、方位の補正は変わらない (×{lz['z']:.2f})")
        await page.wait_for_timeout(300)
        await page.screenshot(path=os.path.join(SP, 'shot_live_zoom.png'))
        await page.click('#btnShutter')
        await page.wait_for_timeout(1500)
        check(await page.evaluate('window.__yama.S.mode') == 'still', 'シャッターで静止画に切り替わる')
        await page.screenshot(path=os.path.join(SP, 'shot_live_frozen.png'))
        # --- 方位の記録がない写真: 全方位で照合 ---
        await page.click('#btnBack'); await page.wait_for_timeout(300)
        if await page.evaluate('window.__yama.S.mode') != 'home': await page.click('#btnBack')
        import time; t0 = time.time()
        await page.set_input_files('#fileInput', os.path.join(SP, 'photo_nodir.jpg'))
        await page.wait_for_function('window.__yama.S.still && window.__yama.S.still.src === "photo" && window.__yama.S.still.align', timeout=180000)
        st = await page.evaluate('({adj: window.__yama.S.still.adj, yaw0: window.__yama.S.still.yaw0, align: window.__yama.S.still.align})')
        yaw = (st['yaw0'] + st['adj']['yaw']) % 360
        check(st['align'].get('applied') and abs(yaw - 255) < 0.3, f"方位の記録がない写真でも全方位照合で向きを特定 ({yaw:.2f}°, {time.time() - t0:.1f}秒)")
        # --- 位置情報がない写真: 撮影地点の入力 ---
        await page.set_input_files('#fileInput', os.path.join(SP, 'photo_nogps.jpg'))
        await page.wait_for_selector('#latlon')
        await page.fill('#latlon', '36.65, 138.19')
        await page.click('#useLatLon')
        await page.wait_for_function('window.__yama.S.still && window.__yama.S.still.align', timeout=180000)
        st = await page.evaluate('({adj: window.__yama.S.still.adj, yaw0: window.__yama.S.still.yaw0, align: window.__yama.S.still.align, src: window.__yama.S.pos.src})')
        yaw = (st['yaw0'] + st['adj']['yaw']) % 360
        check(st['src'] == 'manual' and st['align'].get('applied') and abs(yaw - 255) < 0.3, f"位置情報がない写真は緯度経度の入力で判定 ({yaw:.2f}°)")
        check(not errors, 'ページのエラーなし' + ('' if not errors else ': ' + ' / '.join(errors[:5])))
        await b.close()
    print('\nすべて成功' if all(results) else f'\n{results.count(False)}件 失敗')

asyncio.run(main())
