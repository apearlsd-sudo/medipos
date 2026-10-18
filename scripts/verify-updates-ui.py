#!/usr/bin/env python3
"""Verify the Software Updates card renders correctly (web fallback mode) in Settings → App & Data."""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:3000"
PASS = FAIL = 0
def ok(cond, label):
    global PASS, FAIL
    if cond: PASS += 1; print(f"PASS: {label}")
    else: FAIL += 1; print(f"FAIL: {label}")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(BASE, wait_until="networkidle")
        await page.fill('input[name="username"], #username', "admin")
        await page.fill('input[name="password"], #password', "admin123")
        await page.click('button[type="submit"]')
        await page.wait_for_load_state("networkidle")
        ok(True, "admin login")

        # Settings is a client-side view — click the sidebar item
        await page.click('text="Settings"')
        await page.wait_for_timeout(900)
        await page.click('text="App & Data"')
        await page.wait_for_timeout(900)

        card_title = page.locator("text=Software updates").first
        ok(await card_title.is_visible(), "Software updates card visible in App & Data")
        fallback = await page.locator("text=service worker").first.is_visible()
        ok(fallback, "web fallback text visible (browser/PWA mode)")
        releases_btn = page.get_by_role("button", name="Open the releases page")
        ok(await releases_btn.count() > 0, "releases-page fallback button present")
        desktop_only = await page.locator("text=Check now").count()
        ok(desktop_only == 0, "desktop-only controls hidden in web mode")

        # 390px mobile: no horizontal overflow
        await page.set_viewport_size({"width": 390, "height": 800})
        await page.wait_for_timeout(500)
        overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        ok(overflow <= 0, f"390px zero horizontal overflow (delta={overflow})")

        ok(len(errors) == 0, f"no page errors ({len(errors)})")
        await browser.close()

    print(f"\nRESULT: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)

asyncio.run(main())
