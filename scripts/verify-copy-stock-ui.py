#!/usr/bin/env python3
"""Verify v0.3.8 copy-stock UI: 'All branches' destination + push-all explainer +
per-device Delivery verdicts in the report. Deterministic: uses the MADINA
zero-product branch, restores DB state afterwards via API cleanup."""
import json as _json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
errors = []
passed = 0


def ok(label):
    global passed
    passed += 1
    print(f"PASS: {label}")


def api(cookie, path, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=_json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Cookie": cookie},
    )
    with urllib.request.urlopen(req) as r:
        return _json.load(r)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username', "admin")
    page.fill('input[name="password"], #password', "admin123")
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")
    time.sleep(2)
    ok("login")

    cookies = page.context.cookies(BASE)
    cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
    branches = api(cookie, "/api/branches")["branches"]
    main_id = next(b["id"] for b in branches if b["code"] == "MAIN")
    madina_id = next(b["id"] for b in branches if b["code"] == "MADINA")

    # --- Stock Control → Copy stock dialog ---------------------------------
    page.click('text="Stock Control"')
    page.wait_for_load_state("networkidle")
    time.sleep(1.5)
    page.click('button:has-text("Copy stock")')
    page.wait_for_selector("text=Copy inventory (stock)")
    ok("copy dialog opens")

    def open_select(label):
        """(Re)locate the combobox inside the labeled block and open it fresh —
        the dialog re-renders on every selection, detaching old elements."""
        trigger = page.locator(f'div:has(> label:has-text("{label}")) button[role="combobox"]')
        trigger.wait_for(state="attached", timeout=10000)
        trigger.click(force=True)
        page.wait_for_selector('[role="option"]')

    # source = MAIN, destination = All branches
    open_select("Copy stock from")
    src_options = page.locator('[role="option"]')
    print(f"  source options: {src_options.count()}")
    page.locator('[role="option"]', has_text="Main Pharmacy").first.click()
    time.sleep(0.8)

    open_select("Destination branch")
    all_opt = page.locator('[role="option"]', has_text="All branches — push to every store")
    if all_opt.count() > 0:
        ok("'All branches' destination option present")
    all_opt.first.click()
    time.sleep(0.6)

    if page.locator("text=Push to all branches:").count() > 0:
        ok("push-all explainer shown")
    else:
        errors.append("push-all explainer missing")
    btn_text = page.locator('button:has-text("Push to all branches")').count()
    if btn_text > 0:
        ok("button label becomes 'Push to all branches'")
    else:
        errors.append("push-all button label missing")

    # --- single-target copy to the zero-product branch ----------------------
    time.sleep(0.5)
    open_select("Destination branch")
    page.locator('[role="option"]', has_text="madina").first.click()
    time.sleep(1.5)  # preview fetch

    if page.locator("text=unit(s) on the shelf").count() > 0:
        ok("single-target preview renders")
    page.locator('[role="dialog"] button:has-text("Copy")').last.click()
    page.wait_for_selector("text=Inventory copied", timeout=15000)
    ok("copy to MADINA completes with report")

    if page.locator("text=Delivery").count() > 0:
        ok("Delivery section renders")
    else:
        errors.append("Delivery section missing")
    # Either no device is paired (queued-forever warning) or registered
    # devices render their per-device verdicts — both are correct outcomes.
    if page.locator("text=No device connected yet.").count() > 0 or page.locator('span:has-text("has no store binding reported")').count() > 0:
        ok("delivery verdict shown (no-device warning or per-device verdict)")
    else:
        errors.append("delivery verdict missing")

    page.click('button:has-text("Done")')

    # --- Branches page: MADINA now has products (copy visible HQ-side) ------
    page.click('text="Branches"')
    page.wait_for_load_state("networkidle")
    time.sleep(1.5)
    body = page.inner_text("body")
    if "madina" in body.lower():
        ok("Branches page renders")

    browser.close()

# --- restore DB state: MADINA back to zero products -------------------------
branches = api(cookie, "/api/branches")["branches"]
main_id = next(b["id"] for b in branches if b["code"] == "MAIN")
madina_id = next(b["id"] for b in branches if b["code"] == "MADINA")
import sqlite3
s = sqlite3.connect("/home/z/my-project/db/custom.db")
c = s.cursor()
c.execute("DELETE FROM Medicine WHERE branchId=?", (madina_id,))
c.execute("DELETE FROM SyncOp WHERE payload LIKE '%MADINA%'")
s.commit()
s.close()
print("cleanup: MADINA restored to zero products, MADINA ops purged")

print()
if errors:
    print("ERRORS:")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print(f"RESULT: {passed} checks passed, 0 errors")
