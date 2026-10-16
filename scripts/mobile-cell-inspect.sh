#!/bin/bash
# Task 81 — dump widest visible cells of a view's main table at 390px.
# Usage: bash scripts/mobile-cell-inspect.sh <navLabelStartsWith>
set -u
label="$1"
agent-browser find role button click --name "Open menu" >/dev/null 2>&1
sleep 0.7
agent-browser eval "(function(){ var want = '$label'; var btns = Array.from(document.querySelectorAll('button, a')); var b = btns.find(function(el){ var t = (el.textContent || '').trim(); return t.startsWith(want); }); if (b) { b.click(); return 'clicked'; } return 'notfound'; })()" >/dev/null 2>&1
sleep 1.7
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 0.4
agent-browser eval "(function(){ var t = document.querySelector('main table'); if(!t) return 'no table'; var cells = []; t.querySelectorAll('tbody tr:first-child td, thead th').forEach(function(td){ var cs = getComputedStyle(td); if (cs.display === 'none') return; var r = td.getBoundingClientRect(); cells.push({w: Math.round(r.width), txt: (td.textContent||'').trim().slice(0, 34), inner: (function(){ var c = td.firstElementChild; return c ? (typeof c.className === 'string' ? c.className.slice(0,44) : c.tagName) : ''; })()}); }); cells.sort(function(a,b){return b.w - a.w;}); var tc = t.closest('[data-slot=table-container]'); return JSON.stringify({table: tc ? tc.scrollWidth : t.scrollWidth, cells: cells.slice(0, 5)}); })()"
