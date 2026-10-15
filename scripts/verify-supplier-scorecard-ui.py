"""C3 UI smoke — suppliers page shows the scorecard card with live metrics.
Run: python3 scripts/verify-supplier-scorecard-ui.py"""
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

    page.click('text="Suppliers"')
    page.wait_for_timeout(2000)

    if page.get_by_text("Supplier Scorecards").count() > 0:
        ok("scorecard card visible")
    else:
        bad("scorecard card missing")

    if page.get_by_text("V-SC Supplier").count() > 0:
        ok("fixture supplier row present")
    else:
        bad("fixture supplier row missing")

    # fill-rate cell for the fixture should read 100%
    row = page.locator("tr", has_text="V-SC Supplier").filter(has=page.locator("td")).last
    if "100%" in row.inner_text():
        ok("fixture shows 100% fill rate")
    else:
        bad(f"fill rate cell: {row.inner_text()[:120]!r}")

    # window switcher present
    if page.locator("button", has_text="90d").count() > 0 and page.locator("button", has_text="365d").count() > 0:
        ok("90/180/365 window switcher present")
    else:
        bad("window switcher missing")
    page.click('button:has-text("365d")')
    page.wait_for_timeout(1200)
    ok("365d switch clickable")

    page.screenshot(path="/tmp/c3-suppliers.png")
    if errors: bad(f"page errors: {errors[:3]}")
    else: ok("no page errors")
    browser.close()

print("UI OK" if not FAILS else f"UI FAILURES: {len(FAILS)}")
sys.exit(0 if not FAILS else 1)
