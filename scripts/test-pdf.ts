// Verify jsPDF + autotable produce a valid PDF (same code path as reports export)
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
const pageW = doc.internal.pageSize.getWidth()

doc.setFillColor(13, 148, 136)
doc.rect(0, 0, pageW, 26, 'F')
doc.setTextColor(255, 255, 255)
doc.setFontSize(15)
doc.text('MediPOS Pharmacy', 14, 11)
doc.setFontSize(10)
doc.text('Product Performance — Last 30 days (USD)', 14, 19)

autoTable(doc, {
  head: [['Product', 'Category', 'Units Sold', 'Revenue', 'Est. Profit']],
  body: [
    ['Insulin Glargine 100IU/ml', 'Antidiabetics', '22', '792.00', '396.00'],
    ['Salbutamol Inhaler 100mcg', 'Respiratory', '29', '348.00', '188.50'],
  ],
  startY: 32,
  headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
  margin: { left: 14, right: 14 },
})

const pages = doc.getNumberOfPages()
for (let i = 1; i <= pages; i++) {
  doc.setPage(i)
  doc.setFontSize(8)
  doc.text(`Page ${i} of ${pages}`, pageW / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' })
}

const out = doc.output('arraybuffer')
const bytes = new Uint8Array(out)
const header = String.fromCharCode(...bytes.slice(0, 5))
console.log('PDF header:', header, '| size:', bytes.length, 'bytes | pages:', pages)
if (header === '%PDF-' && bytes.length > 2000) console.log('✓ PDF export pipeline works')
else { console.error('✗ Invalid PDF'); process.exit(1) }
