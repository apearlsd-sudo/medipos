"""C2 UI smoke — Reports → Accounting Pack tab renders with live month data.
Run: python3 scripts/verify-export-pack-ui.py"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAILS = []

def ok(l): print(f"PASS: {l}")
def bad(l):
    print(f"FAIL: {l}"); FAILS.append(l)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', "admin")
    page.fill('input[type="password"]', "admin123")
    page.click("button[type=submit]")
    page.wait_for_timeout(1800)

    page.click('text="Reports"')
    page.wait_for_timeout(1500)
    page.click('text="Accounting Pack"')
    page.wait_for_timeout(2000)

    if page.get_by_text("Net sales").count() > 0:
        ok("net sales stat card visible")
    else:
        bad("net sales card missing")
    if page.get_by_text("VAT collected").count() > 0:
        ok("VAT card visible")
    else:
        bad("VAT card missing")
    if page.get_by_text("Daily sales").count() > 0:
        ok("daily sales table visible")
    else:
        bad("daily sales table missing")
    if page.get_by_text("Credit aging snapshot").count() > 0:
        ok("credit aging section visible")
    else:
        bad("credit aging section missing")
    if page.locator('input[aria-label="Accounting month"]').count() > 0:
        ok("month picker present")
    else:
        bad("month picker missing")
    page.screenshot(path="/tmp/c2-accounting.png")

    if errors: bad(f"page errors: {errors[:3]}")
    else: ok("no page errors")
    browser.close()

print("UI OK" if not FAILS else f"UI FAILURES: {len(FAILS)}")
sys.exit(0 if not FAILS else 1)
