// Task 64 helper — cancel the browser-E2E insurance sale + prove claim auto-void.
const http = require('http')
const BASE = { host: 'localhost', port: 3000 }

function req(path, { method = 'GET', cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ ...BASE, path, method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let d = ''
      res.on('data', (x) => (d += x))
      res.on('end', () => {
        const setc = res.headers['set-cookie']
        resolve({ status: res.statusCode, text: d, cookie: setc ? setc.map((x) => x.split(';')[0]).join('; ') : null })
      })
    })
    r.on('error', reject)
    if (body) r.write(JSON.stringify(body))
    r.end()
  })
}

;(async () => {
  const login = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } })
  const ck = login.cookie
  console.log('login:', login.status)

  const sales = await req('/api/sales?method=insurance', { cookie: ck })
  const rows = JSON.parse(sales.text).sales || []
  const s = rows.find((x) => x.saleStatus === 'completed')
  console.log('latest completed insurance sale:', s ? `${s.invoiceNo} total=${s.total} id=${s.id}` : `NONE among ${rows.length}`)
  if (!s) {
    console.log('claims:', (JSON.parse((await req('/api/claims', { cookie: ck })).text).claims || []).filter((c) => /rejected|pending/.test(c.status)).slice(0, 3).map((c) => `${c.claimNo}:${c.status}`).join(', '))
    return
  }
  const del = await req(`/api/sales/${s.id}`, { method: 'DELETE', cookie: ck })
  console.log('cancel:', del.status, del.text.slice(0, 60))
  const claims = await req('/api/claims', { cookie: ck })
  const c = (JSON.parse(claims.text).claims || []).find((x) => x.saleInvoice === s.invoiceNo || x.claimNo === 'CLM-2026-0054')
  console.log('claim after cancel:', c ? `${c.status} — ${c.note || ''}` : 'MISSING')
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
