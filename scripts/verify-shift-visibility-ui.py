"""Shift-history visibility E2E (UI) — Task 51.

Admin  : Shift Management shows the "all staff" badge + staff filter selector,
         and the table spans multiple cashiers; filtering by Linda narrows rows.
Linda  : "my history" badge, NO staff selector, every row is her own; opening
         her own shift detail works.
Pharm  : same own-only view (her single verification shift from the API suite).
0 page errors across all sessions.
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
OUT = "/home/z/my-project/scripts"
errors = []


def login(pg, username, password):
    pg.goto(BASE, wait_until="networkidle")
    pg.fill("input[name=username], #username, input[type=text]", username)
    pg.fill("input[type=password]", password)
    pg.click("button[type=submit]")
    pg.wait_for_timeout(2500)


def open_shifts(pg):
    pg.click("text=Shift Management")
    pg.wait_for_selector("h2:text-is('Shift History')", timeout=8000)
    pg.wait_for_timeout(1200)


def hist_rows(pg):
    """Rows of the Shift History table only (scoped by its unique 'Cashier' header)."""
    tbl = pg.locator("table:has(th:text-is('Cashier'))")
    out = []
    for i in range(tbl.locator("tbody tr").count()):
        cells = tbl.locator("tbody tr").nth(i).locator("td")
        vals = [cells.nth(j).inner_text().strip() for j in range(cells.count())]
        if vals and vals[0].startswith("SH-"):
            out.append(vals)
    return out


def distinct_cashiers(pg):
    return {r[1] for r in hist_rows(pg)}


with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------- ADMIN: sees all staff + filter ----------------
    ca = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ca.new_page()
    pg.on("pageerror", lambda e: errors.append(f"admin pageerror: {e}"))
    login(pg, "admin", "admin123")
    open_shifts(pg)

    badge = pg.locator("span:has-text('all staff')")
    assert badge.count() >= 1, "admin: 'all staff' badge missing"
    sel = pg.locator("button[aria-label='Filter by staff member']")
    assert sel.count() == 1, "admin: staff filter selector missing"
    names = distinct_cashiers(pg)
    assert len(names) >= 2, f"admin: expected >=2 cashiers in table, got {names}"
    print(f"ADMIN_OK all-staff badge + selector present, cashiers={sorted(names)}")

    # filter by Linda via the staff Select (Radix: open then pick option)
    sel.click()
    pg.wait_for_timeout(600)
    opt = pg.locator("[role=option]:has-text('Linda Asare')")
    if opt.count() == 0:  # fallback: synthetic pointerdown (headless quirk)
        pg.locator("button[aria-label='Filter by staff member']").dispatch_event(
            "pointerdown", {"pointerId": 1, "button": 0, "pointerType": "mouse", "isPrimary": True}
        )
        pg.wait_for_timeout(600)
        opt = pg.locator("[role=option]:has-text('Linda Asare')")
    opt.first.click()
    pg.wait_for_timeout(1200)
    filtered = distinct_cashiers(pg)
    assert filtered == {"Linda Asare"}, f"admin filter: expected only Linda, got {filtered}"
    print("ADMIN_FILTER_OK rows narrowed to Linda Asare")

    ca.close()

    # ---------------- LINDA (cashier): own history only ----------------
    cl = b.new_context(viewport={"width": 1440, "height": 900})
    pg = cl.new_page()
    pg.on("pageerror", lambda e: errors.append(f"linda pageerror: {e}"))
    login(pg, "linda", "linda123")
    open_shifts(pg)

    assert pg.locator("span:has-text('my history')").count() >= 1, "linda: 'my history' badge missing"
    assert pg.locator("span:has-text('all staff')").count() == 0, "linda: must NOT see all-staff badge"
    assert pg.locator("button[aria-label='Filter by staff member']").count() == 0, "linda: staff selector must be hidden"
    mine = distinct_cashiers(pg)
    assert mine == {"Linda Asare"}, f"linda: rows must be hers only, got {mine}"
    assert len(hist_rows(pg)) >= 1, "linda: expected her seeded shifts in the table"

    # open her own most recent shift detail
    pg.locator("button[aria-label^='View SH-']").first.click()
    pg.wait_for_timeout(1500)
    dlg = pg.locator("[role=dialog]")
    assert dlg.count() >= 1 and "Linda Asare" in dlg.first.inner_text(), "linda: own shift detail failed to open"
    print(f"LINDA_OK my-history badge, no selector, {len(hist_rows(pg))} own rows, own detail opens")
    pg.keyboard.press("Escape")
    cl.close()

    # ---------------- PHARMACIST: own-only after API-suite shift ----------------
    cp = b.new_context(viewport={"width": 1440, "height": 900})
    pg = cp.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pharm pageerror: {e}"))
    login(pg, "pharmacist", "pharm123")
    open_shifts(pg)

    assert pg.locator("span:has-text('my history')").count() >= 1, "pharm: 'my history' badge missing"
    assert pg.locator("button[aria-label='Filter by staff member']").count() == 0, "pharm: staff selector must be hidden"
    pm = distinct_cashiers(pg)
    assert pm == {"Dr. Abena Owusu"}, f"pharm: rows must be hers only, got {pm}"
    print(f"PHARM_OK my-history badge, no selector, rows={len(hist_rows(pg))} (own only)")
    cp.close()

    b.close()

    real = [e for e in errors if "favicon" not in str(e).lower()]
    assert not real, f"page errors: {real}"
    print("PAGE_ERRORS_ZERO")
    print("ALL_SHIFT_VISIBILITY_UI_CHECKS_PASSED")
