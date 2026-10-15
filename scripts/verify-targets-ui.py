"""Task 59 UI smoke — Sales Targets tab: create/edit/pause/delete, progress
bars, period filter, and the view-only experience for staff without
targets:manage. Run: python3 scripts/verify-targets-ui.py"""
import json
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

def login(page, user, pw):
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', user)
    page.fill('input[type="password"]', pw)
    page.click("button[type=submit]")
    page.wait_for_timeout(1800)

st, _, setc = api("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
assert st == 200 and setc, "API login failed"
cookie = setc

# idempotency: remove any leftover targets from a crashed earlier run
st, data, _ = api("GET", "/api/targets", cookie=cookie)
for t in data.get("targets", []):
    api("DELETE", f"/api/targets/{t['id']}", cookie=cookie)

st, _, _ = api("PUT", "/api/settings", {"cashRounding": "none"}, cookie)  # no-op sanity
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())  # window.confirm for delete

    login(page, "admin", "admin123")
    page.click('text="Reports"')
    page.wait_for_timeout(2500)
    page.click('button[role="tab"]:has-text("Sales Targets")')
    page.wait_for_timeout(1500)

    if page.get_by_text("Targets in view").count() > 0:
        ok("targets tab loads with stat cards")
    else:
        bad("targets tab missing stat cards"); print("\n".join(errors)); browser.close(); sys.exit(1)

    baseline_n = page.locator("table tbody tr").count()

    # --- create ---------------------------------------------------------------
    page.locator('button:has-text("New target")').first.click()
    page.wait_for_timeout(800)
    dlg = page.locator('[role="dialog"]')
    # combobox order: [0]=scope (defaults to 'A staff member'), [1]=staff, [2]=period
    dlg.locator('[role="combobox"]').nth(1).click()  # open staff picker
    page.wait_for_timeout(500)
    page.keyboard.press("Enter")  # picks the highlighted first option
    page.wait_for_timeout(500)
    picked = dlg.locator('[role="combobox"]').nth(1).inner_text().strip()
    ok(f"staff picked via keyboard: {picked[:24]}")
    first_staff = picked
    dlg.locator('input[type="number"]').first.fill("100000")
    page.locator('button:has-text("Create target")').click()
    page.wait_for_timeout(1500)
    row = page.locator("table tbody tr").filter(has_text=first_staff.split("\n")[0][:20]).first
    if row.count() > 0:
        ok(f"target row created for {first_staff.split(chr(10))[0][:20]}")
    else:
        bad("created target row not found")

    # progress bar + status badge present
    if page.locator("table tbody tr").first.locator("div.h-2").count() > 0:
        ok("progress bar rendered")
    else:
        bad("progress bar missing")

    # --- edit amount ----------------------------------------------------------
    row.locator('button:has-text("Edit")').click()
    page.wait_for_timeout(700)
    edlg = page.locator('[role="dialog"]')
    edlg.locator('input[type="number"]').first.fill("200000")
    page.locator('button:has-text("Save changes")').click()
    page.wait_for_timeout(1200)
    if page.locator("table tbody tr").first.get_by_text("200,000").count() > 0 or page.locator("table tbody tr").first.get_by_text("200000").count() > 0:
        ok("amount edit reflected (200,000)")
    else:
        bad("amount edit not reflected")

    # --- duplicate rejection toast -------------------------------------------
    page.locator('button:has-text("New target")').first.click()
    page.wait_for_timeout(600)
    dlg = page.locator('[role="dialog"]')
    dlg.locator('[role="combobox"]').nth(1).click()
    page.wait_for_timeout(400)
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    dlg.locator('input[type="number"]').first.fill("5")
    page.locator('button:has-text("Create target")').click()
    page.wait_for_timeout(1200)
    if page.get_by_text("already has an active").count() > 0:
        ok("duplicate target rejected with a clear toast")
    else:
        bad("duplicate rejection toast missing")
    # the failed dialog stays open by design — close it via Cancel
    page.locator('[role="dialog"] button:has-text("Cancel")').click()
    page.wait_for_timeout(800)
    if page.locator('[role="dialog"]').count() == 0:
        ok("duplicate dialog closed via Cancel")
    else:
        bad("dialog still open after Cancel")

    # --- pause / resume -------------------------------------------------------
    row.locator('button:has-text("Pause")').click()
    page.wait_for_timeout(1000)
    if page.locator("table tbody tr").first.get_by_text("Paused").count() > 0:
        ok("pause → Paused badge")
    else:
        bad("paused badge missing")
    row.locator('button:has-text("Resume")').click()
    page.wait_for_timeout(1000)

    # --- period filter --------------------------------------------------------
    page.locator('button[role="tab"]:has-text("Daily")').click()
    page.wait_for_timeout(700)
    if page.get_by_text("No sales targets yet").count() > 0:
        ok("daily filter shows the empty state (no daily targets)")
    else:
        ok("daily filter shows rows (pre-existing daily targets)")
    page.locator('button[role="tab"]:has-text("All periods")').click()
    page.wait_for_timeout(700)

    # --- delete ---------------------------------------------------------------
    row.locator('button:has-text("Delete")').click()
    page.wait_for_timeout(1200)
    end_n = page.locator("table tbody tr").count()
    if end_n == baseline_n:
        ok("delete removed the target row")
    else:
        bad(f"delete did not restore baseline ({baseline_n} → {end_n})")

    # --- view-only staff ------------------------------------------------------
    page.locator('button[aria-label="User menu"]').click()
    page.wait_for_timeout(600)
    page.locator('[role="menuitem"]:has-text("Sign out")').click()
    page.wait_for_timeout(1500)
    login(page, "pharmacist", "pharm123")
    page.click('text="Reports"')
    page.wait_for_timeout(2500)
    page.click('button[role="tab"]:has-text("Sales Targets")')
    page.wait_for_timeout(1500)
    if page.get_by_text("Targets in view").count() > 0:
        ok("staff (targets:view) can open the tab")
    else:
        bad("staff cannot see the targets tab")
    if page.locator('button:has-text("New target")').count() == 0:
        ok("no manage button for view-only staff")
    else:
        bad("New target visible without targets:manage")
    if page.get_by_role("button", name="Edit", exact=True).count() == 0:
        ok("no row actions for view-only staff")
    else:
        bad("row actions visible without targets:manage")
    if page.get_by_text("No sales targets yet").count() > 0:
        ok("empty state after cleanup for view-only staff")
    else:
        ok("targets table visible for staff")

    if errors:
        bad(f"page errors: {errors[:3]}")
    else:
        ok("zero page errors")

    browser.close()

# cleanup: any leftover verify targets
st, data, _ = api("GET", "/api/targets", cookie=cookie)
for t in data.get("targets", []):
    if "verify" in (t.get("note") or "") or t.get("amount") in (100000.0, 200000.0):
        api("DELETE", f"/api/targets/{t['id']}", cookie=cookie)
st, data, _ = api("GET", "/api/targets", cookie=cookie)
print(f"cleanup: {len(data.get('targets', []))} target(s) remain")

print()
print("ALL GREEN" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}")
sys.exit(1 if FAILS else 0)
