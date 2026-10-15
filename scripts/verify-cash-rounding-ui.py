"""Task 58 UI smoke — cash rounding on the POS checkout, receipt and reports.
Run: python3 scripts/verify-cash-rounding-ui.py"""
import json
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAILS = []

def ok(l): print(f"PASS: {l}")
def bad(l):
    print(f"FAIL: {l}"); FAILS.append(l)

def api(method, path, body=None, cookie=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            setc = r.headers.get("Set-Cookie")
            return r.status, json.loads(r.read().decode() or "{}"), (setc.split(";")[0] if setc else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}"), None

def money(text):
    m = re.search(r"([\d,]+\.\d{2})", text)
    return float(m.group(1).replace(",", "")) if m else None

# login once for API calls that precede the browser session
st, _, setc = api("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
assert st == 200 and setc, "API login failed"
cookie = setc

# baseline: rounding off (server-side, BEFORE the browser boots)
st, _, _ = api("PUT", "/api/settings", {"cashRounding": "none"}, cookie)
if st == 200:
    ok("baseline cashRounding=none")
else:
    bad(f"baseline PUT failed {st}"); sys.exit(1)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', "admin")
    page.fill('input[type="password"]', "admin123")
    page.click("button[type=submit]")
    page.wait_for_timeout(1800)

    # session cookie for API calls
    raw = ctx.cookies(BASE)
    cookie = "; ".join(f"{c['name']}={c['value']}" for c in raw)
    assert cookie, "no session cookie"

    # pick a product whose 1-pack total lands OFF the 0.05 grid
    st, meds, _ = api("GET", "/api/medicines?status=active", cookie=cookie)
    cands = meds["medicines"]
    pick = None
    for m in cands:
        if m.get("stockQty", 0) < 3 or m.get("status") != "active":
            continue
        exp = m.get("expiryDate")
        if exp and exp <= __import__("datetime").datetime.utcnow().isoformat() + "Z":
            continue
        P = float(m["sellingPrice"])
        tax = round(P * 0.2, 2)
        total = round(P + tax, 2)
        if abs(total / 0.05 - round(total / 0.05)) > 1e-6 and 1 < total < 500:
            pick = (m, P, tax, total)
            break
    if not pick:
        bad("no off-grid product found"); browser.close(); sys.exit(1)
    med, P, tax, TOTAL = pick
    ROUND = round(round(TOTAL / 0.05) * 0.05, 2)
    DELTA = round(ROUND - TOTAL, 2)
    ok(f"product {med['name']} @ {P} → total {TOTAL} → rounded {ROUND} ({DELTA:+})")

    # --- POS, rounding OFF ---------------------------------------------------
    page.click('text="POS Terminal"')
    page.wait_for_timeout(2000)
    if page.get_by_text("No active shift").count() > 0:
        page.locator('button:has-text("Start Shift")').first.click()
        page.wait_for_timeout(600)
        page.locator('button:has-text("Start Shift")').last.click()
        page.wait_for_timeout(1200)

    card = page.locator(f'button:has-text("{med["name"][:24]}")').filter(has_not_text="Out of stock")
    if card.count() == 0:
        bad("product card not found"); browser.close(); sys.exit(1)
    card.first.click()
    page.wait_for_timeout(800)
    ok("product added (rounding off)")

    page.locator('button:has-text("Charge")').first.click()
    page.wait_for_timeout(800)
    dlg = page.locator('[role="dialog"]')
    due_txt = dlg.locator("p.text-3xl").inner_text()
    due = money(due_txt)
    if due is not None and abs(due - TOTAL) < 0.005:
        ok(f"Amount Due shows the EXACT total ({due_txt.strip()}) when rounding is off")
    else:
        bad(f"Amount Due off-state expected {TOTAL}, got {due_txt}")
    if dlg.get_by_text("Cash rounding", exact=False).count() == 0:
        ok("no rounding chip when rounding is off")
    else:
        bad("rounding chip visible with rounding off")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)

    # --- enable 0.05 + reload ------------------------------------------------
    st, _, _ = api("PUT", "/api/settings", {"cashRounding": "0.05"}, cookie)
    if st != 200: bad(f"enable PUT failed {st}")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(2000)
    # reload may land on the default view — make sure we're on the POS terminal
    if page.locator('button:has-text("Charge")').count() == 0:
        page.click('text="POS Terminal"')
        page.wait_for_timeout(2200)
    # the cart does not survive a reload — re-add when Charge is disabled
    charge_btn = page.locator('button:has-text("Charge")').first
    if charge_btn.is_disabled():
        card = page.locator(f'button:has-text("{med["name"][:24]}")').filter(has_not_text="Out of stock")
        if card.count() == 0:
            bad("product card not found after reload"); browser.close(); sys.exit(1)
        card.first.click()
        page.wait_for_timeout(800)
    page.locator('button:has-text("Charge")').first.click()
    page.wait_for_timeout(800)
    dlg = page.locator('[role="dialog"]')
    due_txt = dlg.locator("p.text-3xl").inner_text()
    due = money(due_txt)
    if due is not None and abs(due - ROUND) < 0.005:
        ok(f"Amount Due ROUNDS to the 0.05 grid ({due_txt.strip()})")
    else:
        bad(f"Amount Due rounded expected {ROUND}, got {due_txt}")
    chip = dlg.get_by_text("Cash rounding", exact=False)
    if chip.count() > 0:
        chip_txt = chip.first.inner_text()
        (ok if f"{abs(DELTA):.2f}" in chip_txt else bad)(f"rounding chip shows the delta: {chip_txt.strip()}")
    else:
        bad("rounding chip missing with rounding on")
    confirm_txt = dlg.locator('button:has-text("Confirm Payment")').inner_text()
    (ok if f"{ROUND:.2f}" in confirm_txt else bad)(f"Confirm button shows the rounded due: {confirm_txt.strip()}")

    # change due on a pre-filled quick tender
    change = money(dlg.locator('text="Change Due"').locator("xpath=following-sibling::div").first.inner_text()) if dlg.locator('text="Change Due"').count() else None
    tendered_val = page.locator('input[type="number"]').nth(-1).input_value() if False else None
    # simpler: read the tendered input by its label proximity
    tendered_in = dlg.locator('input[type="number"]')
    tendered_num = 0.0
    for i in range(tendered_in.count()):
        v = tendered_in.nth(i).input_value()
        try: tendered_num = float(v); break
        except Exception: continue
    if tendered_num > 0:
        expected_change = round(tendered_num - ROUND, 2)
        if change is not None and abs(change - max(expected_change, 0)) < 0.005:
            ok(f"Change Due reconciles against the ROUNDED due ({change} on {tendered_num} tendered)")
        else:
            bad(f"Change Due expected {expected_change}, got {change}")
    else:
        print("note: no prefilled tender — change assertion skipped")

    # complete via Ctrl+Enter
    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(2000)
    receipt = page.locator('[role="dialog"]').filter(has_text="Cash rounding")
    if receipt.count() > 0:
        ok("receipt dialog shows the Cash rounding row")
        amt = receipt.get_by_text("Amount due (cash)", exact=False)
        (ok if amt.count() > 0 else bad)("receipt shows Amount due (cash)")
    else:
        bad("receipt dialog lacks Cash rounding row")
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)

    # find the new invoice for reprint + cleanup
    st, sales, _ = api("GET", "/api/sales?search=&status=", cookie=cookie)
    inv = None
    for s in sales.get("sales", []):
        if abs(s["total"] - TOTAL) < 0.005 and abs(s.get("paidAmount", 0) - ROUND) < 0.005:
            inv = s; break
    if inv:
        ok(f"booked sale {inv['invoiceNo']} carries rounding (paid {inv['paidAmount']} of total {inv['total']})")
        # reprint through the Sales page
        page.click('text="Sales & Invoices"')
        page.wait_for_timeout(1800)
        page.locator('input[placeholder*="earch"], input[type="search"], input[aria-label*="earch"]').first.fill(inv["invoiceNo"])
        page.wait_for_timeout(1200)
        row = page.locator('table tbody tr').filter(has_text=inv["invoiceNo"]).first
        row.locator('button[aria-label="View invoice"]').click()
        page.wait_for_timeout(1200)
        page.locator('button:has-text("Thermal Receipt")').click()
        page.wait_for_timeout(900)
        pr = page.locator('[role="dialog"]').filter(has_text="Cash rounding")
        (ok if pr.count() > 0 else bad)("reprint (Sales page) shows the Cash rounding row")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # cleanup: cancel the fixture sale
        st, _, _ = api("DELETE", f"/api/sales/{inv['id']}", cookie=cookie)
        if st == 200: ok("fixture sale cancelled")
        else: bad(f"fixture sale cancel failed ({st})")
    else:
        bad("booked sale not found in sales list")

    # restore setting
    st, _, _ = api("PUT", "/api/settings", {"cashRounding": "none"}, cookie)
    if st == 200: ok("cashRounding restored to none")
    else: bad(f"restore failed ({st})")

    if errors:
        bad(f"page errors: {errors[:3]}")
    elif not FAILS:
        ok("zero page errors")

    browser.close()

print()
print("ALL GREEN" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}")
sys.exit(1 if FAILS else 0)
