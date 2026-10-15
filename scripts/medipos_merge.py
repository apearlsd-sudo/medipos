#!/usr/bin/env python3
"""Merge Template 07 cover (page 0) + ReportLab body -> single final PDF."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

def normalize_page_to_a4(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.4 or abs(h - A4_H) > 0.4:
        page.scale_to(A4_W, A4_H)
        page.mediabox.lower_left = (0, 0)
        page.mediabox.upper_right = (A4_W, A4_H)
    return page

cover = '/home/z/my-project/scripts/medipos_cover.pdf'
body = '/home/z/my-project/scripts/medipos_body.pdf'
out = '/home/z/my-project/download/MediPOS-Pro-Feature-Gap-Analysis-and-Roadmap.pdf'

writer = PdfWriter()
writer.add_page(normalize_page_to_a4(PdfReader(cover).pages[0]))
for page in PdfReader(body).pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    '/Title': 'MediPOS Pro — Feature Gap Analysis & Product Roadmap',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': 'Feature gap analysis and prioritised roadmap for the MediPOS Pro pharmacy POS platform',
})
with open(out, 'wb') as f:
    writer.write(f)
print('merged ->', out)
