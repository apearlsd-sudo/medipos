import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const day = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000)
const ago = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function main() {
  console.log('Seeding database...')

  await db.saleItem.deleteMany()
  await db.sale.deleteMany()
  await db.purchaseItem.deleteMany()
  await db.purchase.deleteMany()
  await db.inventoryLog.deleteMany()
  await db.prescription.deleteMany()
  await db.medicine.deleteMany()
  await db.category.deleteMany()
  await db.supplier.deleteMany()
  await db.customer.deleteMany()
  await db.storeSetting.deleteMany()

  // ---------- Categories ----------
  const categories = await Promise.all(
    [
      ['Analgesics', 'Pain relief medicines including NSAIDs and opioids'],
      ['Antibiotics', 'Antibacterial medications for infections'],
      ['Antimalarials', 'Malaria treatment and prophylaxis'],
      ['Cardiovascular', 'Heart and blood pressure medications'],
      ['Antidiabetics', 'Diabetes management medications'],
      ['Respiratory', 'Asthma, cough and cold medicines'],
      ['Vitamins & Supplements', 'Multivitamins and dietary supplements'],
      ['Dermatology', 'Skin care and topical treatments'],
      ['Gastrointestinal', 'Digestive health medicines'],
      ['First Aid & Consumables', 'Plasters, bandages, syringes and consumables'],
    ].map(([name, description]) =>
      db.category.create({ data: { name, description } })
    )
  )
  const cat = (name: string) => categories.find((c) => c.name === name)!.id

  // ---------- Suppliers ----------
  const supplierData = [
    ['MedLife Distributors', 'Sarah Mensah', 'sales@medlife.com', '+233 24 555 0101', '12 Industrial Area, Accra'],
    ['HealthCare Pharma Ltd', 'Kwame Osei', 'orders@healthcarepharma.com', '+233 20 555 0102', '45 Spintex Road, Accra'],
    ['GreenCross Medicals', 'Ama Boateng', 'info@greencross.com', '+233 26 555 0103', '8 Airport City, Accra'],
    ['NovaCare Supplies', 'David Addo', 'supply@novacare.com', '+233 27 555 0104', '232 Oxford St, Osu, Accra'],
    ['Zenith Pharmaceuticals', 'Grace Owusu', 'sales@zenithpharma.com', '+233 28 555 0105', 'Komfo Anokye Rd, Kumasi'],
  ]
  const suppliers = await Promise.all(
    supplierData.map(([name, contactPerson, email, phone, address]) =>
      db.supplier.create({ data: { name, contactPerson, email, phone, address } })
    )
  )
  const sup = (name: string) => suppliers.find((s) => s.name === name)!.id

  // ---------- Customers ----------
  const customerData = [
    ['Andrew Merkel', 'andrew.merkel@gmail.com', '+233 24 111 2200', '14 Ridge Street, North Ridge, Accra'],
    ['Sofia Hernandez', 'sofia.h@yahoo.com', '+233 20 333 4400', '77 Independence Ave, Accra'],
    ['Liam Okafor', 'liam.okafor@outlook.com', '+233 26 555 6600', '5 Ahodwo Road, Kumasi'],
    ['Emma Nakamura', 'emma.n@gmail.com', '+233 27 777 8800', 'Palm Wine Junction, Dansoman'],
    ['Noah Adeyemi', 'noah.a@company.com', '+233 28 999 1100', '9 Liberation Road, Airport Residential'],
    ['Olivia Asante', 'olivia.asante@gmail.com', '+233 24 222 3300', '31 Cantonments, Accra'],
    ['William Tetteh', 'will.t@gmail.com', '+233 55 444 5500', '18 Spintex Road, Accra'],
    ['Ava Mensimah', 'ava.m@web.com', '+233 53 666 7700', '2 Boundary Road, East Legon'],
  ]
  const customers = await Promise.all(
    customerData.map(([name, email, phone, address]) =>
      db.customer.create({ data: { name, email, phone, address } })
    )
  )

  // ---------- Medicines ----------
  // [name, generic, brand, cat, supplier, unit, stock, reorder, cost, sell, rx, batch, expiryDays, location]
  const medData: Array<[string, string, string, string, string, string, number, number, number, number, boolean, string, number, string]> = [
    ['Paracetamol 500mg Tablets', 'Paracetamol', 'Panadol', 'Analgesics', 'MedLife Distributors', 'Box', 480, 60, 1.2, 2.5, false, 'PCM-2401', 420, 'A-01'],
    ['Ibuprofen 400mg Tablets', 'Ibuprofen', 'Brufen', 'Analgesics', 'MedLife Distributors', 'Box', 320, 50, 2.0, 4.5, false, 'IBU-2402', 500, 'A-02'],
    ['Aspirin 75mg Tablets', 'Acetylsalicylic Acid', 'Cardiprin', 'Cardiovascular', 'Zenith Pharmaceuticals', 'Box', 210, 40, 1.8, 3.8, false, 'ASP-2403', 365, 'A-03'],
    ['Tramadol 50mg Capsules', 'Tramadol', 'Tramal', 'Analgesics', 'HealthCare Pharma Ltd', 'Pack', 85, 30, 4.5, 9.0, true, 'TRA-2404', 300, 'A-04'],
    ['Amoxicillin 500mg Capsules', 'Amoxicillin', 'Amoxil', 'Antibiotics', 'GreenCross Medicals', 'Box', 260, 50, 3.2, 6.5, true, 'AMX-2405', 240, 'B-01'],
    ['Azithromycin 250mg Tablets', 'Azithromycin', 'Zithromax', 'Antibiotics', 'GreenCross Medicals', 'Pack', 140, 30, 5.0, 11.0, true, 'AZI-2406', 280, 'B-02'],
    ['Ciprofloxacin 500mg Tablets', 'Ciprofloxacin', 'Ciproxin', 'Antibiotics', 'HealthCare Pharma Ltd', 'Pack', 95, 30, 4.0, 8.5, true, 'CIP-2407', 150, 'B-03'],
    ['Artemether/Lumefantrine 20/120mg', 'Artemether', 'Coartem', 'Antimalarials', 'Zenith Pharmaceuticals', 'Pack', 310, 60, 3.5, 7.5, true, 'ART-2408', 210, 'B-04'],
    ['Artesunate 100mg Suppositories', 'Artesunate', 'Plasmotrim', 'Antimalarials', 'Zenith Pharmaceuticals', 'Box', 120, 25, 6.0, 12.5, true, 'ARS-2409', 180, 'B-05'],
    ['Amlodipine 5mg Tablets', 'Amlodipine', 'Norvasc', 'Cardiovascular', 'MedLife Distributors', 'Box', 180, 40, 2.2, 5.0, true, 'AML-2410', 400, 'C-01'],
    ['Lisinopril 10mg Tablets', 'Lisinopril', 'Zestril', 'Cardiovascular', 'NovaCare Supplies', 'Box', 150, 35, 2.8, 6.0, true, 'LIS-2411', 380, 'C-02'],
    ['Atorvastatin 20mg Tablets', 'Atorvastatin', 'Lipitor', 'Cardiovascular', 'NovaCare Supplies', 'Box', 165, 35, 4.2, 9.5, true, 'ATO-2412', 450, 'C-03'],
    ['Metformin 500mg Tablets', 'Metformin HCl', 'Glucophage', 'Antidiabetics', 'HealthCare Pharma Ltd', 'Box', 290, 50, 1.5, 3.5, true, 'MET-2413', 330, 'C-04'],
    ['Insulin Glargine 100IU/ml', 'Insulin Glargine', 'Lantus', 'Antidiabetics', 'GreenCross Medicals', 'Vial', 42, 15, 18.0, 36.0, true, 'INS-2414', 90, 'Fridge-1'],
    ['Salbutamol Inhaler 100mcg', 'Salbutamol', 'Ventolin', 'Respiratory', 'MedLife Distributors', 'Piece', 110, 25, 5.5, 12.0, true, 'SAL-2415', 300, 'D-01'],
    ['Cetirizine 10mg Tablets', 'Cetirizine HCl', 'Zyrtec', 'Respiratory', 'NovaCare Supplies', 'Box', 240, 40, 1.0, 2.8, false, 'CET-2416', 520, 'D-02'],
    ['Cough Syrup Benylin 100ml', 'Diphenhydramine', 'Benylin', 'Respiratory', 'Zenith Pharmaceuticals', 'Bottle', 95, 30, 3.0, 6.8, false, 'BEN-2417', 200, 'D-03'],
    ['Multivitamin Tablets (B-complex)', 'Vitamin B Complex', 'Becosules', 'Vitamins & Supplements', 'NovaCare Supplies', 'Bottle', 380, 60, 2.5, 5.5, false, 'VIT-2418', 600, 'E-01'],
    ['Vitamin C 1000mg Effervescent', 'Ascorbic Acid', 'Redoxon', 'Vitamins & Supplements', 'NovaCare Supplies', 'Tube', 270, 50, 3.0, 7.0, false, 'VTC-2419', 480, 'E-02'],
    ['Ferrous Sulphate + Folic Acid', 'Ferrous Sulphate', 'Fersolate', 'Vitamins & Supplements', 'MedLife Distributors', 'Pack', 190, 40, 1.8, 4.0, false, 'FER-2420', 400, 'E-03'],
    ['Hydrocortisone Cream 1% 15g', 'Hydrocortisone', 'Cortaid', 'Dermatology', 'GreenCross Medicals', 'Tube', 130, 30, 2.4, 5.5, false, 'HYD-2421', 260, 'E-04'],
    ['Clotrimazole Cream 1% 20g', 'Clotrimazole', 'Canesten', 'Dermatology', 'GreenCross Medicals', 'Tube', 145, 30, 2.2, 5.0, false, 'CLO-2422', 310, 'E-05'],
    ['Omeprazole 20mg Capsules', 'Omeprazole', 'Losec', 'Gastrointestinal', 'HealthCare Pharma Ltd', 'Box', 220, 40, 3.0, 6.5, true, 'OME-2423', 350, 'F-01'],
    ['Oral Rehydration Salts (ORS)', 'Oral Rehydration Salt', 'Oralyte', 'Gastrointestinal', 'Zenith Pharmaceuticals', 'Sachet', 520, 80, 0.4, 1.0, false, 'ORS-2424', 540, 'F-02'],
    ['Loperamide 2mg Capsules', 'Loperamide', 'Imodium', 'Gastrointestinal', 'NovaCare Supplies', 'Pack', 175, 35, 1.6, 3.6, false, 'LOP-2425', 380, 'F-03'],
    ['Disposable Syringes 5ml', 'Syringe', 'BD Plastipak', 'First Aid & Consumables', 'NovaCare Supplies', 'Box', 340, 50, 0.15, 0.4, false, 'SYR-2426', 900, 'G-01'],
    ['Adhesive Bandages (Pack of 20)', 'Bandage', 'Elastoplast', 'First Aid & Consumables', 'MedLife Distributors', 'Pack', 260, 40, 0.9, 2.2, false, 'BND-2427', 800, 'G-02'],
    ['Surgical Face Masks (50pcs)', 'Face Mask', 'Medisafe', 'First Aid & Consumables', 'Zenith Pharmaceuticals', 'Box', 150, 30, 2.5, 5.0, false, 'MSK-2428', 700, 'G-03'],
    ['Gauze Roll Sterile 10cm', 'Gauze', 'Primapore', 'First Aid & Consumables', 'NovaCare Supplies', 'Piece', 88, 30, 0.8, 2.0, false, 'GAU-2429', 750, 'G-04'],
    ['Povidone Iodine Solution 100ml', 'Povidone-Iodine', 'Betadine', 'First Aid & Consumables', 'GreenCross Medicals', 'Bottle', 105, 25, 1.9, 4.2, false, 'PVP-2430', 420, 'G-05'],
  ]

  const medicines = []
  for (let i = 0; i < medData.length; i++) {
    const [name, genericName, brand, catName, supName, unit, stock, reorder, cost, sell, rx, batch, expiryDays, location] = medData[i]
    medicines.push(
      await db.medicine.create({
        data: {
          name, genericName, brand,
          sku: `MED-${String(1001 + i)}`,
          barcode: `8801234${String(10001 + i)}`,
          categoryId: cat(catName),
          supplierId: sup(supName),
          unit, stockQty: stock, reorderLevel: reorder,
          costPrice: cost, sellingPrice: sell,
          prescriptionRequired: rx,
          batchNumber: batch,
          expiryDate: day(expiryDays),
          location,
        },
      })
    )
  }

  // Make a few medicines low stock and a couple expiring soon for realism
  await db.medicine.update({ where: { sku: 'MED-1004' }, data: { stockQty: 8 } })
  await db.medicine.update({ where: { sku: 'MED-1014' }, data: { stockQty: 5 } })
  await db.medicine.update({ where: { sku: 'MED-1029' }, data: { stockQty: 12 } })
  await db.medicine.update({ where: { sku: 'MED-1007' }, data: { expiryDate: day(25) } })
  await db.medicine.update({ where: { sku: 'MED-1009' }, data: { expiryDate: day(58) } })
  await db.medicine.update({ where: { sku: 'MED-1020' }, data: { expiryDate: day(12) } })

  // ---------- Purchases ----------
  const purchaseData: Array<[string, number, string, number, Array<[string, number]>]> = [
    ['MedLife Distributors', 26, 'paid', 1.0, [['MED-1001', 200], ['MED-1002', 100], ['MED-1010', 80]]],
    ['HealthCare Pharma Ltd', 21, 'partially_paid', 0.6, [['MED-1005', 120], ['MED-1013', 150], ['MED-1023', 90]]],
    ['GreenCross Medicals', 15, 'pending', 0.0, [['MED-1006', 60], ['MED-1021', 70], ['MED-1022', 65]]],
    ['Zenith Pharmaceuticals', 9, 'paid', 1.0, [['MED-1008', 150], ['MED-1017', 45], ['MED-1024', 300]]],
    ['NovaCare Supplies', 4, 'partially_paid', 0.4, [['MED-1012', 70], ['MED-1019', 100], ['MED-1026', 120]]],
    ['MedLife Distributors', 2, 'pending', 0.0, [['MED-1011', 60], ['MED-1018', 130]]],
  ]

  let purIdx = 0
  for (const [supName, daysAgo, status, paidRatio, items] of purchaseData) {
    purIdx++
    const lines = items.map(([sku, qty]) => {
      const m = medicines.find((x) => x.sku === sku)!
      return { medicineId: m.id, name: m.name, qty, unitCost: m.costPrice, total: +(m.costPrice * qty).toFixed(2), batchNumber: m.batchNumber, expiryDate: m.expiryDate }
    })
    const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
    const tax = +(subtotal * 0.025).toFixed(2)
    const total = +(subtotal + tax).toFixed(2)
    const paid = +(total * paidRatio).toFixed(2)
    await db.purchase.create({
      data: {
        referenceNo: `PUR-2026-${String(purIdx).padStart(4, '0')}`,
        supplierId: sup(supName),
        purchaseDate: ago(daysAgo),
        subtotal, tax, totalAmount: total, paidAmount: paid,
        status,
        items: { create: lines },
      },
    })
  }

  // ---------- Sales (spread over last 30 days for charts) ----------
  const methods = ['cash', 'card', 'mobile_money', 'insurance']
  const statuses = ['paid', 'paid', 'paid', 'partially_paid', 'pending']
  let saleIdx = 0
  for (let d = 29; d >= 0; d--) {
    const perDay = 2 + ((d * 7) % 4) // 2-5 sales/day
    for (let k = 0; k < perDay; k++) {
      saleIdx++
      const itemCount = 1 + ((d + k) % 4)
      const lines = []
      const used = new Set<number>()
      for (let j = 0; j < itemCount; j++) {
        let idx = (d * 3 + k * 5 + j * 7) % medicines.length
        while (used.has(idx)) idx = (idx + 1) % medicines.length
        used.add(idx)
        const m = medicines[idx]
        const qty = 1 + ((d + k + j) % 5)
        lines.push({ medicineId: m.id, name: m.name, sku: m.sku, qty, unitPrice: m.sellingPrice, total: +(m.sellingPrice * qty).toFixed(2) })
      }
      const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
      const discount = (d + k) % 5 === 0 ? +(subtotal * 0.05).toFixed(2) : 0
      const tax = +((subtotal - discount) * 0.025).toFixed(2)
      const total = +(subtotal - discount + tax).toFixed(2)
      const st = statuses[(d + k) % statuses.length]
      const paidAmount = st === 'paid' ? total : st === 'partially_paid' ? +(total * 0.5).toFixed(2) : 0
      const cust = customers[(d * 3 + k) % customers.length]
      await db.sale.create({
        data: {
          invoiceNo: `INV-2026-${String(saleIdx).padStart(4, '0')}`,
          customerId: ((d + k) % 3 === 0) ? cust.id : null,
          subtotal, discount, tax, total,
          paidAmount, changeAmount: 0,
          paymentMethod: methods[(d + k) % methods.length],
          paymentStatus: st,
          cashierName: k % 2 === 0 ? 'Admin User' : 'Jessica Park',
          createdAt: ago(d),
          items: { create: lines },
        },
      })
    }
  }

  // ---------- Prescriptions ----------
  const rxData: Array<[string, string, string, string]> = [
    ['Andrew Merkel', 'Dr. K. Frimpong', 'verified', 'Amoxicillin 500mg x21 (1 tds), Paracetamol 500mg x15'],
    ['Sofia Hernandez', 'Dr. E. Danso', 'pending', 'Salbutamol Inhaler 100mcg, 2 puffs BD for 1 week'],
    ['Liam Okafor', 'Dr. A. Quaye', 'dispensed', 'Metformin 500mg x60, Amlodipine 5mg x30'],
    ['Emma Nakamura', 'Dr. K. Frimpong', 'pending', 'Artemether/Lumefantrine x24 (4 stat, then BD x3 days)'],
    ['Noah Adeyemi', 'Dr. M. Sarpong', 'rejected', 'Tramadol 50mg x30 — dosage unclear, contact prescriber'],
    ['Olivia Asante', 'Dr. J. Ampofo', 'verified', 'Omeprazole 20mg x28, once daily before food'],
    ['William Tetteh', 'Dr. E. Danso', 'dispensed', 'Azithromycin 250mg x6, Cetirizine 10mg x10'],
    ['Ava Mensimah', 'Dr. M. Sarpong', 'pending', 'Insulin Glargine 10IU OD, Lantus SoloStar pen'],
  ]
  await Promise.all(
    rxData.map(([patientName, doctorName, status, itemsText], i) =>
      db.prescription.create({
        data: { code: `RX-2026-${String(i + 1).padStart(4, '0')}`, patientName, doctorName, phone: customerData[i][2], itemsText, status, createdAt: ago(i) },
      })
    )
  )

  // ---------- Inventory Logs ----------
  const logs: Array<[string, string, number, string, string]> = [
    ['adjustment', 'MED-1001', 10, 'Stock count reconciliation', 'ADJ-001'],
    ['adjustment', 'MED-1013', -4, 'Damaged during handling', 'ADJ-002'],
    ['return', 'MED-1017', 6, 'Customer return — unopened', 'RET-001'],
    ['adjustment', 'MED-1024', -10, 'Expired stock removed', 'EXP-001'],
    ['adjustment', 'MED-1008', 5, 'Stock count reconciliation', 'ADJ-003'],
  ]
  await Promise.all(
    logs.map(([type, sku, quantity, reason, reference]) =>
      db.inventoryLog.create({
        data: { type, medicineId: medicines.find((m) => m.sku === sku)!.id, quantity, reason, reference, createdAt: ago(1) },
      })
    )
  )

  // ---------- Store Settings ----------
  const settings: Array<[string, string]> = [
    ['storeName', 'MediPOS Pharmacy'],
    ['storePhone', '+233 30 222 5500'],
    ['storeEmail', 'contact@medipos.com'],
    ['storeAddress', '25 Liberation Road, Airport Residential Area, Accra'],
    ['currency', 'USD'],
    ['taxRate', '2.5'],
    ['lowStockThreshold', '20'],
    ['expiryAlertDays', '90'],
  ]
  await Promise.all(settings.map(([key, value]) => db.storeSetting.create({ data: { key, value } })))

  console.log('Seed complete:', {
    categories: categories.length,
    suppliers: suppliers.length,
    customers: customers.length,
    medicines: medicines.length,
  })
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
