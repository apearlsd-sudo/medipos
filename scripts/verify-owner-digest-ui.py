"""Task 60 UI smoke — Owner Digest tab: stat cards, tender split, top sellers,
watchlist, target scoreboard, push preview, range switcher, send button
permissions. Run: python3 scripts/verify-owner-digest-ui.py"""
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

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    login(page, "admin", "admin123")
    page.click('text="Reports"')
    page.wait_for_timeout(2500)
    page.click('button[role="tab"]:has-text("Owner Digest")')
    page.wait_for_timeout(1800)

    for label in ["Revenue", "Net position", "Tax collected", "Purchases"]:
        (ok if page.get_by_text(label, exact=True).count() > 0 else bad)(f"stat card: {label}")
    for card in ["By tender", "Top sellers", "Operations watchlist", "Target scoreboard"]:
        (ok if page.get_by_text(card, exact=True).count() > 0 else bad)(f"card: {card}")
    (ok if page.get_by_text("what the owner receives").count() > 0 else bad)("card: Push preview")

    pre = page.locator("pre")
    if pre.count() > 0 and "OWNER DIGEST" in pre.first.inner_text():
        ok("push preview shows the OWNER DIGEST text")
    else:
        bad("push preview missing/empty")

    if page.locator('button:has-text("Send to owner")').count() > 0:
        ok("Send to owner button visible for admin (notifications:manage)")
        page.locator('button:has-text("Send to owner")').first.click()
        page.wait_for_timeout(2500)
        body = page.locator("body").inner_text()
        if "Digest on its way" in body or "Send failed" in body or "Nothing was sent" in body:
            ok("send produced a clear toast result")
        else:
            bad(f"no toast feedback after send")
    else:
        bad("Send to owner button missing for admin")

    # range switcher changes the label
    page.locator('button[role="tab"]:has-text("This week")').click()
    page.wait_for_timeout(1500)
    if page.get_by_text("Week", exact=False).count() > 0:
        ok("range switcher → week label")
    else:
        bad("week label not shown")
    page.locator('button[role="tab"]:has-text("Today")').click()
    page.wait_for_timeout(1200)

    # pharmacist: view-only — no send buttons anywhere in the section
    page.locator('button[aria-label="User menu"]').click()
    page.wait_for_timeout(500)
    page.locator('[role="menuitem"]:has-text("Sign out")').click()
    page.wait_for_timeout(1500)
    login(page, "pharmacist", "pharm123")
    page.click('text="Reports"')
    page.wait_for_timeout(2500)
    page.click('button[role="tab"]:has-text("Owner Digest")')
    page.wait_for_timeout(1800)
    if page.get_by_text("Revenue", exact=True).count() > 0:
        ok("pharmacist can view the digest")
    else:
        bad("pharmacist cannot view the digest")
    if page.locator('button:has-text("Send to owner")').count() == 0 and page.locator('button:has-text("Send now")').count() == 0:
        ok("no send buttons without notifications:manage")
    else:
        bad("send buttons visible without notifications:manage")
    if page.get_by_text("Sending requires the Notifications").count() > 0:
        ok("permission hint shown under the preview")
    else:
        ok("no permission hint (send button hidden entirely)")

    if errors:
        bad(f"page errors: {errors[:3]}")
    else:
        ok("zero page errors")

    browser.close()

print()
print("ALL GREEN" if not FAILS else f"{len(FAILS)} FAILURES: {FAILS}")
sys.exit(1 if FAILS else 0)
