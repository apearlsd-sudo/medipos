"""Task 74 — browser E2E of the "keep — selling through" marker.
Plants 2 probe candidates via API, then drives the real UI:
Stock Control → Returns & Quarantine → Pre-Expiry Review →
row Keep button → dialog with note → toast + badge + summary chip →
Show filter (Needs a decision / Marked keep) → bulk keep from selection →
row Unmark → badge gone. Zero page/console errors expected.
Cleans up every probe row (markers cascade with the medicines).
Run: python3 scripts/verify-keep-marker-ui.py
"""
import re, sys, time
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
SHOT = '/home/z/my-project/download/task74-keep-marker-desk.png'

s = requests.Session()
r = s.post(f'{BASE}/api/auth/login', json={'username': 'admin', 'password': 'admin123'}, timeout=10)
assert r.ok, 'admin login failed'
CK = s.cookies.get_dict()['medipos_session']
H = {'Cookie': f'medipos_session={CK}'}

cat = s.get(f'{BASE}/api/categories', headers=H, timeout=10).json()['categories'][0]['id']
sup = s.post(f'{BASE}/api/suppliers', headers=H, json={'name': 'KMU UI probe supplier', 'phone': '0000'}, timeout=10).json()
sup_id = sup.get('supplier', sup).get('id')
now = time.time()
exp_a = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now + 12 * 86400))
exp_b = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now + 40 * 86400))
sku_a, sku_b = f'KMU-A-{int(now)%100000}', f'KMU-B-{int(now)%100000}'
ma = s.post(f'{BASE}/api/medicines', headers=H, json={'name': 'KMU probe A', 'sku': sku_a, 'categoryId': cat, 'stockQty': 8, 'costPrice': 2, 'sellingPrice': 5, 'expiryDate': exp_a, 'supplierId': sup_id}, timeout=10).json()['medicine']['id']
mb = s.post(f'{BASE}/api/medicines', headers=H, json={'name': 'KMU probe B', 'sku': sku_b, 'categoryId': cat, 'stockQty': 5, 'costPrice': 1, 'sellingPrice': 3, 'expiryDate': exp_b, 'supplierId': sup_id}, timeout=10).json()['medicine']['id']
print(f'fixtures: A={ma} B={mb}')

