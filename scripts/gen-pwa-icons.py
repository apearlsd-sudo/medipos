#!/usr/bin/env python3
"""MediPOS Pro — PWA icon generation (teal pharmacy theme).
Draws a teal gradient rounded square with a white pharmacy cross and pill cap,
in regular (safe padding) and maskable (full-bleed) variants."""
from PIL import Image, ImageDraw
import os

OUT = "/home/z/my-project/public"
os.makedirs(OUT, exist_ok=True)

TEAL_TOP = (13, 148, 136)    # teal-600
TEAL_BOT = (15, 118, 110)    # teal-700
WHITE = (255, 255, 255)

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

BG = hex_to_rgb('#0d9488')

def rounded_gradient(size, radius_ratio, bg_mode):
    S = size * 4  # supersample for smooth edges
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(S * radius_ratio)
    # vertical gradient background
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        r = int(TEAL_TOP[0] + (TEAL_BOT[0] - TEAL_TOP[0]) * t)
        g = int(TEAL_TOP[1] + (TEAL_BOT[1] - TEAL_TOP[1]) * t)
        b = int(TEAL_TOP[2] + (TEAL_BOT[2] - TEAL_TOP[2]) * t)
        gd.line([(0, y), (S, y)], fill=(r, g, b, 255))
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    # white pharmacy cross, centered, sized per background mode
    arm = S * (0.17 if bg_mode == 'safe' else 0.13)   # half-width of cross arm
    cx = cy = S / 2
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([cx - arm, cy - arm * 2.6, cx + arm, cy + arm * 2.6], radius=int(arm * 0.45), fill=WHITE)
    d.rounded_rectangle([cx - arm * 2.6, cy - arm, cx + arm * 2.6, cy + arm], radius=int(arm * 0.45), fill=WHITE)
    # small pill dot accent top-right of cross
    pr = S * (0.055 if bg_mode == 'safe' else 0.045)
    px, py = cx + arm * 3.2, cy - arm * 3.2
    d.ellipse([px - pr, py - pr, px + pr, py + pr], fill=(240, 253, 250, 255))
    return img.resize((size, size), Image.LANCZOS)

def maskable(size):
    """Full-bleed square background + smaller cross inside the 80% safe zone."""
    S = size * 4
    img = Image.new('RGBA', (S, S), BG + (255,))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        r = int(TEAL_TOP[0] + (TEAL_BOT[0] - TEAL_TOP[0]) * t)
        g = int(TEAL_TOP[1] + (TEAL_BOT[1] - TEAL_TOP[1]) * t)
        b = int(TEAL_TOP[2] + (TEAL_BOT[2] - TEAL_TOP[2]) * t)
        gd.line([(0, y), (S, y)], fill=(r, g, b, 255))
    img.paste(grad, (0, 0))
    d = ImageDraw.Draw(img)
    arm = S * 0.11  # smaller so it sits inside the maskable safe zone
    cx = cy = S / 2
    d.rounded_rectangle([cx - arm, cy - arm * 2.6, cx + arm, cy + arm * 2.6], radius=int(arm * 0.45), fill=WHITE)
    d.rounded_rectangle([cx - arm * 2.6, cy - arm, cx + arm * 2.6, cy + arm], radius=int(arm * 0.45), fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)

# Regular icons (transparent corners, rounded square)
for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')]:
    rounded_gradient(size, 0.22, 'safe').save(f'{OUT}/{name}')
    print('wrote', name)

# Maskable 512 (full-bleed)
maskable(512).save(f'{OUT}/icon-maskable-512.png')
print('wrote icon-maskable-512.png')
print('done')
