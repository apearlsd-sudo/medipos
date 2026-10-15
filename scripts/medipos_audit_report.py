#!/usr/bin/env python3
"""MediPOS Pro — Feature Gap Analysis & Product Roadmap (body PDF, ReportLab).

Pipeline per pdf skill briefs/report.md:
  body PDF (this script, TocDocTemplate + multiBuild)  ->  cover via html2poster.js
  ->  pypdf merge -> preflight (meta.brand, font.check, toc.check, pages.clean, pdf_qa).

Palette: Template 07 'Crystal Blue' fixed body subset (documented exception in
typesetting/cover.md — palette is fixed for this template, not auto-generated).
"""
import os
import sys
import hashlib

PDF_SKILL_DIR = '/home/z/my-project/skills/pdf'
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, 'scripts'))

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Image, KeepTogether, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents
from PIL import Image as PILImage

# ── Fonts (allowed set only) ─────────────────────────────────────────
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/truetype/freefont/FreeSerifBoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))
registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

from pdf import install_font_fallback  # noqa: E402  (skill scripts dir on path)
install_font_fallback()

# ── Template 07 Crystal Blue body palette (fixed per cover.md) ───────
PAGE_BG      = colors.HexColor('#f5f8fc')   # XL
SECTION_BG   = colors.HexColor('#edf2f9')   # XL
CARD_BG      = colors.HexColor('#e4ecf5')   # L
TABLE_STRIPE = colors.HexColor('#eef3fa')   # L
HEADER_FILL  = colors.HexColor('#1a4a7a')   # M
BORDER       = colors.HexColor('#c0d0e2')   # S
ACCENT       = colors.HexColor('#2d7ab3')   # XS
TEXT_PRIMARY = colors.HexColor('#142840')
TEXT_MUTED   = colors.HexColor('#5a7a96')

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_ROW_EVEN     = colors.white
TABLE_ROW_ODD      = TABLE_STRIPE

# ── Page geometry (symmetric margins — iron rule) ────────────────────
MARGIN = 0.9 * inch
PAGE_W, PAGE_H = A4
AVAIL_W = PAGE_W - 2 * MARGIN
AVAIL_H = PAGE_H - 2 * MARGIN
H1_ORPHAN = AVAIL_H * 0.25

OUT_DIR = '/home/z/my-project/scripts'
ASSETS = f'{OUT_DIR}/assets'
BODY_PDF = f'{OUT_DIR}/medipos_body.pdf'

DOC_TITLE = 'MediPOS Pro — Feature Gap Analysis & Product Roadmap'

# ── Styles ───────────────────────────────────────────────────────────
S = {}
S['body'] = ParagraphStyle('Body', fontName='FreeSerif', fontSize=10.5, leading=16.5,
                           alignment=TA_JUSTIFY, textColor=TEXT_PRIMARY,
                           spaceBefore=0, spaceAfter=10)
S['h1'] = ParagraphStyle('H1', fontName='FreeSerif', fontSize=20, leading=26,
                         textColor=HEADER_FILL, spaceBefore=16, spaceAfter=10)
S['h2'] = ParagraphStyle('H2', fontName='FreeSerif', fontSize=14, leading=19,
                         textColor=TEXT_PRIMARY, spaceBefore=14, spaceAfter=8)
S['h3'] = ParagraphStyle('H3', fontName='FreeSerif', fontSize=11.5, leading=16,
                         textColor=TEXT_PRIMARY, spaceBefore=10, spaceAfter=6)
S['bullet'] = ParagraphStyle('Bullet', fontName='FreeSerif', fontSize=10.5, leading=16,
                             alignment=TA_LEFT, textColor=TEXT_PRIMARY,
                             leftIndent=16, bulletIndent=4, spaceAfter=6)
S['caption'] = ParagraphStyle('Caption', fontName='FreeSerif', fontSize=8.5, leading=12,
                              alignment=TA_CENTER, textColor=TEXT_MUTED,
                              spaceBefore=3, spaceAfter=6)
S['th'] = ParagraphStyle('TH', fontName='FreeSerif', fontSize=9.5, leading=13,
                         alignment=TA_LEFT, textColor=colors.white)
S['td'] = ParagraphStyle('TD', fontName='FreeSerif', fontSize=9, leading=12.5,
                         alignment=TA_LEFT, textColor=TEXT_PRIMARY)
S['tdc'] = ParagraphStyle('TDC', parent=S['td'], alignment=TA_CENTER)
S['stat'] = ParagraphStyle('Stat', fontName='FreeSerif', fontSize=21, leading=25,
                           alignment=TA_CENTER, textColor=ACCENT)
S['statlabel'] = ParagraphStyle('StatLabel', fontName='FreeSerif', fontSize=8, leading=11,
                                alignment=TA_CENTER, textColor=TEXT_MUTED)
