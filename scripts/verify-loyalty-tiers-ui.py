"""C1 UI smoke — settings shows the tiers/birthday blocks; customers page renders.
Run: python3 scripts/verify-loyalty-tiers-ui.py"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAILS = []

def ok(label):
    print(f"PASS: {label}")

def bad(label):
    print(f"FAIL: {label}")
    FAILS.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # Login as admin (proven pattern: fill form, click submit)
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', "admin")
    page.fill('input[type="password"]', "admin123")
    page.click("button[type=submit]")
    page.wait_for_timeout(1800)

    # Navigate via sidebar (exact text to avoid substring false-matches)
    page.click('text="Settings"')
    page.wait_for_timeout(1500)
    if page.get_by_text("Spend tiers (multiplier campaign)").count() > 0:
        ok("settings: spend tiers block visible")
    else:
        bad("settings: spend tiers block missing")
    if page.get_by_text("Birthday bonus").count() > 0:
        ok("settings: birthday campaign block visible")
    else:
        bad("settings: birthday campaign block missing")
    if page.locator('input[value="Platinum"]').count() > 0:
        ok("settings: tier ladder rows rendered (Platinum present)")
    else:
        bad("settings: tier ladder rows missing")
    page.screenshot(path="/tmp/c1-settings.png", full_page=False)

    # Customers view
    page.click('text="Customers"')
    page.wait_for_timeout(1500)
    if page.get_by_text("Credit Balance").count() > 0:
        ok("customers: table rendered")
    else:
        bad("customers: table missing")
    page.screenshot(path="/tmp/c1-customers.png", full_page=False)

    if errors:
        bad(f"page errors: {errors[:3]}")
    else:
        ok("no page errors")
    browser.close()

print("UI OK" if not FAILS else f"UI FAILURES: {len(FAILS)}")
sys.exit(0 if not FAILS else 1)
