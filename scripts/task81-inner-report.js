#!/usr/bin/env node
// Summarize in-container horizontal scroll audit
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  console.log(`\n===== ${f} =====`);
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    let d = rec.data || rec;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { continue; } }
    const key = rec.view || rec.key || '?';
    const scrollers = d.scrollers || [];
    if (!scrollers.length) { console.log(`${key}: no in-container scroll`); continue; }
    console.log(`${key}: ${d.n} scroller(s)`);
    for (const s of scrollers) {
      console.log(`   hidden=${s.hidden}px (cw ${s.cw} / sw ${s.sw}) [${s.slot || s.cls || '-'}] child="${s.childCls}" txt="${s.txt}"`);
    }
  }
}