S['quote'] = ParagraphStyle('Quote', fontName='FreeSerif-Italic', fontSize=10.5, leading=16,
                            alignment=TA_LEFT, textColor=TEXT_PRIMARY,
                            leftIndent=24, spaceBefore=8, spaceAfter=10)
S['toc0'] = ParagraphStyle('TOC0', fontName='FreeSerif', fontSize=12, leading=22,
                           leftIndent=6, textColor=TEXT_PRIMARY)
S['toc1'] = ParagraphStyle('TOC1', fontName='FreeSerif', fontSize=10.5, leading=18,
                           leftIndent=26, textColor=TEXT_MUTED)
S['toctitle'] = ParagraphStyle('TOCTitle', fontName='FreeSerif', fontSize=20, leading=26,
                               textColor=HEADER_FILL, spaceAfter=14)

# ── Doc template with TOC support + header/footer ────────────────────
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page, key))

def header_footer(canvas, doc):
    canvas.saveState()
    # Header: title left + accent rule
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, PAGE_H - 0.55 * inch, DOC_TITLE)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.2)
    canvas.line(MARGIN, PAGE_H - 0.62 * inch, PAGE_W - MARGIN, PAGE_H - 0.62 * inch)
    # Footer: author left + page number right + light rule
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.62 * inch, PAGE_W - MARGIN, 0.62 * inch)
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, 0.45 * inch, 'MediPOS Pro Product Team')
    canvas.drawRightString(PAGE_W - MARGIN, 0.45 * inch, str(doc.page))
    canvas.restoreState()

def add_heading(text, style, level=0):
    key = 'h_' + hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph(f'<a name="{key}"/><b>{text}</b>', style)
    p.bookmark_name = key
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p

def safe_keep_together(elements):
    total_h = 0
    for el in elements:
        w, h = el.wrap(AVAIL_W, PAGE_H)
        total_h += h
    if total_h <= PAGE_H * 0.4:
        return [KeepTogether(elements)]
    elif len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    return list(elements)

def embed_image(path, max_width=None, max_height=None):
    if max_width is None:
        max_width = AVAIL_W
    if max_height is None:
        max_height = A4[1] * 0.35
    pil = PILImage.open(path)
    ow, oh = pil.size
    ratio = min(max_width / ow if ow > max_width else 1.0,
                max_height / oh if oh > max_height else 1.0)
    return Image(path, width=ow * ratio, height=oh * ratio)

def body(text):
    return Paragraph(text, S['body'])

def bullet(text):
    return Paragraph(text, S['bullet'], bulletText='\u2022')

def callout_row(items):
    """items: list of (big_value, label) — 4 stat callouts side by side."""
    gap = 10
    cw = (AVAIL_W - gap * (len(items) - 1)) / len(items)
    cells, widths = [], []
    for i, (val, lab) in enumerate(items):
        inner = Table([[Paragraph(f'<b>{val}</b>', S['stat'])],
                       [Paragraph(lab, S['statlabel'])]], colWidths=[cw])
        inner.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
            ('BOX', (0, 0), (-1, -1), 0.8, ACCENT),
            ('TOPPADDING', (0, 0), (-1, 0), 9),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
            ('TOPPADDING', (0, 1), (-1, 1), 1),
            ('BOTTOMPADDING', (0, 1), (-1, 1), 9),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ]))
        cells.append(inner)
        widths.append(cw)
        if i < len(items) - 1:
            cells.append('')
            widths.append(gap)
    outer = Table([cells], colWidths=widths, hAlign='CENTER')
    outer.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return outer

def styled_table(header, rows, ratios, center_cols=(), header_center=True):
    """header: list[str]; rows: list[list[str]]; ratios sum to 1.0."""
    assert abs(sum(ratios) - 1.0) < 0.001
    col_w = [r * AVAIL_W for r in ratios]
    assert sum(col_w) <= AVAIL_W + 0.5
    hstyle = S['th']
    data = [[Paragraph(f'<b>{h}</b>', hstyle) for h in header]]
    for row in rows:
        cells = []
        for ci, cell in enumerate(row):
            st = S['tdc'] if ci in center_cols else S['td']
            cells.append(Paragraph(str(cell), st))
        data.append(cells)
    t = Table(data, colWidths=col_w, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]
    for i in range(1, len(data)):
        bg = TABLE_ROW_EVEN if i % 2 == 1 else TABLE_ROW_ODD
        style.append(('BACKGROUND', (0, i), (-1, i), bg))
    t.setStyle(TableStyle(style))
    return t

def figure(path, caption_text, max_h=280):
    img = embed_image(path, max_width=AVAIL_W, max_height=max_h)
    cap = Paragraph(caption_text, S['caption'])
    return [Spacer(1, 16)] + safe_keep_together([img, cap]) + [Spacer(1, 12)]

# ── Build story ──────────────────────────────────────────────────────
story = []

# TOC page
story.append(Paragraph('<b>Table of Contents</b>', S['toctitle']))
toc = TableOfContents()
toc.levelStyles = [S['toc0'], S['toc1']]
story.append(toc)
story.append(PageBreak())

