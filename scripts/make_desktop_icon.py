#!/usr/bin/env python3
"""MediPOS Pro desktop icon set -> desktop-assets/
Teal gradient rounded square + white pharmacy cross (matches login product tile:
from-teal-400 to-teal-600, white Activity glyph). Outputs icon.png (512), the
multi-resolution icon.ico for NSIS, and a 32px tray.png.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = '/home/z/my-project/desktop-assets'
os.makedirs(OUT, exist_ok=True)

# teal-400 #2dd4bf -> teal-600 #0d9488 diagonal gradient on 512 canvas
SZ = 512
img = Image.new('RGBA', (SZ, SZ), (0, 0, 0, 0))
grad = Image.new('RGBA', (SZ, SZ))
c1, c2 = (0x5e, 0xee, 0xd6), (0x0d, 0x94, 0x88)  # lighter teal-300 -> teal-600
px = grad.load()
for y in range(SZ):
    for x in range(SZ):
        t = (x + y) / (2 * SZ - 2)
        px[x, y] = (
            int(c1[0] + (c2[0] - c1[0]) * t),
            int(c1[1] + (c2[1] - c1[1]) * t),
            int(c1[2] + (c2[2] - c1[2]) * t),
            255,
        )

# rounded-rect mask (~22% corner radius)
mask = Image.new('L', (SZ, SZ), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([0, 0, SZ - 1, SZ - 1], radius=int(SZ * 0.215), fill=255)
img.paste(grad, (0, 0), mask)

# white pharmacy cross with soft teal shadow underneath
cx = cy = SZ // 2
arm = int(SZ * 0.115)      # half-thickness of cross arms
reach = int(SZ * 0.175)    # half-length of cross
r = int(SZ * 0.045)        # corner radius on cross arms

sh = Image.new('RGBA', (SZ, SZ), (0, 0, 0, 0))
dsh = ImageDraw.Draw(sh)
dsh.rounded_rectangle([cx - reach + 6, cy - arm + 8, cx + reach + 6, cy + arm + 8], radius=r, fill=(15, 118, 110, 110))
dsh.rounded_rectangle([cx - arm + 6, cy - reach + 8, cx + arm + 6, cy + reach + 8], radius=r, fill=(15, 118, 110, 110))
sh = sh.filter(ImageFilter.GaussianBlur(5))
img = Image.alpha_composite(img, sh)

dr = ImageDraw.Draw(img)
white = (255, 255, 255, 255)
dr.rounded_rectangle([cx - reach, cy - arm, cx + reach, cy + arm], radius=r, fill=white)
dr.rounded_rectangle([cx - arm, cy - reach, cx + arm, cy + reach], radius=r, fill=white)

master = img

master.resize((512, 512), Image.LANCZOS).save(f'{OUT}/icon.png')
master.save(f'{OUT}/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
master.resize((32, 32), Image.LANCZOS).save(f'{OUT}/tray.png')

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
