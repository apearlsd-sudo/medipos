"""Task 50 + tax-restore E2E (UI).

Admin: Settings carries the Charge-tax master switch + statutory component
editor; POS cart shows Tax (20%) with NHIL/GETFund/VAT lines; a sale's receipt
itemises the components (sum == Tax, no badge); Sales & Invoices shows all
cashiers with no restricted banner.
Cashier (view_own): Sales & Invoices shows the restricted banner + only his own
today's rows; his own receipt reprints with components; POS cart charges 20%.
"""
import re
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
OUT = "/home/z/my-project/scripts"
errors = []

def money(txt):
    m = re.search(r"([\d,]+\.\d{2})", txt)
    return float(m.group(1).replace(",", "")) if m else None

def comp_amounts(rtxt):
    out = {}
    for lbl in ["NHIL (2.5%)", "GETFund (2.5%)", "VAT (15%)"]:
        m = re.search(re.escape(lbl) + r"[\s\S]{0,8}?([\d,]+\.\d{2})", rtxt)
        if m:
            out[lbl] = money(m.group(1))
    return out

def assert_receipt_components(rtxt, tag):
    comps = comp_amounts(rtxt)
    assert len(comps) == 3, f"{tag}: receipt missing component lines (found {list(comps)})"
    m = re.search(r"(?:^|\n)Tax[\s\S]{0,8}?([\d,]+\.\d{2})", rtxt)
    assert m, f"{tag}: Tax row not found"
    tax = money(m.group(1))
    s = round(sum(comps.values()), 2)
    assert abs(s - tax) < 0.011, f"{tag}: components {s} != Tax {tax}"
    assert "TAX EXEMPT SALE" not in rtxt, f"{tag}: badge must be gone"
    print(f"{tag}_OK tax={tax} components={comps}")

def login(pg, username, password):
    pg.goto(BASE, wait_until="networkidle")
    pg.fill("input[name=username], #username, input[type=text]", username)
    pg.fill("input[type=password]", password)
    pg.click("button[type=submit]")
    pg.wait_for_timeout(2500)