# ══════════════════════════ 1. EXECUTIVE SUMMARY ══════════════════════════
story.append(add_heading('1. Executive Summary', S['h1'], level=0))
story.append(body(
    'MediPOS Pro did not become a serious pharmacy platform by accident. Across fifty-one '
    'development milestones it has accumulated twenty-two operating modules, more than eighty-five '
    'API endpoints, an offline-first sync engine, a 50-permission access-control system, and a '
    'checkout that already handles cash, card, mobile money, customer credit, insurance claims and '
    'loyalty points in a single flow. The question this report answers is a different one: what is '
    'still missing between the system as it stands today and a genuinely top-tier point-of-sale '
    'platform that a modern Ghanaian pharmacy would be proud to run on?'))
story.append(body(
    'To answer it, every module was audited against the practices of the strongest point-of-sale '
    'products on the market — Square, Lightspeed and Loyverse on the general retail side — and '
    'scored on a ten-point maturity scale. The headline finding is encouraging: MediPOS Pro already '
    'matches or beats the market leaders on the foundations, leading clearly on offline resilience, '
    'shift and cash discipline, and access control. The gaps that remain are concentrated in four '
    'pockets: counter-side flexibility (held orders, refunds, split payments), forward-looking '
    'inventory intelligence, money-and-tax reporting, and customer-facing growth tooling.'))
story.append(Spacer(1, 6))
story.append(callout_row([
    ('22', 'operating modules audited'),
    ('7.7 / 10', 'average maturity score'),
    ('25', 'improvement opportunities identified'),
    ('8', 'quick wins scheduled for the Now phase'),
]))
story.append(Spacer(1, 14))
story.append(body(
    'Twenty-five concrete opportunities came out of the audit. Each one is described in plain '
    'business language in Chapter 4, rated for business impact and build effort, and then arranged '
    'in Chapters 5 and 6 into a Now / Next / Later roadmap. Consistent with the operational-efficiency '
    'priority set for this review, the Now phase favours changes that pay back within weeks: freeing '
    'the counter from all-or-nothing checkout (held orders, proper refunds, cash rounding), closing '
    'the tax-compliance gap that was already queued for development, and putting the numbers the '
    'owner actually needs — profit and loss, refill reminders, a weekly digest — on autopilot.'))
story.append(body(
    'One deliberate framing note: the ratings in this report are qualitative planning estimates, not '
    'engineering quotations. They are calibrated for a single developer working on the existing '
    'codebase, which is how this platform has been built so far. Every feature is scoped to extend '
    'structures that already exist — the notification outbox, the reorder assistant, the tax '
    'components engine — rather than to bolt on foreign architecture. That is what keeps the effort '
    'estimates honest and the roadmap realistic.'))

# ══════════════════════ 2. WHERE MEDiOS PRO STANDS TODAY ══════════════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('2. Where MediPOS Pro Stands Today', S['h1'], level=0))
story.append(body(
    'The audit covered the twelve capability areas that matter for a pharmacy point-of-sale, from '
    'the counter itself through to platform resilience. Each area was scored out of ten by comparing '
    'what ships today against the standard set by leading POS products. The scores are deliberately '
    'conservative: a feature only counts when it is finished, enforced on the server, and verified '
    'end to end — which is the standard this codebase has been held to throughout its development.'))
story += figure(f'{ASSETS}/chart_maturity.png',
                'Figure 1: Capability maturity scores. Deep bars (9.0+) mark best-in-class areas; '
                'pale bars mark the weakest two.', max_h=250)
story.append(body(
    'Three strengths stand out and deserve to be named, because they are the moat this platform '
    'builds on. First, shift and cash discipline: open-and-close with opening floats, cash '
    'movements with reasons, X and Z thermal reports, drawer reconciliation with variance tracking, '
    'and history visibility rules that keep every cashier honest — few SMB products anywhere do '
    'this completely. Second, security: granular role-based access across more than a dozen modules, '
    'custom roles, two-factor authentication and a full audit trail. Third, resilience: the platform '
    'keeps selling through internet outages, syncs across branches and workstations when the link '
    'returns, and recovers cleanly from power cuts.'))
story.append(body(
    'The two palest bars are equally instructive. Expenses and finance stops at petty-cash '
    'recording — there is no profit-and-loss statement, no payables ageing, nothing that turns the '
    'data the system already holds into owner-level money answers. Tax and compliance is the other '
    '6.5: the component-based tax engine and receipt detail are solid engineering, but VAT-era '
    'handling and a GRA-oriented filing summary — items already on the development backlog — are '
    'what would move this bar to where a Ghanaian pharmacy needs it. Those two areas anchor the '
    'front of the roadmap in Chapter 6.'))

