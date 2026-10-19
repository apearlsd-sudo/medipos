#!/usr/bin/env python3
"""Verify v0.3.11 per-tablet (pack vs loose) selling:
1. the sell dialog (pack vs loose prompt) opens when a pack-size product tile is tapped
2. choosing "Loose Tablet" adds a cart line in the INNER unit with the per-tablet price
3. a product WITHOUT pack size still adds directly (no dialog)
Setup/cleanup of the test products happens in verify-pack-sync.sh (which calls this).
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
PACK_NAME = "PackVerify Aspirin"
NO_PACK_NAME = None  # resolved at runtime (first tile without the pack hint)
errors = []
passed = 0


def ok(label):
    global passed
    passed += 1
    print(f"PASS: {label}")


def login(page, username, password):
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username', username)
    page.fill('input[name="password"], #password', password)
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")
    time.sleep(2)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

    login(page, "admin", "admin123")
    ok("admin login")

    page.click('button:has-text("POS Terminal")')
    page.wait_for_load_state("networkidle")
    time.sleep(2)

    # 1. pack-size product shows the per-unit hint
    page.fill('input[placeholder*="Scan barcode"]', PACK_NAME)
    time.sleep(1.2)
    tile = page.locator('button', has=page.locator(f'text="{PACK_NAME}"')).first
    tile.wait_for(state="visible", timeout=8000)
    assert "tap for pack or piece" in page.inner_text("body"), "pack hint missing on tile"
    ok("pack-size tile shows 'tap for pack or piece' hint")

    # 2. tapping opens the prompt
    tile.click()
    time.sleep(0.8)
    dialog = page.locator('div[role="dialog"]')
    assert dialog.count() > 0, "sell dialog did not open"
    assert "Full Box" in dialog.inner_text(), "dialog lacks the pack option"
    assert "Loose Tablet" in dialog.inner_text(), "dialog lacks the loose option"
    ok("sell dialog prompts Full Box vs Loose Tablet")
    # per-tablet price shown = pack price / innerQty (30.00 / 10 = 3.00)
    assert "3.00" in dialog.inner_text(), "per-tablet price wrong in dialog"
    ok("dialog shows the per-tablet price (30.00 / 10 = 3.00)")

    # 3. choose Loose Tablet and add → cart line in the inner unit
    dialog.locator('button:has-text("Loose Tablet")').click()
    dialog.locator('button:has-text("Add to cart")').click()
    time.sleep(1.0)
    body = page.inner_text("body")
    assert "Tablet" in body, "cart line does not show the inner unit"
    ok("loose sale lands in the cart per Tablet")

    # 4. product without pack size adds directly (no dialog)
    page.fill('input[placeholder*="Scan barcode"]', "")
    time.sleep(1.0)
    tiles = page.locator('div.grid button')
    n = tiles.count()
    target = None
    import re as _re
    for i in range(n):
        t = tiles.nth(i)
        txt = t.inner_text()
        if not txt.strip():
            continue
        if any(w in txt for w in ("Shift", "Cart", "Scan", "Search", "Hold", "Discount")):
            continue
        if "tap for pack or piece" in txt:
            continue
        # product tiles carry a stock line like "60 Box" / "12 Pack"
        if not _re.search(r'\d+\s+[A-Za-z]', txt):
            continue
        target = t
        NO_PACK_NAME = txt.split("\n")[0]
        break
    assert target is not None, "no plain product tile found"
    cart_badge_before = page.locator('text="Cart"').count()
    target.click()
    time.sleep(0.8)
    assert page.locator('div[role="dialog"]').count() == 0, f"dialog wrongly opened for pack-less product {NO_PACK_NAME}"
    ok(f"pack-less product '{NO_PACK_NAME}' adds directly — no prompt (unchanged behavior)")

    browser.close()

print(f"\n{passed} checks passed")
if errors:
    real = [e for e in errors if "401" not in e and "403" not in e]
    if real:
        print("ERRORS:")
        for e in real[:10]:
            print(" -", e)
        sys.exit(1)
print("CLEAN")
