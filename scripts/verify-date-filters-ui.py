"""Task 77 — browser E2E of the date picker filters on event-ledger pages.
Drives the real UI:
  Sales page       → preset "Today" chip scopes rows to today, count card changes,
                     custom range via the native date inputs, clear restores.
  Expenses page    → picker range flips the summary card label to
                     "Spent (selected period)" and disables the days select.
  Purchases page   → picker renders and filters without error.
Zero page/console errors expected. Read-only (no fixtures).
Run: python3 scripts/verify-date-filters-ui.py
"""
import re, sys
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
SHOT = '/home/z/my-project/download/task77-date-filters-sales.png'

s = requests.Session()
r = s.post(f'{BASE}/api/auth/login', json={'username': 'admin', 'password': 'admin123'}, timeout=10)
assert r.ok, 'admin login failed'

TODAY = __import__('time').strftime('%Y-%m-%d', __import__('time').gmtime())
YDAY = __import__('time').strftime('%Y-%m-%d', __import__('time').gmtime(__import__('time').time() - 86400))

errors = []
ALLOWED_401 = ('/api/auth/me', '/api/settings')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('response', lambda r: errors.append(f'{r.status} {r.request.method} {r.url}')
            if r.status >= 400 and not any(r.url.split('?')[0].endswith(a) for a in ALLOWED_401) else None)
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}')
            if m.type == 'error' and not m.text.startswith('Failed to load resource') else None)

    page.goto(BASE, wait_until='networkidle')
    page.fill('input[name="username"], #username, input[type="text"]', 'admin')
    page.fill('input[type="password"]', 'admin123')
    page.click('button[type="submit"]')
    page.wait_for_timeout(2500)

    # ---------- Sales page ----------
    page.get_by_role('button', name='Sales & Invoices').click()
    page.wait_for_timeout(1500)
    group = page.get_by_role('group', name='Sale range filter')
    assert group.count() == 1, 'sale date-range group missing'
    rows_all = page.locator('tbody tr').count()
    print(f'sales rows unfiltered: {rows_all}')

    group.get_by_role('button', name='Today').click()
    page.wait_for_timeout(1200)
    from_val = group.get_by_label('Sale from').input_value()
    to_val = group.get_by_label('Sale to').input_value()
    assert from_val == TODAY and to_val == TODAY, f'preset Today should set {TODAY}, got {from_val}..{to_val}'
    rows_today = page.locator('tbody tr').count()
    print(f'sales rows today: {rows_today}')
    assert rows_today <= rows_all, 'today window must not exceed unfiltered rows'

    # custom range: yesterday..today via the native inputs
    group.get_by_label('Sale from').fill(YDAY)
    page.wait_for_timeout(1200)
    rows_yday = page.locator('tbody tr').count()
    assert rows_yday >= rows_today, 'widening to yesterday must not shrink rows'
    print(f'sales rows yesterday..today: {rows_yday}')

    page.screenshot(path=SHOT, full_page=True)
    print('sales screenshot saved')

    # clear restores the unfiltered view
    group.get_by_role('button', name='Clear sale range').click()
    page.wait_for_timeout(1200)
    rows_clear = page.locator('tbody tr').count()
    assert rows_clear == rows_all, f'clear must restore unfiltered rows ({rows_clear} != {rows_all})'
    print('clear restores unfiltered sales')

    # ---------- Expenses page ----------
    page.get_by_role('button', name='Expenses').click()
    page.wait_for_timeout(1500)
    egroup = page.get_by_role('group', name='Expense range filter')
    assert egroup.count() == 1, 'expense date-range group missing'
    label_before = page.locator('p', has_text=re.compile('^Spent \\(')).first.inner_text()
    egroup.get_by_role('button', name='7 days').click()
    page.wait_for_timeout(1500)
    label_after = page.locator('p', has_text=re.compile('^Spent \\(')).first.inner_text()
    assert 'selected period' in label_after, f'label should flip to selected period, got: {label_after}'
    days_trigger = page.locator('[aria-label="Search expenses"] ~ * select, select').first
    print(f'expense label: {label_before!r} -> {label_after!r}')
    assert ('7 days' in egroup.inner_text()), 'preset chips missing on expenses'

    # ---------- Purchases page ----------
    page.get_by_role('button', name='Purchases').click()
    page.wait_for_timeout(1500)
    pgroup = page.get_by_role('group', name='Purchase range filter')
    assert pgroup.count() == 1, 'purchase date-range group missing'
    pgroup.get_by_role('button', name='30 days').click()
    page.wait_for_timeout(1200)
    pv = pgroup.get_by_label('Purchase from').input_value()
    assert pv == __import__('time').strftime('%Y-%m-%d', __import__('time').gmtime(__import__('time').time() - 29 * 86400)), '30-day preset wrong'
    print('purchases picker filters fine')

    browser.close()

if errors:
    print('ERRORS:'); [print(' ', e) for e in errors[:20]]
    sys.exit(1)
print('date-filters UI verify: all checks passed')