# ═══════════════════ 3. BENCHMARK AGAINST MARKET LEADERS ═══════════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('3. Benchmark Against Market Leaders', S['h1'], level=0))
story.append(body(
    'To keep the maturity scores honest, they were pressure-tested against the three names that '
    'dominate conversations about best-in-class SMB point-of-sale: Square (the payments-first '
    'ecosystem), Lightspeed (deep retail inventory and e-commerce) and Loyverse (the free-tier '
    'favourite of small shops worldwide). The table below scores each system on the same eight '
    'axes. It is a like-for-like capability comparison, not a product review: a pharmacy running '
    'batch numbers, prescriptions and GRA taxes has needs that generic retail scores underweight, '
    'and Chapter 2 already credited MediPOS Pro for exactly those.'))
story.append(Spacer(1, 8))
bt = styled_table(
    ['Capability', 'MediPOS Pro', 'Square', 'Lightspeed', 'Loyverse', 'Leader avg'],
    [
        ['Offline & device sync', '8.5', '5.0', '5.5', '6.0', '5.5'],
        ['Shifts & cash control', '9.0', '6.5', '6.0', '5.5', '6.0'],
        ['Security & access roles', '9.0', '7.5', '7.5', '6.0', '7.0'],
        ['POS & checkout speed', '8.5', '9.5', '9.0', '8.5', '9.0'],
        ['Inventory depth', '8.0', '7.5', '9.5', '8.5', '8.5'],
        ['Reports & analytics', '7.5', '9.0', '9.0', '7.5', '8.5'],
        ['Customer growth & marketing', '7.0', '9.5', '9.0', '8.5', '9.0'],
        ['Tax & compliance', '6.5', '8.0', '8.0', '6.5', '7.5'],
    ],
    [0.30, 0.15, 0.13, 0.15, 0.13, 0.14],
    center_cols=(1, 2, 3, 4, 5))
story += safe_keep_together([bt, Paragraph(
    'Table 1: Capability scores — MediPOS Pro versus the leading SMB POS platforms (0-10 scale).',
    S['caption'])])
story.append(Spacer(1, 6))
story += figure(f'{ASSETS}/chart_benchmark.png',
                'Figure 2: MediPOS Pro today versus the market-leader average across eight axes.',
                max_h=270)
story.append(body(
    'The shape of the comparison is clear. MediPOS Pro wins outright on the operational backbone — '
    'offline sync, shifts, security — because those were engineering priorities from day one, and '
    'no amount of marketing gloss compensates for a till that stops when the internet does. The '
    'leaders hold their advantage at the counter polish level and, most visibly, in customer growth '
    'and marketing: campaign tooling, automated outreach and e-commerce storefronts are the engines '
    'that make those platforms feel inevitable. That 9.0-versus-7.0 gap on customer growth, and the '
    '8.5-versus-7.5 gap on reporting, are precisely where the roadmap in Chapter 6 invests.'))

# ══════════════ 4. THE GAP CATALOG: 25 OPPORTUNITIES ══════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('4. The Gap Catalog: 25 Opportunities', S['h1'], level=0))
story.append(body(
    'This chapter is the heart of the report: every missing or half-built capability, written in '
    'plain language and numbered 1 to 25. The numbering is used consistently in the prioritisation '
    'matrix (Chapter 5) and the roadmap (Chapter 6), so an item can be traced from first mention to '
    'scheduled slot. Two ratings accompany each feature. Impact is the expected effect on daily '
    'efficiency, revenue or risk within six months of shipping: High, Medium or Low. Effort is the '
    'realistic build size for one developer extending the existing codebase: Small (days), Medium '
    '(one to four weeks) or Large (a month or more). The opportunities are grouped into five themes '
    'that mirror how the business actually experiences them.'))

story.append(add_heading('4.1 Theme A — Faster, Safer Checkouts', S['h2'], level=1))
story.append(body(
    'The counter is where the system is used hundreds of times a day, so small frictions compound. '
    'Today a sale is an all-or-nothing affair: once a cart is started it must either complete or be '
    'scrapped, one payment method covers the whole basket, and the only escape hatch for a mistaken '
    'sale is a full cancel-and-restock. Every competitor benchmarked in Chapter 3 treats held orders, '
    'partial payments and structured refunds as counter basics — and cashiers notice their absence '
    'within days of trading volume.'))
