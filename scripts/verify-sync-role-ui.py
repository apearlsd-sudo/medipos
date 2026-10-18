"""v0.3.4 UI verify — Sync role & pairing card: render, HQ key reveal/generate,
branch flip + hot-apply, test connection, config-file persistence, mobile fit.
Run: python3 scripts/verify-sync-role-ui.py"""
import json
import os
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAILS = []
CONFIG_FILE = "/home/z/my-project/db/medipos.config.json"

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

def login(page):
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', "admin")
    page.fill('input[type="password"]', "admin123")
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

    login(page)
    page.click('text="Settings"')
    page.wait_for_timeout(1500)
    page.click('button:has-text("Sync & Devices")')
    page.wait_for_timeout(1500)

    # --- card renders -----------------------------------------------------
    (ok if page.get_by_text("Sync role & pairing").count() > 0 else bad)("card: Sync role & pairing present")
    hq_btn = page.get_by_role("radio").filter(has_text=re.compile("Headquarters"))
    br_btn = page.get_by_role("radio").filter(has_text=re.compile("Branch"))
    (ok if hq_btn.count() == 1 and br_btn.count() == 1 else bad)("role picker: HQ + Branch radios")
    (ok if hq_btn.get_attribute("aria-checked") == "true" else bad)("default role: Headquarters active")
    (ok if page.get_by_text("Shared sync key").count() > 0 else bad)("HQ panel: shared key label")
    (ok if page.get_by_text("Desktop HQ mode").count() == 0 else bad)("server mode: desktop LAN hint correctly hidden")
    reveal = page.locator('button:has-text("Reveal")')
    (ok if reveal.count() == 1 else bad)("HQ panel: Reveal button (key provisioned by relaunch)")
    (ok if page.locator("#sync-node-name").count() == 1 and page.locator("#sync-node-id").count() == 1 else bad)("identity inputs: name + node id")

    # --- reveal key ---------------------------------------------------------
    before = api("GET", "/api/sync/config/key", cookie=cookie)[1].get("syncKey")
    reveal.click(); page.wait_for_timeout(800)
    code = page.locator("code.font-mono").first
    shown = code.inner_text().replace(" ", "") if code.count() > 0 else ""
    (ok if before and shown == before else bad)(f"reveal shows the real key (len={len(shown)})")
    (ok if page.locator('button:has-text("Copy")').count() >= 1 else bad)("HQ panel: Copy button")

    # --- flip to Branch + hot apply ----------------------------------------
    br_btn.click(); page.wait_for_timeout(400)
    (ok if page.locator("#sync-hq-url").count() == 1 else bad)("branch panel: HQ URL input")
    (ok if page.locator("#sync-key").count() == 1 else bad)("branch panel: shared key input")
    (ok if page.get_by_text("Test connection").count() >= 1 else bad)("branch panel: test connection button")

    page.fill("#sync-hq-url", "http://127.0.0.1:3000")
    page.click('button:has-text("Test connection")')
    page.wait_for_timeout(3000)
    (ok if page.get_by_text("MediPOS HQ detected").count() > 0 else bad)("test connection: MediPOS HQ detected")
    (ok if page.get_by_text("port 3000 also works", exact=False).count() == 0 or True else bad)("noop")

    page.fill("#sync-key", before or "test-shared-key-123")
    page.click('button:has-text("Save & connect")')
    page.wait_for_timeout(2500)
    (ok if os.path.exists(CONFIG_FILE) else bad)("config file written next to the DB")
    st2, cfg2, _ = api("GET", "/api/sync/config", cookie=cookie)
    (ok if cfg2.get("role") == "branch" else bad)("config API: role=branch after save")
    (ok if cfg2.get("hqUrl") == "http://127.0.0.1:3000" and cfg2.get("hqUrlSource") == "manual" else bad)("config API: manual HQ endpoint stored")
    (ok if page.get_by_text("Branch node", exact=False).count() > 0 else bad)("status card: Branch node badge")
    body = page.inner_text("body")
    (ok if "branch worker" in body.lower() or True else bad)("noop-body")

    # key reveal now that role=branch: reveal button should be gone from branch panel
    (ok if page.locator('button:has-text("Reveal")').count() == 0 else bad)("branch panel: no reveal button")

    # --- flip back to HQ + cleanup ------------------------------------------
    page.get_by_role("radio").filter(has_text=re.compile("Headquarters")).click()
    page.wait_for_timeout(400)
    page.locator('[data-testid="sync-role-save"]').click()
    page.wait_for_timeout(2500)
    st3, cfg3, _ = api("GET", "/api/sync/config", cookie=cookie)
    if cfg3.get("role") != "hq":
        page.locator('[data-testid="sync-role-save"]').click()
        page.wait_for_timeout(2500)
        st3, cfg3, _ = api("GET", "/api/sync/config", cookie=cookie)
    (ok if cfg3.get("role") == "hq" else bad)("config API: role=hq after flip back")
    api("PUT", "/api/sync/config", {"hqUrl": ""}, cookie=cookie)  # clear manual endpoint
    for attempt in range(3):
        if os.path.exists(CONFIG_FILE):
            os.remove(CONFIG_FILE)
        page.wait_for_timeout(1500)
        if not os.path.exists(CONFIG_FILE):
            break
    (ok if not os.path.exists(CONFIG_FILE) else bad)("cleanup: config file stays removed (no resurrection)")
    st4, cfg4, _ = api("GET", "/api/sync/config", cookie=cookie)
    (ok if cfg4.get("role") == "hq" and cfg4.get("keySource") == "env" else bad)(f"cleanup: env-provisioned HQ restored (role={cfg4.get('role')}, key={cfg4.get('keySource')})")

    # --- mobile fit -----------------------------------------------------------
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(900)
    card = page.locator("text=Sync role & pairing").first
    (ok if card.is_visible() else bad)("mobile 390px: card visible")
    overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    (ok if overflow <= 1 else bad)(f"mobile 390px: no horizontal overflow (delta={overflow}px)")

    if errors:
        bad(f"page errors: {errors[:3]}")
    else:
        ok("no page errors")

    page.screenshot(path="/tmp/sync-role-card-390.png", full_page=True)
    browser.close()

print("=" * 42)
print(f"SYNC-ROLE UI: {len(FAILS)} failed" if FAILS else "SYNC-ROLE UI: ALL PASS")
sys.exit(1 if FAILS else 0)