def add_item_and_charge(pg):
    cards = pg.locator("button:has(svg.lucide-plus)")
    if cards.count() == 0:
        pg.locator("[class*='group']").first.click()
    else:
        cards.first.click()
    pg.wait_for_timeout(1200)
    pg.locator("[role=dialog] button:has-text('Charge'), button:has-text('Charge')").last.click()
    pg.wait_for_timeout(1200)
    dlg = pg.locator("[role=dialog]")
    dlg.locator("button:text-is('Exact')").first.click()
    pg.wait_for_timeout(400)
    dlg.locator("button:has-text('Confirm')").first.click()
    pg.wait_for_timeout(2500)
    return pg.locator("[role=dialog]").inner_text()

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- ADMIN ----------
    ca = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ca.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    login(pg, "admin", "admin123")

    # Settings: master switch + component editor present
    pg.click("text=Settings")
    pg.wait_for_timeout(1500)
    sw = pg.locator("button[role=switch][aria-label='Charge tax on sales']")
    assert sw.count() == 1, "settings Charge-tax switch missing"
    assert sw.is_checked(), "master switch should be ON"
    for lbl in ["Tax component 1 label", "Tax component 3 percent"]:
        assert pg.locator(f"input[aria-label='{lbl}']").count() == 1, f"{lbl} input missing"
    pg.locator("text=Statutory breakdown").first.scroll_into_view_if_needed()
    pg.screenshot(path=f"{OUT}/verify_rbac_settings.png")
    print("SETTINGS_OK (switch ON + components editor)")

    # POS cart charges 20% with components
    pg.click("text=POS Terminal")
    pg.wait_for_timeout(2000)
    cards = pg.locator("button:has(svg.lucide-plus)")
    if cards.count() == 0:
        pg.locator("[class*='group']").first.click()
    else:
        cards.first.click()
    pg.wait_for_timeout(1200)
    body = pg.locator("body").inner_text()
    assert "Tax (20%)" in body, "cart missing Tax (20%)"
    for lbl in ["NHIL (2.5%)", "GETFund (2.5%)", "VAT (15%)"]:
        assert lbl in body, f"cart missing {lbl}"
    print("CART_OK (Tax (20%) + components)")

    # Sale → receipt itemised
    rtxt = add_item_and_charge(pg)
    assert_receipt_components(rtxt, "ADMIN_RECEIPT")
    pg.screenshot(path=f"{OUT}/verify_rbac_receipt.png")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(800)

    # Sales page: no restricted banner, multiple cashiers visible
    pg.click("text=Sales & Invoices")
    pg.wait_for_timeout(2000)
    assert "Showing your own sales for today only" not in pg.locator("body").inner_text(), "admin must not see the restricted banner"
    tbl = pg.locator("table tbody tr").all_inner_texts()
    kofi_rows = [t for t in tbl if "Kofi Boateng" in t]
    other_rows = [t for t in tbl if "Kofi Boateng" not in t]
    assert kofi_rows and other_rows, f"admin should see rows from several cashiers (kofi={len(kofi_rows)}, other={len(other_rows)})"
    print(f"ADMIN_SALES_OK ({len(tbl)} rows, kofi={len(kofi_rows)}, other-cashiers={len(other_rows)})")
    ca.close()

    # ---------- CASHIER (sales:view_own) ----------
    ck = b.new_context(viewport={"width": 1440, "height": 900})
    pg2 = ck.new_page()
    pg2.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    login(pg2, "cashier", "cash123")

    pg2.click("text=Sales & Invoices")
    pg2.wait_for_timeout(2000)
    btxt = pg2.locator("body").inner_text()
    assert "Showing your own sales for today only" in btxt, "cashier restricted banner missing"
    tbl2 = pg2.locator("table tbody tr").all_inner_texts()
    assert len(tbl2) > 0, "cashier should see his own today sales (API test booked 3)"
    for t in tbl2:
        assert "Kofi Boateng" in t, f"cashier list leaked a foreign sale: {t[:80]}"
    print(f"CASHIER_SALES_OK (banner + {len(tbl2)} own rows)")
    pg2.screenshot(path=f"{OUT}/verify_rbac_cashier_sales.png")

    # own receipt reprint with components
    pg2.locator("table tbody tr").first.locator("button[aria-label='View invoice']").first.click()
    pg2.wait_for_timeout(1200)
    pg2.locator("[role=dialog] button:has-text('Thermal Receipt')").first.click()
    pg2.wait_for_timeout(1200)
    rdlg = pg2.locator("[role=dialog]", has_text="Receipt — #")
    rtxt2 = rdlg.inner_text()
    assert_receipt_components(rtxt2, "CASHIER_REPRINT")
    pg2.screenshot(path=f"{OUT}/verify_rbac_cashier_reprint.png")
    rdlg.locator("button:text-is('Close')").click()
    pg2.wait_for_timeout(500)
    pg2.locator("[role=dialog] button:text-is('Close')").last.click()
    pg2.wait_for_timeout(500)

    # cashier POS cart charges 20% too
    pg2.click("text=POS Terminal")
    pg2.wait_for_timeout(2000)
    cards = pg2.locator("button:has(svg.lucide-plus)")
    if cards.count() == 0:
        pg2.locator("[class*='group']").first.click()
    else:
        cards.first.click()
    pg2.wait_for_timeout(1200)
    b2 = pg2.locator("body").inner_text()
    assert "Tax (20%)" in b2 and "NHIL (2.5%)" in b2, "cashier cart missing 20% + components"
    print("CASHIER_CART_OK (Tax (20%) + components)")
    ck.close()

    b.close()

real = [e for e in errors if "favicon" not in e.lower()]
print(f"PAGE_ERRORS={len(real)}")
for e in real[:5]:
    print(" ", e[:200])
sys.exit(1 if real else 0)