ta_rows = [
    ['1', 'Held & parked orders', 'Park an in-progress basket with one tap (customer went to get '
     'money, second prescription being assembled) and recall it later by number. Ends lost sales '
     'and re-scanning when a counter gets busy.', 'High', 'Small'],
    ['2', 'Customer refunds & returns', 'A proper return flow: pick the original invoice, choose '
     'lines, auto-restock or quarantine, record reason, print a refund receipt, log to the audit '
     'trail. Replaces the current blunt cancel-the-whole-sale tool.', 'High', 'Medium'],
    ['6', 'Cash rounding', 'Round cash totals to the nearest ten pesewas with a visible rounding '
     'line on the receipt, while card and mobile money stay exact. Matches how GHS coins actually '
     'circulate at the counter.', 'Medium', 'Small'],
    ['7', 'Per-line discounts & overrides', 'Discount or reprice a single line with permission '
     'checks and approval routing, reusing the existing discount-approval workflow. Today only '
     'whole-order discounts exist.', 'Medium', 'Small'],
    ['10', 'Split & partial payments', 'Pay one bill across two or three methods (cash now, '
     'MoMo for the rest), or take a deposit and collect the balance on pickup — a natural fit with '
     'the customer credit book.', 'Medium', 'Medium'],
    ['24', 'Customer-facing cart display', 'Mirror the running cart, total and change onto a second '
     'screen or the shop tablet so the customer sees every item ring up. Builds trust and catches '
     'scan errors at the moment they happen.', 'Low', 'Medium'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'What it does for the shop', 'Impact', 'Effort'],
                 ta_rows, [0.05, 0.19, 0.56, 0.10, 0.10], center_cols=(0, 3, 4)),
    Paragraph('Table 2: Theme A — checkout and counter opportunities.', S['caption'])])

story.append(add_heading('4.2 Theme B — Deeper Inventory Intelligence', S['h2'], level=1))
story.append(body(
    'Inventory is already a strength — packs, batches, quarantine, transfers, counts and a reorder '
    'assistant all ship today. What separates a good inventory system from a top-tier one is '
    'foresight: knowing what will run out before it does, knowing which supplier actually '
    'performs, and being able to act instantly when a batch turns out to be bad. These five items '
    'turn the existing stock engine from a recorder of the past into an assistant for next month.'))
tb_rows = [
    ['13', 'Demand-based auto-replenishment', 'Upgrade the reorder assistant to learn from sales '
     'velocity, supplier lead time and safety stock, then suggest purchase orders per branch before '
     'stockouts happen instead of when shelves are already bare.', 'High', 'Large'],
    ['14', 'Batch recall management', 'Flag a batch number and instantly see every sale it touched, '
     'remaining units on shelves and at which branches, plus a customer contact list for the '
     'pharmacist to call. Turns a regulatory scare into a controlled exercise.', 'Medium', 'Medium'],
    ['12', 'Expiry-driven markdowns', 'Auto-apply configurable discounts to items approaching expiry '
     '(for example 20% off at 90 days), with badges at the counter and a waste-recovered report. '
     'Salvages value the write-off ledger currently destroys.', 'Medium', 'Small'],
    ['15', 'Supplier scorecards', 'Rate suppliers on delivery lead time, order fill rate and price '
     'drift, using data purchases already capture. Makes reorder suggestions and negotiation '
     'conversations evidence-based.', 'Medium', 'Small'],
    ['16', 'Shelf & stockroom locations', 'Record where each item lives (shelf, fridge, storeroom) '
     'and show it at counting and picking. Cuts count time and ends the fridge-hunt during busy hours.',
     'Medium', 'Small'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'What it does for the shop', 'Impact', 'Effort'],
                 tb_rows, [0.05, 0.19, 0.56, 0.10, 0.10], center_cols=(0, 3, 4)),
    Paragraph('Table 3: Theme B — inventory and supply-chain opportunities.', S['caption'])])

story.append(add_heading('4.3 Theme C — Money, Tax & Compliance', S['h2'], level=1))
story.append(body(
    'The system records almost every number an accountant or the GRA could ask for; what it does '
    'not yet do is assemble those numbers into the documents these audiences expect. This theme '
    'also absorbs the three items already queued on the development backlog — the taxRate default '
    'behaviour fix, date-range VAT presets, and the monthly GRA VAT filing summary — because '
    'together they form one coherent compliance milestone rather than three separate chores.'))
tc_rows = [
    ['3', 'VAT era presets + GRA filing summary', 'Let tax presets carry effective date ranges so '
     'historical sales recompute under the rates of their day, then generate a monthly per-component, '
     'per-branch VAT summary a GRA filing can be typed from. Completes the queued backlog items.',
     'High', 'Medium'],
    ['4', 'Profit & Loss statement', 'A monthly P&L joining revenue, cost of sales, expenses, '
     'write-offs and discounts — all data the system already stores. The single most requested '
     'owner-level document in retail POS.', 'High', 'Medium'],
    ['11', 'Supplier payables ageing', 'Extend the purchases due-tracking into an ageing view (current, '
     '30, 60, 90 days) with due-date alerts, so supplier relationships stay clean by design rather '
     'than by memory.', 'Medium', 'Small'],
    ['17', 'Insurance claims ageing desk', 'Track submitted NHIS and private insurance claims from '
     'submission to reimbursement, with ageing buckets and follow-up flags. Claims currently stop at '
     'submission and rely on memory to chase.', 'Medium', 'Medium'],
    ['18', 'GRA e-invoice export', 'Produce signed e-invoice batches in the format GRA\'s E-VAT '
     'system expects, building on the filing summary. Positions the shop ahead of mandatory '
     'electronic invoicing rather than behind it.', 'High', 'Large'],
    ['21', 'Gift cards & store credit', 'Sell and redeem stored value that survives refunds and '
     'promotions, with a balance ledger per card. A proven basket-builder in retail, and a clean '
     'complement to the loyalty scheme.', 'Low', 'Medium'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'What it does for the shop', 'Impact', 'Effort'],
                 tc_rows, [0.05, 0.19, 0.56, 0.10, 0.10], center_cols=(0, 3, 4)),
    Paragraph('Table 4: Theme C — money, tax and compliance opportunities.', S['caption'])])