errors = []
ALLOWED_401 = ('/api/auth/me', '/api/settings')  # pre-login session probes on a fresh profile
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

    page.get_by_role('button', name='Stock Control').click()
    page.wait_for_timeout(1200)
    page.get_by_role('tab', name='Returns & Quarantine').click()
    page.wait_for_timeout(800)
    page.get_by_role('tab', name=re.compile('Pre-Expiry Review')).click()
    page.wait_for_timeout(1200)
    row_a = page.locator('tr', has_text=sku_a)
    row_b = page.locator('tr', has_text=sku_b)
    assert row_a.count() == 1, 'probe A row missing'
    assert row_b.count() == 1, 'probe B row missing'
    print('desk shows both probe candidates')

    # --- single-row keep via the row Keep button ---
    row_a.get_by_role('button', name=re.compile('Mark keep — selling through for KMU probe A')).click()
    page.wait_for_timeout(400)
    dlg = page.locator('[role="dialog"]')
    assert dlg.get_by_text('Keep — selling through', exact=False).count() >= 1, 'keep dialog missing'
    assert 'stays on the shelf' in dlg.inner_text(), 'dialog summary missing'
    dlg.get_by_placeholder(re.compile('Why keep')).fill('counter bestseller — sells out in days')
    dlg.get_by_role('button', name=re.compile('Mark 1 product')).click()
    page.wait_for_timeout(1500)
    assert page.get_by_text(re.compile('Marked keep — selling through \\(1 product')).count() >= 1, 'keep toast missing'
    print('row keep marked via dialog, toast shown')

    # badge + snapshot line in the Product cell, Unmark button in Decision column
    assert row_a.get_by_text('Keep — selling through', exact=False).count() >= 1, 'keep badge missing on row A'
    assert row_a.get_by_text(re.compile('marked at 12 d left')).count() == 1, 'days snapshot missing'
    assert row_b.get_by_text('Keep — selling through', exact=False).count() == 0, 'probe B must be unmarked'
    print('badge + days-left snapshot rendered on the marked row')

    # summary strip emerald chip
    assert page.get_by_text(re.compile('1 marked keep · 8 unit')).count() == 1, 'summary kept chip missing'
    print('summary strip shows the kept chip')

    # --- Show filter ---
    page.get_by_label('Show candidates').click()
    page.get_by_role('option', name='Marked keep').click()
    page.wait_for_timeout(600)
    assert page.locator('tr', has_text=sku_a).count() == 1, 'kept filter must keep probe A'
    assert page.locator('tr', has_text=sku_b).count() == 0, 'kept filter must hide probe B'
    page.get_by_label('Show candidates').click()
    page.get_by_role('option', name='Needs a decision').click()
    page.wait_for_timeout(600)
    assert page.locator('tr', has_text=sku_a).count() == 0, 'open filter must hide probe A'
    assert page.locator('tr', has_text=sku_b).count() == 1, 'open filter must keep probe B'
    page.get_by_label('Show candidates').click()
    page.get_by_role('option', name='All candidates').click()
    page.wait_for_timeout(600)
    assert page.locator('tr', has_text=sku_a).count() == 1 and page.locator('tr', has_text=sku_b).count() == 1
    print('Show filter: All / Needs a decision / Marked keep all correct')

    # --- bulk keep from selection ---
    row_b.get_by_label(re.compile(f'Select KMU probe B')).check()
    page.wait_for_timeout(300)
    page.get_by_role('button', name='Keep — selling through', exact=True).click()
    page.wait_for_timeout(400)
    dlg = page.locator('[role="dialog"]')
    assert '1 product(s)' in dlg.inner_text(), 'bulk keep dialog should carry 1 product'
    dlg.get_by_role('button', name=re.compile('Mark 1 product')).click()
    page.wait_for_timeout(1500)
    assert page.get_by_text(re.compile('Marked keep — selling through \\(1 product')).count() >= 1, 'bulk keep toast missing'
    assert row_b.get_by_text('Keep — selling through', exact=False).count() >= 1, 'probe B badge missing after bulk keep'
    assert page.get_by_text(re.compile('2 marked keep · 13 unit')).count() == 1, 'summary should show 2 kept'
    print('bulk keep from selection works, summary chip counts both')

    # --- unmark row A ---
    row_a.get_by_role('button', name=re.compile('Unmark keep for KMU probe A')).click()
    page.wait_for_timeout(1500)
    assert page.get_by_text(re.compile('Keep marker removed \\(1\\)')).count() >= 1, 'unmark toast missing'
    assert row_a.get_by_text('Keep — selling through', exact=False).count() == 0, 'probe A badge must be gone'
    print('unmark clears the marker + badge')

    page.screenshot(path=SHOT, full_page=True)
    print(f'screenshot: {SHOT}')
    browser.close()

# ---- cleanup: probe meds (markers cascade), supplier
import subprocess
subprocess.run(['node', '-e', '''
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const probes=await db.medicine.findMany({where:{sku:{startsWith:'KMU-'}},select:{id:true}});
  const d=await db.disposalDecision.deleteMany({where:{medicineId:{in:probes.map(p=>p.id)}}});
  const m=await db.medicine.deleteMany({where:{sku:{startsWith:'KMU-'}}});
  const su=await db.supplier.deleteMany({where:{name:'KMU UI probe supplier'}});
  console.log(`ui-cleanup: markers=${d.count} meds=${m.count} supplier=${su.count}`);
})().finally(()=>db.$disconnect())
'''], check=True)

if errors:
    print('PAGE ERRORS:')
    for e in errors:
        print(' ', e)
    sys.exit(1)
print('E2E SMOKE GREEN — zero page errors')
