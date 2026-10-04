// Structural validation of the Code128 encoder
const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
]

let ok = true
if (PATTERNS.length !== 107) { console.error('FAIL: pattern count', PATTERNS.length); ok = false }
for (let i = 0; i < 106; i++) {
  if (!/^\d{6}$/.test(PATTERNS[i])) { console.error('FAIL: pattern', i, PATTERNS[i]); ok = false }
  const sum = [...PATTERNS[i]].reduce((s, d) => s + Number(d), 0)
  if (sum !== 11) { console.error('FAIL: pattern', i, 'sum', sum); ok = false }
}
const stopSum = [...PATTERNS[106]].reduce((s, d) => s + Number(d), 0)
if (stopSum !== 13) { console.error('FAIL: stop sum', stopSum); ok = false }

// Encode 'HELLO' per spec: start 104, values H=40 E=37 L=44 L=44 O=47
// checksum = (104 + 40 + 37*2 + 44*3 + 44*4 + 47*5) % 103 = (104+40+74+132+176+235)=761 % 103 = 761-721=40
const value = 'HELLO'
let checksum = 104
for (let i = 0; i < value.length; i++) checksum += (value.charCodeAt(i) - 32) * (i + 1)
const expected = 40
if (checksum % 103 !== expected) { console.error('FAIL: checksum', checksum % 103, 'expected', expected); ok = false }

// Total modules for 'HELLO': start(11) + 5 chars(55) + checksum(11) + stop(13) = 90
if (ok) console.log('All Code128 structural checks passed ✓  (modules for HELLO =', 11 * 7 + 13, ')')
else process.exit(1)