story.append(add_heading('4.4 Theme D — Customer Growth & Marketing', S['h2'], level=1))
story.append(body(
    'This is the widest gap against the market leaders and, usefully, the one where a pharmacy has '
    'a structural advantage: prescriptions create natural, dates-known reasons to invite a customer '
    'back. The WhatsApp and SMS outbox that already delivers low-stock alerts is the delivery '
    'channel; what is missing is the customer-facing half of it. These four items turn a system '
    'that remembers customers into one that actively brings them back.'))
td_rows = [
    ['5', 'Prescription refill reminders', 'When a repeat prescription falls due, send a WhatsApp or '
     'SMS nudge with the item list and a one-tap "we\'ll have it ready" reply path. Pharmacies live '
     'on refill cycles; no benchmarked competitor does this natively.', 'High', 'Medium'],
    ['19', 'SMS / WhatsApp campaigns', 'Segment customers (chronic medication, lapsed 60 days, high '
     'value) and send approved bulk messages with offer codes. The outbox, templates and consent '
     'plumbing already exist for operational alerts.', 'High', 'Large'],
    ['20', 'Delivery management', 'Attach a delivery note and rider status to a sale, with a simple '
     'dispatch board and customer notification on the way. Delivery demand in Accra keeps rising, '
     'and phones already in staff hands can track it.', 'Medium', 'Medium'],
    ['23', 'Price-check kiosk & QR catalog', 'A locked screen (or QR code on the window) where '
     'anyone scans a barcode or searches the live catalog for price and availability, without '
     'touching the till. Serves queues and after-hours window shoppers alike.', 'Low', 'Medium'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'What it does for the shop', 'Impact', 'Effort'],
                 td_rows, [0.05, 0.19, 0.56, 0.10, 0.10], center_cols=(0, 3, 4)),
    Paragraph('Table 5: Theme D — customer growth and marketing opportunities.', S['caption'])])

story.append(add_heading('4.5 Theme E — Team Performance & Intelligence', S['h2'], level=1))
story.append(body(
    'The final theme is about making the data work for the people. Staff performance reports exist, '
    'but nothing tells a cashier what "good" looks like today; reports export beautifully but never '
    'leave the building on their own; and shift handovers still live on sticky notes. These four '
    'items are small, cheap, and disproportionately felt — the kind of polish that separates a '
    'well-loved system from a tolerated one.'))
te_rows = [
    ['8', 'Sales targets & leaderboards', 'Set daily or monthly targets per branch or cashier and '
     'show a gentle live leaderboard on the dashboard and POS banner. Visibility alone moves '
     'counter numbers.', 'Medium', 'Small'],
    ['9', 'Scheduled owner digest', 'Every Monday morning, WhatsApp or email the owner a one-page '
     'digest: sales, profit, cash variances, stock alerts, top movers. Uses the existing outbox and '
     'report pipeline — pure assembly work.', 'Medium', 'Small'],
    ['22', 'Frequently-bought-together prompts', 'Mine past baskets and suggest the natural companion '
     'item at the counter ("paracetamol often goes with ORS — add it?"). Ethical upselling that '
     'helps the customer complete their purchase.', 'Medium', 'Large'],
    ['25', 'Internal tasks & handover notes', 'A lightweight task list and per-shift handover note '
     'inside the shift-close flow, so the morning cashier inherits context, not surprises. Replaces '
     'the notebook by the till.', 'Low', 'Small'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'What it does for the shop', 'Impact', 'Effort'],
                 te_rows, [0.05, 0.19, 0.56, 0.10, 0.10], center_cols=(0, 3, 4)),
    Paragraph('Table 6: Theme E — team performance and intelligence opportunities.', S['caption'])])

# ══════════════ 5. IMPACT × EFFORT PRIORITISATION ══════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('5. Impact × Effort Prioritisation', S['h1'], level=0))
story.append(body(
    'Plotting all twenty-five opportunities on one grid makes the sequencing argument without '
    'needing a single spreadsheet. The vertical axis is business impact; the horizontal is build '
    'effort. The dark markers are the eight features selected for the Now phase — they cluster, as '
    'they should, in the high-impact, low-effort region. The number inside each marker is its '
    'catalog number from Chapter 4, so any point can be looked up in Tables 2 through 6.'))
story += figure(f'{ASSETS}/chart_matrix.png',
                'Figure 3: The 25 opportunities plotted by business impact and build effort. '
                'Dark markers form the Now phase.', max_h=300)
