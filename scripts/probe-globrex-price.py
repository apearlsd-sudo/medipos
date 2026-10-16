#!/usr/bin/env python3
"""Investigate Globrex price change: current values + audit trail + purchase/sale history."""
import sqlite3, json

DB = '/home/z/my-project/db/custom.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

print('=== 1. Product rows named like Globrex ===')
for r in cur.execute("SELECT id, name, sku, branchId, costPrice, sellingPrice, stockQty, status, createdAt, updatedAt, batchNumber, expiryDate FROM Medicine WHERE name LIKE '%globrex%' OR genericName LIKE '%globrex%' COLLATE NOCASE"):
    print(dict(r))

print('\n=== 2. AuditLog mentioning globrex (or its sku/id) ===')
for r in cur.execute("SELECT action, actorName, targetType, targetName, summary, changes, createdAt FROM AuditLog WHERE summary LIKE '%lobrex%' OR targetName LIKE '%lobrex%' OR changes LIKE '%lobrex%' ORDER BY createdAt DESC LIMIT 20"):
    print(dict(r))

print('\n=== 3. SyncOps mentioning globrex ===')
for r in cur.execute("SELECT op, targetKey, substr(payload,1,300) AS payload, nodeId, createdAt, appliedAt FROM SyncOp WHERE payload LIKE '%lobrex%' OR targetKey LIKE '%lobrex%' ORDER BY createdAt DESC LIMIT 20"):
    print(dict(r))

print('\n=== 4. Purchase items for globrex ===')
for r in cur.execute("SELECT pi.name, pi.qty, pi.receivedQty, pi.unitCost, pi.total, pi.batchNumber, p.id AS purchaseId, p.status, p.purchaseDate, p.createdAt FROM PurchaseItem pi LEFT JOIN Purchase p ON p.id = pi.purchaseId WHERE pi.medicineId IN (SELECT id FROM Medicine WHERE name LIKE '%lobrex%') OR pi.name LIKE '%lobrex%' ORDER BY p.createdAt DESC LIMIT 10"):
    print(dict(r))

print('\n=== 5. Sale items for globrex (price actually charged over time) ===')
for r in cur.execute("SELECT si.name, si.unitPrice, si.qty, s.invoiceNo, s.paymentStatus, s.createdAt FROM SaleItem si LEFT JOIN Sale s ON s.id = si.saleId WHERE si.medicineId IN (SELECT id FROM Medicine WHERE name LIKE '%lobrex%') OR si.name LIKE '%lobrex%' ORDER BY s.createdAt DESC LIMIT 10"):
    print(dict(r))

print('\n=== 6. Inventory logs for globrex ===')
for r in cur.execute("SELECT type, quantity, reason, reference, createdAt FROM InventoryLog WHERE medicineId IN (SELECT id FROM Medicine WHERE name LIKE '%lobrex%') ORDER BY createdAt DESC LIMIT 15"):
    print(dict(r))

con.close()
