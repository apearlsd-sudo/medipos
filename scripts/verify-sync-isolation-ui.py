#!/usr/bin/env python3
"""v0.3.5 UI verify — store binding (role card + locked pill) + Copy stock dialog.

Part A (HQ :3000): Stock Control → "Copy stock" dialog: source/target/mode/
batch checkbox + live preview counting units.
Part B (isolated branch server on :3102, fresh db snapshot + own config file):
Settings → "This device's store" select, Save & connect, header locked pill,
persistence across reload, unbind reverts the pill.
Deterministic cleanup: branch process killed, temp db/config removed, main
server untouched. Zero page errors expected.
"""
import json
import os
import signal
import subprocess
import time
import urllib.request
import urllib.error

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
BR = "http://localhost:3102"
RESULTS = []


def ok(name, cond, extra=""):
    RESULTS.append((bool(cond), name, extra))
    print(("PASS: " if cond else "FAIL: ") + name + (f" ({extra})" if extra else ""))


def api(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}"), dict(e.headers)


def login_cookie(base):
    with urllib.request.urlopen(urllib.request.Request(base + "/api/auth/login", data=json.dumps({"username": "admin", "password": "admin123"}).encode(), method="POST")) as r:
        setc = r.headers.get("Set-Cookie", "")
    return setc.split(";")[0] if setc else ""


def ui_login(page, base):
    page.goto(base, wait_until="networkidle")
    page.fill('input[name="username"], #username', "admin")
    page.fill('input[name="password"], #password', "admin123")
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")


def navigate(page, label):
    """Sidebar navigation — views are client state, not URLs."""
    page.click(f'sidebar >> text="{label}"') if page.locator("sidebar").count() else page.click(f'text="{label}"')
    page.wait_for_timeout(700)


def spawn_branch():
    db = "/tmp/v35-branch.db"
    cfg = "/tmp/v35-branch.config.json"
    for f in (db, db + "-journal", cfg):
        if os.path.exists(f):
            os.remove(f)
    subprocess.run(["python3", "-c",
                    "import sqlite3; s=sqlite3.connect('db/custom.db'); s.execute(\"VACUUM INTO '/tmp/v35-branch.db'\"); s.close()"],
                   cwd="/home/z/my-project", check=True)
    key = open("/home/z/my-project/.secrets/sync-key").read().strip() if os.path.exists("/home/z/my-project/.secrets/sync-key") else "medipos-hq-sync-key"
    env = dict(os.environ,
               NODE_ENV="production", PORT="3102", HOSTNAME="0.0.0.0",
               DATABASE_URL=f"file:{db}",
               MEDIPOS_CONFIG_FILE=cfg,
               SYNC_ROLE="branch", SYNC_NODE_ID="V35", SYNC_NODE_NAME="V35 Verify Branch",
               SYNC_KEY=key, SYNC_HQ_URL="http://127.0.0.1:3003",
               SYNC_INTERVAL_MS="15000", SYNC_DISCOVERY_PORT="47805", SYNC_DISCOVERY_TARGETS="127.0.0.1:47800")
    proc = subprocess.Popen(["node", ".next/standalone/server.js"], cwd="/home/z/my-project", env=env,
                            stdout=open("/tmp/v35-branch.log", "w"), stderr=subprocess.STDOUT,
                            preexec_fn=os.setsid)
    for _ in range(60):
        try:
            code, _, _ = api(BR, "GET", "/api/health")
            if code == 200:
                return proc
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("branch server did not come up")


