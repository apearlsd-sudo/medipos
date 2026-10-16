"""Task 73 — browser E2E smoke of the Pre-Expiry disposal desk.
Plants 2 probe candidates via API, then drives the real UI:
Stock Control → Returns & Quarantine → Pre-Expiry Review → select →
write-off dialog → destroy → toast + stock decrement → window switch.
Zero page/console errors expected. Cleans up every probe row.
Run: python3 scripts/verify-pre-expiry-ui.py
"""
import json, re, sys, time
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
FIX = '/home/z/my-project/scripts/.pe-ui-probe-ids.json'
SHOT = '/home/z/my-project/download/task73-pre-expiry-desk.png'

s = requests.Session()
r = s.post(f'{BASE}/api/auth/login', json={'username': 'admin', 'password': 'admin123'}, timeout=10)
assert r.ok, 'admin login failed'
CK = s.cookies.get_dict()['medipos_session']
H = {'Cookie': f'medipos_session={CK}'}

cat = s.get(f'{BASE}/api/categories', headers=H, timeout=10).json()['categories'][0]['id']
sup = s.post(f'{BASE}/api/suppliers', headers=H, json={'name': 'PE UI probe supplier', 'phone': '0000'}, timeout=10).json()
sup_id = sup.get('supplier', sup).get('id')
now = time.time()
exp_a = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now + 12 * 86400))
exp_b = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now + 40 * 86400))
sku_a, sku_b = f'PE-UIA-{int(now)%100000}', f'PE-UIB-{int(now)%100000}'
ma = s.post(f'{BASE}/api/medicines', headers=H, json={'name': 'PE probe UI A', 'sku': sku_a, 'categoryId': cat, 'stockQty': 8, 'costPrice': 2, 'sellingPrice': 5, 'expiryDate': exp_a, 'supplierId': sup_id}, timeout=10).json()['medicine']['id']
mb = s.post(f'{BASE}/api/medicines', headers=H, json={'name': 'PE probe UI B', 'sku': sku_b, 'categoryId': cat, 'stockQty': 5, 'costPrice': 1, 'sellingPrice': 3, 'expiryDate': exp_b, 'supplierId': sup_id}, timeout=10).json()['medicine']['id']
json.dump({'supplierId': sup_id, 'meds': [{'id': ma, 'sku': sku_a}, {'id': mb, 'sku': sku_b}]}, open(FIX, 'w'))
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

    # three tabs present
    for tab in ['Write-offs & Returns', 'Pre-Expiry Review', 'Quarantine']:
        assert page.get_by_role('tab', name=re.compile(tab)).count() >= 1, f'missing tab {tab}'
    print('tabs OK: notes / pre-expiry / quarantine')

    page.get_by_role('tab', name=re.compile('Pre-Expiry Review')).click()
    page.wait_for_timeout(1200)
    row_a = page.locator('tr', has_text=sku_a)
    row_b = page.locator('tr', has_text=sku_b)
    assert row_a.count() == 1, 'probe A row missing'
    assert row_b.count() == 1, 'probe B row missing'
    print('desk shows both probe candidates')

    # select probe A → qty auto-fills full stock (8)
    row_a.get_by_label(re.compile('Select PE probe UI A')).check()
    page.wait_for_timeout(300)
    qty = row_a.get_by_label(re.compile('Dispose quantity for PE probe UI A'))
    assert qty.input_value() == '8', f'qty autofill expected 8, got {qty.input_value()}'
    print('checkbox auto-fills full dispose qty (8)')

    page.get_by_role('button', name=re.compile('Write off selected')).click()
    page.wait_for_timeout(400)
    dlg = page.locator('[role="dialog"]')
    assert dlg.get_by_text('Inventory Write-offs', exact=False).count() >= 1, 'dialog missing expense warning'
    dlg.get_by_role('button', name=re.compile('Destroy 8 unit')).click()
    page.wait_for_timeout(1500)
    assert page.get_by_text(re.compile('recorded — disposed 8 unit')).count() >= 1, 'success toast missing'
    print('write-off disposal recorded via UI, toast shown')

    stock_a = s.get(f'{BASE}/api/medicines/{ma}', headers=H, timeout=10).json()
    stock_a = stock_a.get('medicine', stock_a)['stockQty']
    assert stock_a == 0, f'probe A stock expected 0, got {stock_a}'
    print('probe A stock 8 → 0 confirmed via API')

    # window switch: 30 days hides probe B (40 d out)
    page.get_by_label('Expiry window').click()
    page.get_by_role('option', name='Expiring within 30 days').click()
    page.wait_for_timeout(1200)
    assert page.locator('tr', has_text=sku_b).count() == 0, 'probe B should leave the 30d window'
    print('window switch 60d → 30d correctly drops probe B')

    page.screenshot(path=SHOT, full_page=True)
    print(f'screenshot: {SHOT}')
    browser.close()

# ---- cleanup: every pre_expiry note (feature is brand new — only probes exist), expenses, probes
import subprocess
subprocess.run(['node', '-e', '''
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const notes=await db.stockReturn.findMany({where:{source:'pre_expiry'},select:{returnNo:true}});
  const refs=notes.map(n=>n.returnNo);
  const e=await db.expense.deleteMany({where:{reference:{in:refs}}});
  const r=await db.stockReturn.deleteMany({where:{source:'pre_expiry'}});
  const l=await db.inventoryLog.deleteMany({where:{medicine:{sku:{startsWith:'PE-'}}}});
  const m=await db.medicine.deleteMany({where:{sku:{startsWith:'PE-'}}});
  const su=await db.supplier.deleteMany({where:{name:'PE UI probe supplier'}});
  const so=await db.syncOp.deleteMany({where:{OR:refs.map(x=>({targetKey:x}))}});
  console.log(`ui-cleanup: expenses=${e.count} returns=${r.count} logs=${l.count} meds=${m.count} supplier=${su.count} syncOps=${so.count}`);
})().finally(()=>db.$disconnect())
'''], check=True)

import os
os.unlink(FIX)
if errors:
    print('PAGE ERRORS:')
    for e in errors:
        print(' ', e)
    sys.exit(1)
print('E2E SMOKE GREEN — zero page errors')
