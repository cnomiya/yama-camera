import json, subprocess, sys
from PIL import Image
from PIL.TiffImagePlugin import IFDRational as R
SP = sys.argv[1]
subprocess.check_call(['node', 'test/scene.js', f'{SP}/photo.rgb', f'{SP}/truth.json'], stdout=subprocess.DEVNULL)
t = json.load(open(f'{SP}/truth.json'))
img = Image.frombytes('RGB', (t['W'], t['H']), open(f'{SP}/photo.rgb', 'rb').read())
ex = Image.Exif(); ex[0x010F] = 'Apple'; ex[0x0110] = 'iPhone 15'; ex[0x8769] = {0xA405: 26}
def dms(v):
    d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
    return (R(d, 1), R(m, 1), R(int(round(s * 10000)), 10000))
# 方位は真値255°に対して6°ずらした261°を記録
ex[0x8825] = {1: 'N', 2: dms(36.65), 3: 'E', 4: dms(138.19), 0x10: 'T', 0x11: R(26100, 100), 0x1F: R(5, 1)}
img.save(f'{SP}/photo.jpg', quality=88, exif=ex.tobytes())
print('photo.jpg ok')
ex2 = Image.Exif(); ex2[0x8769] = {0xA405: 26}
ex2[0x8825] = {1: 'N', 2: dms(36.65), 3: 'E', 4: dms(138.19)}
img.save(f'{SP}/photo_nodir.jpg', quality=88, exif=ex2.tobytes())
img.save(f'{SP}/photo_nogps.jpg', quality=88)
print('variants ok')
