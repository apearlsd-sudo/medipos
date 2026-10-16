#!/bin/bash
# Diagnose widest overflowing elements on a given view. Args: label
set -u
label="$1"
agent-browser find role button click --name "Open menu" >/dev/null 2>&1
sleep 0.6
agent-browser eval "(function(){ var want = '$label'; var btns = Array.from(document.querySelectorAll('button, a')); var b = btns.find(function(el){ var t = (el.textContent || '').trim(); return t === want || t.startsWith(want); }); if (b) { b.click(); return 'clicked'; } return 'notfound'; })()" >/dev/null 2>&1
sleep 1.6
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 0.5
agent-browser eval "(function(){ function clipped(el){ var p = el.parentElement; while (p && p !== document.documentElement){ var ov = getComputedStyle(p).overflowX; if (ov === 'auto' || ov === 'scroll' || ov === 'hidden' || ov === 'clip') return true; p = p.parentElement; } return false; } var vw = document.documentElement.clientWidth; var bad = []; document.querySelectorAll('*').forEach(function(el){ var r = el.getBoundingClientRect(); if (r.right > vw + 2 && r.width > 30 && !clipped(el)) { var cls = (typeof el.className === 'string') ? el.className.slice(0, 90) : ''; bad.push({tag: el.tagName, slot: el.getAttribute('data-slot') || '', w: Math.round(r.width), right: Math.round(r.right), cls: cls, text: (el.textContent || '').trim().slice(0, 50)}); } }); bad.sort(function(a,b){return b.right - a.right;}); return JSON.stringify({sw: document.documentElement.scrollWidth, top: bad.slice(0, 8)}); })()"