story.append(body(
    'Three lessons fall out of the geometry. First, the quick-wins quadrant is genuinely crowded — '
    'held orders, cash rounding, targets, the digest, expiry markdowns and supplier scorecards are '
    'all days-not-weeks builds, which is why the Now phase can deliver visible change within a '
    'month. Second, the strategic bets (auto-replenishment, campaigns, e-invoicing, basket '
    'analysis) are all Large builds; they deserve real calendar blocks and should start only once '
    'the quick wins have compounded. Third, almost nothing sits in the defer quadrant — the two '
    'low-impact medium-effort items (gift cards, the kiosk) are pleasant-to-have, not urgent, and '
    'their placement is a reminder that "top-notch" is defined by the high-impact majority, not '
    'the novelty fringe.'))

# ══════════════ 6. THE ROADMAP: NOW, NEXT, LATER ══════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('6. The Roadmap: Now, Next, Later', S['h1'], level=0))
story.append(body(
    'The grid becomes a plan in three phases. Now is the next four to six weeks and fits inside '
    'normal development rhythm. Next is the following quarter, mixing medium builds with the first '
    'strategic bet. Later is the horizon beyond that — items scheduled once their dependencies '
    'and prerequisites from the earlier phases exist. Each table gives the reason a feature earned '
    'its slot, because sequence is a set of arguments, not just an ordering.'))

story.append(add_heading('6.1 Now — the next four to six weeks', S['h2'], level=1))
now_rows = [
    ['1', 'Held & parked orders', 'Removes the most frequent counter frustration immediately and '
     'unlocks split-payment design work that reuses its parked-cart model.', 'Small'],
    ['2', 'Customer refunds & returns', 'The largest integrity gap a busy shop feels weekly; also '
     'creates the refund-receipt primitive that gift cards will reuse later.', 'Medium'],
    ['3', 'VAT era presets + GRA filing summary', 'Completes the already-queued compliance backlog '
     '(including the taxRate default fix) before filing season makes it urgent.', 'Medium'],
    ['4', 'Profit & Loss statement', 'Pure assembly of existing data with outsized owner value; '
     'the digest (item 9) reuses its numbers.', 'Medium'],
    ['5', 'Prescription refill reminders', 'The signature pharmacy differentiator; rides on the '
     'outbox and prescription dates that already exist.', 'Medium'],
    ['6', 'Cash rounding', 'Days of work, felt at every cash sale; must precede the P&L so '
     'rounding is a visible, auditable line.', 'Small'],
    ['8', 'Sales targets & leaderboards', 'Cheap motivation loop on the dashboard; feeds the '
     'staff-performance chapter of the weekly digest.', 'Small'],
    ['9', 'Scheduled owner digest', 'Turns everything shipped this phase into a Monday-morning habit '
     'for the owner — the phase\'s own feedback loop.', 'Small'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'Why it earns its slot now', 'Effort'],
                 now_rows, [0.05, 0.22, 0.60, 0.13], center_cols=(0, 3)),
    Paragraph('Table 7: Now phase — eight features scheduled for the next four to six weeks.',
              S['caption'])])

story.append(add_heading('6.2 Next — the following quarter', S['h2'], level=1))
story.append(body(
    'The second phase clears the remaining counter and money items, then opens the first strategic '
    'bet. Auto-replenishment (13) is deliberately sequenced after supplier scorecards (15): '
    'forecasts are only as trustworthy as the lead-time data behind them, so the scorecard build '
    'comes first and its output becomes the forecast input.'))
next_rows = [
    ['7', 'Per-line discounts & overrides', 'Extends the approval workflow to the line level once '
     'held orders have settled the cart model.', 'Small'],
    ['10', 'Split & partial payments', 'Builds on parked orders; deposits link directly into the '
     'credit book ledger.', 'Medium'],
    ['11', 'Supplier payables ageing', 'Small standalone win; pairs with purchases due-tracking '
     'already in place.', 'Small'],
    ['12', 'Expiry-driven markdowns', 'Rules engine over existing expiry badges; needs the refund '
     'audit trail from item 2 for reversals.', 'Small'],
    ['13', 'Demand-based auto-replenishment', 'The quarter\'s strategic bet; consumes scorecard '
     'lead-times and sales velocity.', 'Large'],
    ['14', 'Batch recall management', 'Indexes sales by batch (data already captured); pharmacy '
     'risk-reduction with regulatory value.', 'Medium'],
    ['15', 'Supplier scorecards', 'Prerequisite for forecasting; simple aggregation of purchase '
     'history.', 'Small'],
    ['16', 'Shelf & stockroom locations', 'Small schema addition that pays back at every stock '
     'take.', 'Small'],
    ['17', 'Insurance claims ageing desk', 'Completes the claims loop; reuses the ageing pattern '
     'from item 11.', 'Medium'],
    ['18', 'GRA e-invoice export', 'Starts once the filing summary (item 3) has survived one real '
     'filing cycle.', 'Large'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'Why it sits in this phase', 'Effort'],
                 next_rows, [0.05, 0.22, 0.60, 0.13], center_cols=(0, 3)),
    Paragraph('Table 8: Next phase — the following quarter.', S['caption'])])

