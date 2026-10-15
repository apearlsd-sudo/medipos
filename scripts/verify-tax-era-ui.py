"""Task 54 UI smoke — VAT Rate Eras card: era table, activation flow flips the
till (badge + POS cart tax %), exact frozen-structure receipt reprint.
Run: python3 scripts/verify-tax-era-ui.py"""
import re
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

    # --- Settings: era card -------------------------------------------------
    page.click('text="Settings"')
    page.wait_for_timeout(1800)
    if page.get_by_text("VAT Rate Eras").count() > 0:
        ok("VAT Rate Eras card visible")
    else:
        bad("VAT Rate Eras card missing")

    if page.get_by_text("NHIL 2.5% + GETFund 2.5% + VAT 15% (20% era)").count() > 0:
        ok("20% era row present")
    else:
        bad("20% era row missing")
    if page.get_by_text("VAT 17.5% (+ levies) — verify").count() > 0:
        ok("17.5% verification era row present")
    else:
        bad("17.5% verify era row missing")
    if page.get_by_text("Till now: NHIL 2.5% + GETFund 2.5% + VAT 15%").count() > 0:
        ok("till summary chip shows the 20% structure")
    else:
        bad("till chip missing/wrong")
    if page.get_by_text("Current", exact=True).count() > 0:
        ok("Current badge rendered")
    else:
        bad("Current badge missing")
    if page.get_by_role("button", name="Record era").count() > 0:
        ok("Record era button present")
    else:
        bad("Record era button missing")

    # baseline guard: a prior crashed run may have left the 17.5% era current —
    # restore the 20% era first so the activation flow below starts from it
    if page.get_by_text("Till now: NHIL 2.5% + GETFund 2.5% + VAT 12.5%").count() > 0:
        row20 = page.locator("tr", has_text="20% era").first
        row20.get_by_role("button", name="Activate").click()
        page.wait_for_timeout(500)
        page.get_by_role("button", name="Activate era").click()
        page.wait_for_timeout(1500)
        ok("baseline restored (17.5% was left current by a prior run)")
    if page.get_by_text("Till now: NHIL 2.5% + GETFund 2.5% + VAT 15%").count() == 0:
        bad("baseline till chip is not the 20% structure — aborting activation flow")
        page.screenshot(path="/home/z/my-project/scripts/verify_tax_eras_baseline_fail.png")
        browser.close()
        print(f"{len(FAILS)} FAILURES"); sys.exit(1)

    # --- Record-era dialog: presets + cancel --------------------------------
    page.get_by_role("button", name="Record era").click()
    page.wait_for_timeout(600)
    if page.get_by_text("Record a VAT rate era").count() > 0:
        ok("record dialog opens")
    else:
        bad("record dialog missing")
    if page.get_by_text("Ghana VAT 20% (+ levies)").count() > 0 or page.locator('[role="listbox"], [data-slot="select-trigger"]').count() > 0:
        ok("structure preset picker present")
    else:
        bad("preset picker missing")
    page.get_by_role("button", name="Cancel").first.click()
    page.wait_for_timeout(400)

    # --- Activate the 17.5% era from the table ------------------------------
    row17 = page.locator("tr", has_text="VAT 17.5% (+ levies) — verify").first
    row17.get_by_role("button", name="Activate").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Activate era").click()
    page.wait_for_timeout(1800)
    if page.get_by_text("Era activated — VAT 17.5%").count() > 0 or page.get_by_text("The till now charges NHIL 2.5% + GETFund 2.5% + VAT 12.5%").count() > 0:
        ok("activation toast shown")
    else:
        bad("activation toast missing")
    if page.get_by_text("Till now: NHIL 2.5% + GETFund 2.5% + VAT 12.5%").count() > 0:
        ok("till chip switched to the 17.5% structure")
    else:
        bad("till chip did not switch")

    # --- POS cart reflects the switched era ----------------------------------
    page.click('text="POS Terminal"')
    page.wait_for_timeout(2000)
    page.get_by_role("button", name=re.compile("Paracetamol 500mg")).first.click()
    page.wait_for_timeout(900)
    if page.get_by_text("Tax (17.5%)").count() > 0:
        ok("POS cart charges Tax (17.5%) after era switch")
    else:
        bad(f"POS cart tax label wrong")

    # --- switch back to the 20% era ------------------------------------------
    page.click('text="Settings"')
    page.wait_for_timeout(1600)
    row20 = page.locator("tr", has_text="20% era").first
    row20.get_by_role("button", name="Activate").click()
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Activate era").click()
    page.wait_for_timeout(1800)
    if page.get_by_text("Till now: NHIL 2.5% + GETFund 2.5% + VAT 15%").count() > 0:
        ok("till chip restored to the 20% structure")
    else:
        bad("till chip not restored")

    page.click('text="POS Terminal"')
    page.wait_for_timeout(2000)
    if page.get_by_text("Tax (20%)").count() > 0:
        ok("POS cart back to Tax (20%)")
    else:
        bad("POS cart did not restore 20%")

    # --- exact attribution on a 17.5% sale's receipt reprint -----------------
    page.click('text="Sales & Invoices"')
    page.wait_for_timeout(2000)
    page.locator('table tbody tr').first.locator('button').first.click()
    page.wait_for_timeout(1200)
    page.get_by_role("button", name="Thermal Receipt").click()
    page.wait_for_timeout(900)
    if page.get_by_text("VAT (12.5%)").count() > 0 and page.get_by_text("NHIL (2.5%)").count() > 0:
        ok("reprint itemises the FROZEN 17.5% structure (era-exact)")
    else:
        bad("reprint does not show the frozen 17.5% breakdown")

    # leave the app in a clean state
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")

    if errors:
        bad(f"page errors: {errors[:3]}")
    else:
        ok("0 page errors")

    page.screenshot(path="/home/z/my-project/scripts/verify_tax_eras_settings.png")
    browser.close()

print("---")
if FAILS:
    print(f"{len(FAILS)} FAILURES"); sys.exit(1)
print("ALL TAX-ERA UI CHECKS GREEN")
