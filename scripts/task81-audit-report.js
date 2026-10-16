#!/usr/bin/env node
// Summarize task81 audit jsonl files: flag views/dialogs with overflowPx > 0
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  console.log(`\n===== ${f} =====`);
  let bad = 0, n = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    let d = rec.data || {};
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { console.log(`${rec.dialog || rec.view}: DATA-STRING-PARSE-FAIL`); continue; } }
    const key = rec.dialog || rec.view || rec.key || '?';
    n++;
    if (d.error) { console.log(`${key}: ERROR ${d.error}`); continue; }
    if ((d.overflowPx || 0) > 0) {
      bad++;
      console.log(`${key}${d.hdr ? ` [hdr="${d.hdr}"]` : ''}: OVERFLOW ${d.overflowPx}px (docSW ${d.docSW} vs clientW ${d.clientW})`);
      for (const o of d.offenders || []) {
        console.log(`   <${o.tag}${o.slot ? ` slot=${o.slot}` : ''}> w=${o.w} right=${o.right} cls="${o.cls}" txt="${o.txt}"`);
      }
    } else {
      console.log(`${key}: ok${d.dialogW ? ` (dialogW=${d.dialogW})` : ''}`);
    }
  }
  console.log(bad === 0 ? `>>> ALL CLEAN (${n} records)` : `>>> ${bad}/${n} record(s) with overflow`);
}