story.append(add_heading('6.3 Later — the horizon beyond', S['h2'], level=1))
story.append(body(
    'The Later phase is where growth tooling compounds on an operationally mature base. Campaigns '
    '(19) deliberately wait for refill reminders to prove message quality and consent handling; '
    'delivery (20) waits for split payments so pay-on-delivery is native; the kiosk and '
    'customer-facing display (23, 24) are polish that matters most once counter speed is already '
    'excellent. Basket analysis (22) is the last strategic bet and the most data-hungry — it '
    'benefits from every additional month of clean sales the earlier phases accumulate.'))
later_rows = [
    ['19', 'SMS / WhatsApp campaigns', 'Segments, approvals and templates mature on refill traffic '
     'first.', 'Large'],
    ['20', 'Delivery management', 'Dispatch board rides on pay-later flows from item 10.', 'Medium'],
    ['21', 'Gift cards & store credit', 'Uses the refund and ledger primitives built in items 2 '
     'and 10.', 'Medium'],
    ['22', 'Frequently-bought-together prompts', 'Needs a deeper sales history for reliable '
     'associations.', 'Large'],
    ['23', 'Price-check kiosk & QR catalog', 'A locked read-only surface over the finished '
     'catalog.', 'Medium'],
    ['24', 'Customer-facing cart display', 'Mirrors the checkout state; worth doing after counter '
     'flow is final.', 'Medium'],
    ['25', 'Internal tasks & handover notes', 'Slots into the shift-close flow whenever the '
     'team asks for it.', 'Small'],
]
story += safe_keep_together([
    styled_table(['#', 'Feature', 'Why it waits', 'Effort'],
                 later_rows, [0.05, 0.22, 0.60, 0.13], center_cols=(0, 3)),
    Paragraph('Table 9: Later phase — the horizon beyond the quarter.', S['caption'])])

story.append(add_heading('6.4 What this plan deliberately leaves out', S['h2'], level=1))
story.append(body(
    'A top-tier roadmap is defined as much by its exclusions as its inclusions, so three popular '
    'ideas were consciously left off. An e-commerce storefront is the most requested feature in '
    'retail POS generally, but pharmacy e-commerce in Ghana entangles delivery, prescription law '
    'and payment trust in ways that deserve their own strategy document, not a line item. A '
    'third-party app marketplace only matters at a scale of thousands of installations. And '
    'proprietary payment-terminal hardware integration is a bet on a specific acquirer; recording '
    'card and mobile money payments cleanly (which the system already does) keeps every option '
    'open while the payment landscape settles. Revisit all three once the Now and Next phases have '
    'landed.'))

# ══════════════ 7. CLOSING PERSPECTIVE ══════════════
story.append(CondPageBreak(H1_ORPHAN))
story.append(add_heading('7. Closing Perspective', S['h1'], level=0))
story.append(body(
    'MediPOS Pro enters this review from a position of quiet strength: the operational backbone — '
    'offline resilience, cash discipline, access control, multi-branch sync — is already at or '
    'above the level of products with far larger teams behind them. The audit found no structural '
    'weakness anywhere in the platform; what it found instead were twenty-five well-defined '
    'opportunities, nearly all of which extend structures that already exist rather than require '
    'new architecture. That is the profile of a codebase ready to compound.'))
story.append(body(
    'The path to top-tier runs through the Now phase first. Within six weeks the shop can hold '
    'orders without losing them, refund professionally, round cash honestly, file VAT from a '
    'generated summary instead of a spreadsheet, and wake up every Monday to a digest that reads '
    'the business for itself. Each of those is a small build; together they change how the platform '
    'feels to own. The Next phase then buys foresight — replenishment that predicts, suppliers that '
    'are measured, recalls that are controlled — and the Later phase makes the system a growth '
    'engine that brings customers back on its own.'))
story.append(body(
    'Treat this document as a living plan rather than a verdict: scores will shift as features '
    'land, and the catalog is designed to absorb new items without renumbering the old ones. The '
    'recommended cadence is a light re-score of the maturity chart at the end of each phase — '
    'twelve numbers, one chart, an honest mirror of progress. The first review point is the '
    'completion of the Now phase, when items 1 through 9 graduate from this page into the daily '
    'routine of the shop that runs on them.'))

# ── Build ────────────────────────────────────────────────────────────
doc = TocDocTemplate(
    BODY_PDF, pagesize=A4,
    leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN,
    title=DOC_TITLE, author='Z.ai', creator='Z.ai',
    subject='Feature gap analysis and prioritised roadmap for the MediPOS Pro pharmacy POS platform')
doc.multiBuild(story, onFirstPage=header_footer, onLaterPages=header_footer)
print('body built:', BODY_PDF)