def main():
    cookie_hq = login_cookie(BASE)

    # branch list (for dialog selects)
    _, bl, _ = api(BASE, "GET", "/api/branches", headers={"Cookie": cookie_hq})
    branches = [b for b in bl.get("branches", []) if b.get("isActive")]
    mainb = next((b for b in branches if b["code"] == "MAIN"), branches[0] if branches else None)
    target = next((b for b in branches if b["code"] != "MAIN"), None)

    branch_proc = None
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        def on_console(m):
            if m.type != "error" or "favicon" in m.text.lower():
                return
            # pre-login session probes legitimately 401/403 on a fresh context
            if "401" in m.text or "403" in m.text:
                return
            errors.append(m.text)
        page.on("console", on_console)

        # --- Part A: Copy stock dialog on the HQ ----------------------------
        ui_login(page, BASE)
        page.click('text="Stock Control"')
        page.wait_for_timeout(900)
        btn = page.get_by_role("button", name="Copy stock").first
        ok("A1 Copy stock button on Stock Control", btn.count() > 0)
        btn.click()
        page.wait_for_timeout(600)
        dlg = page.locator("[role='dialog']")
        ok("A2 dialog opens", "Copy inventory" in (dlg.inner_text() if dlg.count() else ""))
        body = dlg.inner_text()
        ok("A3 mode radios", ("Overwrite quantities" in body) and ("Only add missing" in body))
        ok("A4 batch/expiry checkbox", "batch" in body.lower())
        triggers = dlg.locator("button[role='combobox']")
        picked = False
        if triggers.count() >= 2 and mainb and target:
            triggers.nth(0).click(); page.wait_for_timeout(300)
            page.get_by_role("option", name=mainb["name"]).first.click(); page.wait_for_timeout(250)
            triggers.nth(1).click(); page.wait_for_timeout(300)
            page.get_by_role("option", name=target["name"]).first.click(); page.wait_for_timeout(1500)
            body2 = dlg.inner_text()
            picked = "unit(s)" in body2
            ok("A5 live preview counts units", picked, "preview loaded")
        else:
            ok("A5 live preview counts units", False, f"triggers={triggers.count()}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        # --- Part B: store binding on an isolated branch device --------------
        branch_proc = spawn_branch()
        try:
            ui_login(page, BR)
            page.click('text="Settings"')
            page.wait_for_timeout(600)
            page.click('button:has-text("Sync & Devices")')
            page.wait_for_timeout(900)
            sel = page.locator('[data-testid="sync-branch-store"]')
            ok("B1 store select visible on branch device", sel.count() > 0)
            if sel.count() and target:
                sel.click(); page.wait_for_timeout(300)
                page.get_by_role("option", name=target["name"]).first.click(); page.wait_for_timeout(250)
                page.locator('[data-testid="sync-role-save"]').first.click()
                page.wait_for_timeout(1500)
                saved = json.load(open("/tmp/v35-branch.config.json")) if os.path.exists("/tmp/v35-branch.config.json") else {}
                ok("B2 binding persisted to branch config file", saved.get("branchCode") == target["code"], str(saved.get("branchCode")))

                page.goto(BR, wait_until="networkidle")
                page.wait_for_timeout(1500)
                pill = page.locator('[data-testid="branch-locked-pill"]')
                ok("B3 header shows locked store pill", pill.count() > 0, pill.inner_text() if pill.count() else "")
                ok("B4 branch switcher hidden while bound", page.locator("header button:has-text('All branches')").count() == 0)

                # reload — binding survives
                page.reload(wait_until="networkidle")
                page.wait_for_timeout(1500)
                ok("B5 pill persists after reload", page.locator('[data-testid="branch-locked-pill"]').count() > 0)

                # 390px — settings still overflow-free on the branch device
                page.set_viewport_size({"width": 390, "height": 800})
                page.reload(wait_until="networkidle")
                page.wait_for_timeout(800)
                page.click('button[aria-label="Open menu"]')  # mobile hamburger
                page.wait_for_timeout(400)
                page.locator('text="Settings"').locator("visible=true").first.click()
                page.wait_for_timeout(600)
                page.click('button:has-text("Sync & Devices")')
                page.wait_for_timeout(800)
                overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                ok("B6 390px no horizontal overflow", overflow <= 0, f"overflowX={overflow}px")
        finally:
            # cleanup: kill the branch process tree, remove temp files
            if branch_proc:
                try:
                    import time as _t
                    os.killpg(os.getpgid(branch_proc.pid), signal.SIGTERM)
                    for _ in range(20):
                        if branch_proc.poll() is not None:
                            break
                        _t.sleep(0.5)
                    if branch_proc.poll() is None:
                        os.killpg(os.getpgid(branch_proc.pid), signal.SIGKILL)
                        branch_proc.wait(timeout=10)
                except Exception:
                    try:
                        os.killpg(os.getpgid(branch_proc.pid), signal.SIGKILL)
                    except Exception:
                        pass
                subprocess.run(["bash", "-c", "fuser -k 3102/tcp 2>/dev/null; true"])
            for f in ("/tmp/v35-branch.db", "/tmp/v35-branch.db-journal", "/tmp/v35-branch.config.json"):
                if os.path.exists(f):
                    os.remove(f)

        ok("zero page errors", len([e for e in errors if "hydrat" not in e.lower()]) == 0, "; ".join(errors[:3]))
        browser.close()

    passed = sum(1 for s, _, _ in RESULTS if s)
    print(f"\nRESULT: {passed}/{len(RESULTS)} passed")
    raise SystemExit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
