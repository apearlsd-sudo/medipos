"""Evidence screenshots for shift-visibility (Task 51)."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
OUT = "/home/z/my-project/scripts"

with sync_playwright() as p:
    b = p.chromium.launch()
    for user, pwd, name in [
        ("admin", "admin123", "admin_allstaff"),
        ("linda", "linda123", "linda_own"),
        ("pharmacist", "pharm123", "pharm_own"),
    ]:
        pg = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
        pg.goto(BASE, wait_until="networkidle")
        pg.fill("input[name=username], #username, input[type=text]", user)
        pg.fill("input[type=password]", pwd)
        pg.click("button[type=submit]")
        pg.wait_for_timeout(2500)
        pg.click("text=Shift Management")
        pg.wait_for_selector("h2:text-is('Shift History')", timeout=8000)
        pg.wait_for_timeout(1200)
        pg.screenshot(path=f"{OUT}/verify_shifts_{name}.png", full_page=False)
        print(f"saved verify_shifts_{name}.png")
        pg.context.close()
    b.close()
