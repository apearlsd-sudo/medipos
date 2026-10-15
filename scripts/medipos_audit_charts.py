#!/usr/bin/env python3
"""Charts for the MediPOS Pro Feature Gap Analysis report.

Palette: Template 07 'Crystal Blue' body subset (fixed palette per cover.md —
documented exception to palette.cascade). One blue hue family (~215):
  HEADER_FILL #1a4a7a | ACCENT #2d7ab3 | light #4da8da / #7fb3d6 | BORDER #c0d0e2
Text #142840, muted #5a7a96.
Chart rules applied (typesetting/charts.md): top/right spines deleted, values
labeled -> no grid, horizontal bars for long labels, legend outside & frameless.
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.font_manager as fm
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

import matplotlib.pyplot as plt
import numpy as np
import os

plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams['text.color'] = '#142840'
plt.rcParams['axes.labelcolor'] = '#142840'
plt.rcParams['xtick.color'] = '#5a7a96'
plt.rcParams['ytick.color'] = '#142840'

OUT = '/home/z/my-project/scripts/assets'
os.makedirs(OUT, exist_ok=True)

DEEP = '#1a4a7a'    # HEADER_FILL (M tier)
ACCENT = '#2d7ab3'  # ACCENT (XS tier)
LIGHT = '#7fb3d6'   # same-hue light series
PALE = '#c0d0e2'    # BORDER (S tier)
MUTED = '#5a7a96'

# ────────────────────────────────────────────────────────────────────
# Chart 1 — Capability maturity scorecard (horizontal bars)
# ────────────────────────────────────────────────────────────────────
areas = [
    ('Shifts & Cash Control', 9.0),
    ('Security, Roles & Audit', 9.0),
    ('POS & Checkout', 8.5),
    ('Multi-Branch & Offline Sync', 8.5),
    ('Platform Resilience (PWA, Backups)', 8.5),
    ('Inventory Management', 8.0),
    ('Reports & Analytics', 7.5),
    ('Customers & Loyalty', 7.0),
    ('Purchasing & Suppliers', 7.0),
    ('Notifications & Messaging', 7.0),
    ('Tax & Compliance', 6.5),
    ('Expenses & Finance', 6.5),
]
areas_sorted = sorted(areas, key=lambda r: r[1])
labels = [a[0] for a in areas_sorted]
scores = [a[1] for a in areas_sorted]
colors = [DEEP if s >= 8.5 else (ACCENT if s >= 7.0 else LIGHT) for s in scores]

fig, ax = plt.subplots(figsize=(8.6, 4.6), dpi=200, constrained_layout=True)
bars = ax.barh(labels, scores, color=colors, height=0.62, edgecolor='none', zorder=3)
for bar, s in zip(bars, scores):
    ax.text(bar.get_width() + 0.12, bar.get_y() + bar.get_height() / 2,
            f'{s:.1f}', va='center', ha='left', fontsize=10, color='#142840')
ax.set_xlim(0, 10)
ax.set_xticks([0, 2, 4, 6, 8, 10])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['left'].set_visible(False)
ax.spines['bottom'].set_color(PALE)
ax.tick_params(axis='y', length=0, labelsize=10)
ax.tick_params(axis='x', labelsize=9)
ax.set_xlabel('Maturity score (out of 10)', fontsize=9, color=MUTED)
fig.savefig(f'{OUT}/chart_maturity.png')
plt.close(fig)
print('chart_maturity.png done')

# ────────────────────────────────────────────────────────────────────
# Chart 2 — Impact × Effort quadrant (25 numbered opportunities)
# ────────────────────────────────────────────────────────────────────
# (id, impact L/M/H, effort S/M/L)  impact: L=1 M=2 H=3   effort: S=1 M=2 L=3
feats = [
    (1, 3, 1), (2, 3, 2), (3, 3, 2), (4, 3, 2), (5, 3, 2), (6, 2, 1),
    (7, 2, 1), (8, 2, 1), (9, 2, 1), (10, 2, 2), (11, 2, 1), (12, 2, 1),
    (13, 3, 3), (14, 2, 2), (15, 2, 1), (16, 2, 1), (17, 2, 2), (18, 3, 3),
    (19, 3, 3), (20, 2, 2), (21, 1, 2), (22, 2, 3), (23, 1, 2), (24, 1, 2),
    (25, 1, 1),
]
NOW_SET = {1, 2, 3, 4, 5, 6, 8, 9}

# Spread points that share the same cell on a mini-grid (anti-overlap)
cells = {}
for fid, imp, eff in feats:
    cells.setdefault((eff, imp), []).append(fid)

offsets = {}
for (eff, imp), ids in cells.items():
    n = len(ids)
    if n == 1:
        offsets[ids[0]] = (0.0, 0.0)
        continue
    ncols = 3 if n > 4 else 2 if n > 1 else 1
    nrows = int(np.ceil(n / ncols))
    dx, dy = 0.21, 0.21
    for i, fid in enumerate(ids):
        r, c = divmod(i, ncols)
        ox = (c - (ncols - 1) / 2) * dx
        oy = ((nrows - 1) / 2 - r) * dy
        offsets[fid] = (ox, oy)

fig, ax = plt.subplots(figsize=(8.6, 5.6), dpi=200, constrained_layout=True)
# Quadrant dividers
for v in (1.5, 2.5):
    ax.axvline(v, color=PALE, linestyle='--', linewidth=0.9, zorder=1)
    ax.axhline(v, color=PALE, linestyle='--', linewidth=0.9, zorder=1)
# Quadrant labels (corners, muted)
qstyle = dict(fontsize=10, color=MUTED, fontweight='bold', alpha=0.75, zorder=2)
ax.text(0.62, 3.40, 'QUICK WINS', ha='left', va='top', **qstyle)
ax.text(3.38, 3.40, 'STRATEGIC BETS', ha='right', va='top', **qstyle)
ax.text(0.62, 0.62, 'FILL-INS', ha='left', va='bottom', **qstyle)
ax.text(3.38, 0.62, 'DEFER', ha='right', va='bottom', **qstyle)

for fid, imp, eff in feats:
    ox, oy = offsets[fid]
    x, y = eff + ox, imp + oy
    is_now = fid in NOW_SET
    ax.scatter(x, y, s=150 if is_now else 120,
               c=DEEP if is_now else LIGHT,
               edgecolors='white', linewidths=1.2, zorder=4)
    ax.text(x, y, str(fid), ha='center', va='center', fontsize=7.5,
            color='white', fontweight='bold', zorder=5)

ax.set_xlim(0.45, 3.55)
ax.set_ylim(0.45, 3.55)
ax.set_xticks([1, 2, 3])
ax.set_xticklabels(['Small\n(days)', 'Medium\n(1-4 weeks)', 'Large\n(a month+)'], fontsize=9)
ax.set_yticks([1, 2, 3])
ax.set_yticklabels(['Low', 'Medium', 'High'], fontsize=9)
ax.set_xlabel('Build effort', fontsize=10, color=MUTED)
ax.set_ylabel('Business impact', fontsize=10, color=MUTED)
for sp in ('top', 'right'):
    ax.spines[sp].set_visible(False)
for sp in ('left', 'bottom'):
    ax.spines[sp].set_color(PALE)
# Frameless legend outside plot area (top-left), circle markers
from matplotlib.lines import Line2D
handles = [
    Line2D([0], [0], marker='o', linestyle='', markersize=9,
           markerfacecolor=DEEP, markeredgecolor='white', label='Scheduled for the Now phase'),
    Line2D([0], [0], marker='o', linestyle='', markersize=8,
           markerfacecolor=LIGHT, markeredgecolor='white', label='Next / Later phases'),
]
ax.legend(handles=handles, loc='lower left', bbox_to_anchor=(0.0, 1.02),
          ncol=2, frameon=False, fontsize=9, handletextpad=0.4, columnspacing=1.6)
fig.savefig(f'{OUT}/chart_matrix.png')
plt.close(fig)
print('chart_matrix.png done')

# ────────────────────────────────────────────────────────────────────
# Chart 3 — MediPOS Pro vs market-leader average (grouped bars)
# ────────────────────────────────────────────────────────────────────
caps = ['Offline &\nDevice Sync', 'Shifts & Cash\nControl', 'Security &\nAccess Roles',
        'POS & Checkout\nSpeed', 'Inventory\nDepth', 'Reports &\nAnalytics',
        'Customer Growth\n& Marketing', 'Tax &\nCompliance']
medipos = [8.5, 9.0, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5]
leaders = [5.5, 6.0, 7.0, 9.0, 8.5, 8.5, 9.0, 7.5]

y = np.arange(len(caps))
h = 0.36
fig, ax = plt.subplots(figsize=(8.6, 5.2), dpi=200, constrained_layout=True)
b1 = ax.barh(y + h / 2, medipos, height=h, color=DEEP, edgecolor='none', zorder=3,
             label='MediPOS Pro today')
b2 = ax.barh(y - h / 2, leaders, height=h, color=PALE, edgecolor='none', zorder=3,
             label='Market-leader average (Square / Lightspeed / Loyverse)')
for bars, vals in ((b1, medipos), (b2, leaders)):
    for bar, v in zip(bars, vals):
        ax.text(bar.get_width() + 0.12, bar.get_y() + bar.get_height() / 2,
                f'{v:.1f}', va='center', ha='left', fontsize=8.5, color='#142840')
ax.set_yticks(y)
ax.set_yticklabels(caps, fontsize=9)
ax.invert_yaxis()
ax.set_xlim(0, 10)
ax.set_xticks([0, 2, 4, 6, 8, 10])
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['left'].set_visible(False)
ax.spines['bottom'].set_color(PALE)
ax.tick_params(axis='y', length=0)
ax.tick_params(axis='x', labelsize=9)
ax.legend(loc='lower left', bbox_to_anchor=(0.0, 1.01), ncol=2, frameon=False,
          fontsize=8.5, handletextpad=0.5, columnspacing=1.4)
fig.savefig(f'{OUT}/chart_benchmark.png')
plt.close(fig)
print('chart_benchmark.png done')
