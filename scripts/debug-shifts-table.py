"""Debug: dump admin Shift Management table structure."""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
    pg.goto(BASE, wait_until="networkidle")
    pg.fill("input[name=username], #username, input[type=text]", "admin")
    pg.fill("input[type=password]", "admin123")
    pg.click("button[type=submit]")
    pg.wait_for_timeout(2500)
    pg.click("text=Shift Management")
    pg.wait_for_timeout(2000)
    print("URL/view markers:", pg.locator("h2:has-text('Shift History')").count())
    n = pg.locator("tbody tr").count()
    print("tbody tr count:", n)
    for i in range(min(3, n)):
        tr = pg.locator("tbody tr").nth(i)
        cells = tr.locator("td")
        print(f"--- row {i}: {cells.count()} cells")
        for j in range(cells.count()):
            print(f"  td[{j}] = {cells.nth(j).inner_text().strip()[:60]!r}")
    b.close()
