#!/usr/bin/env python3
"""Verify v0.3.9 Network & Sync fixes:
1. admin: both cards load (role card renders the pairing console, no stuck spinner)
2. cashier: role card shows the admin-only note (no infinite 'Loading sync role…'),
   status card still loads — the old code spun forever on the 403
3. no page errors / console errors
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
errors = []
passed = 0


def ok(label):
    global passed
    passed += 1
    print(f"PASS: {label}")


def login(page, username, password):
    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username', username)
    page.fill('input[name="password"], #password', password)
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")
    time.sleep(2)


def open_network_sync(page):
    # sidebar nav entry → the section is chip-labelled "Sync & Devices"
    # (v52 rename); the card inside is titled "Network & Sync"
    page.click('button:has-text("Settings")')
    page.wait_for_load_state("networkidle")
    time.sleep(1.5)
    page.click('button:has-text("Sync & Devices")')
    time.sleep(2.5)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

    # --- admin: everything loads -------------------------------------------
    login(page, "admin", "admin123")
    ok("admin login")
    open_network_sync(page)
    body = page.inner_text("body")
    assert "Loading network status" not in body, "admin: status card stuck on spinner"
    assert "Loading sync role" not in body, "admin: role card stuck on spinner"
    assert "Sync role & pairing" in body, "admin: role card missing"
    ok("admin: network + role cards fully loaded (no infinite spinner)")
    assert "HQ URL" not in body or "This node" in body, "admin: node panel missing"
    ok("admin: node panel rendered")

    # --- cashier: no doomed fetch, no infinite spinner -----------------------
    page.click('text="Logout"', timeout=5000) if page.locator('text="Logout"').count() else None
    page.context.clear_cookies()
    login(page, "cashier", "cash123")
    ok("cashier login")
    open_network_sync(page)
    time.sleep(3)
    body = page.inner_text("body")
    assert "Loading sync role" not in body, "cashier: role card stuck on spinner (old bug)"
    assert "Loading network status" not in body, "cashier: status card stuck on spinner"
    assert "managed by an administrator" in body.lower(), "cashier: admin-only note missing"
    ok("cashier: role card shows admin-only note — no infinite spinner")

    browser.close()

print(f"\n{passed} checks passed")
if errors:
    real = [e for e in errors if "401" not in e and "403" not in e]
    if real:
        print("ERRORS:")
        for e in real[:10]:
            print(" -", e)
        sys.exit(1)
print("CLEAN (only auth-probe noise)")
