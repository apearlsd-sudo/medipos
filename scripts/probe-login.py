import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1280, "height": 800})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(f"console.{m.type}: {m.text[:200]}") if m.type == "error" else None)
    resp = page.goto(BASE, wait_until="networkidle")
    print("STATUS", resp.status if resp else None)
    print("URL", page.url)
    print("TITLE", page.title())
    print("INPUTS", page.locator("input").count())
    print("BODY_HEAD", page.inner_text("body")[:300].replace("\n", " | "))
    print("ERRORS", errs[:6])
    page.screenshot(path="/tmp/login-probe.png")
    b.close()
