"""Focused screenshot of the Sales filter bar with the date picker active."""
import requests, time
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
TODAY = time.strftime('%Y-%m-%d', time.gmtime())

s = requests.Session()
s.post(f'{BASE}/api/auth/login', json={'username': 'admin', 'password': 'admin123'}, timeout=10)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 520})
    page.goto(BASE, wait_until='networkidle')
    page.fill('input[name="username"], #username, input[type="text"]', 'admin')
    page.fill('input[type="password"]', 'admin123')
    page.click('button[type="submit"]')
    page.wait_for_timeout(2500)
    page.get_by_role('button', name='Sales & Invoices').click()
    page.wait_for_timeout(1500)
    g = page.get_by_role('group', name='Sale range filter')
    g.get_by_role('button', name='7 days').click()
    page.wait_for_timeout(1200)
    page.screenshot(path='/home/z/my-project/download/task77-date-filter-bar.png')
    browser.close()
print('saved task77-date-filter-bar.png')
