"""Task 55 UI smoke — Reports → VAT Filing tab renders era-aware GRA summary.
Run: python3 scripts/verify-vat-filing-ui.py"""
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
    page.click('text="VAT Filing"')
    page.wait_for_timeout(2200)

    # Stat cards
    for label in ["Taxable base", "Output VAT", "Refund VAT adj.", "Net VAT payable"]:
        if page.get_by_text(label, exact=True).count() > 0:
            ok(f"stat card: {label}")
        else:
            bad(f"stat card missing: {label}")

    # Era/structure table
    if page.get_by_text("Output VAT by statutory structure").count() > 0:
        ok("era structure table present")
    else:
        bad("era structure table missing")
    if page.get_by_text("(20% era)").count() > 0:
        ok("current era row visible (20% era)")
    else:
        bad("current era row missing")
    if page.get_by_text("current", exact=True).count() > 0:
        ok("current badge on era row")
    else:
        bad("current badge missing")
    if page.get_by_text("Unattributable legacy tax").count() > 0:
        ok("unattributable legacy disclosure row visible")
    else:
        bad("unattributable row missing")
    if page.get_by_text("Total output VAT").count() > 0:
        ok("total output VAT row visible")
    else:
        bad("total row missing")

    # Reconciliation card
    if page.get_by_text("Filing reconciliation").count() > 0:
        ok("reconciliation card present")
    else:
        bad("reconciliation card missing")
    if page.get_by_text("Balanced — ready to file").count() > 0:
        ok("reconciliation badge: Balanced — ready to file")
    else:
        bad("balanced badge missing")
    if page.get_by_text("Ledger tax (all completed sales in month)").count() > 0:
        ok("ledger tax line present")
    else:
        bad("ledger line missing")

    # Refunds + exempt disclosure
    if page.get_by_text("Refunds (credit adjustments)").count() > 0:
        ok("refunds card present")
    else:
        bad("refunds card missing")
    if page.get_by_text("Exempt / zero-rated sales (no taxable base):").count() > 0:
        ok("exempt disclosure present")
    else:
        bad("exempt disclosure missing")

    # Per-branch table
    if page.get_by_text("Per-branch breakdown").count() > 0:
        ok("per-branch table present")
    else:
        bad("per-branch table missing")
    if page.get_by_text("Main Pharmacy — Accra").count() > 0:
        ok("MAIN branch row visible")
    else:
        bad("MAIN row missing")
    if page.get_by_text("Osu Branch").count() > 0:
        ok("OSU branch row visible")
    else:
        bad("OSU row missing")

    # stray generic fallback (purchases table) must NOT render under the VAT section
    if page.get_by_text("PUR-2026-").count() > 0:
        bad("stray purchases fallback table rendered under VAT tab")
    else:
        ok("no stray purchases fallback under VAT tab")
    if page.get_by_text("showing up to 20 rows").count() > 0:
        bad("stray generic footer rendered under VAT tab")
    else:
        ok("no stray generic footer under VAT tab")

    page.screenshot(path="/tmp/t55-vat-filing.png", full_scroll=True) if False else page.screenshot(path="/tmp/t55-vat-filing.png", full_page=True)

    # Empty month → zeroed state
    page.fill('input[aria-label="VAT filing month"]', "2001-01")
    page.wait_for_timeout(1500)
    if page.get_by_text("No taxable sales this month.").count() > 0:
        ok("empty month → zeroed empty state")
    else:
        bad("empty month state missing")

    # Back to current month
    page.fill('input[aria-label="VAT filing month"]', "")
    page.wait_for_timeout(400)
    page.fill('input[aria-label="VAT filing month"]', __import__("datetime").date.today().strftime("%Y-%m"))
    page.wait_for_timeout(1500)
    if page.get_by_text("Output VAT by statutory structure").count() > 0:
        ok("current month data restored")
    else:
        bad("current month restore failed")

    if errors: bad(f"page errors: {errors[:3]}")
    else: ok("no page errors")
    browser.close()

print("---")
if FAILS:
    print(f"VAT-FILING UI FAILURES: {len(FAILS)}")
    sys.exit(1)
print("ALL VAT-FILING UI CHECKS GREEN")
