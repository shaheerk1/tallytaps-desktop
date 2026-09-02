-- Surface finalized historical sale quantities that were never assigned to a
-- GRN lot. Overall inventory already includes these sales, so reconciliation
-- will only consume lot balances.

INSERT INTO inventory_allocation_exceptions
  (invoice_item_id, loc_code, mac_code, txn_date, document_no, line_no, product_id,
   unallocated_handling_quantity, unallocated_base_quantity, status)
SELECT i.id, i.loc_code, i.mac_code, i.txn_date, i.receipt_no, i.seq_no, i.product_id,
       GREATEST(0, ROUND(COALESCE(i.handling_quantity, i.quantity, 0) - COALESCE(SUM(a.handling_quantity), 0), 3)),
       CASE WHEN i.base_quantity IS NULL AND i.kilos IS NULL THEN NULL
            ELSE GREATEST(0, ROUND(COALESCE(i.base_quantity, i.kilos, 0) - COALESCE(SUM(a.base_quantity), 0), 3)) END,
       'open'
FROM invoice_items i
JOIN invoices v ON v.id = i.invoice_id
LEFT JOIN lot_sale_allocations a ON a.invoice_item_id = i.id AND a.document_type = 'sale'
WHERE i.product_id IS NOT NULL AND v.inv_stat = 'active' AND v.status IN ('paid','partial')
GROUP BY i.id, i.loc_code, i.mac_code, i.txn_date, i.receipt_no, i.seq_no, i.product_id,
         i.handling_quantity, i.quantity, i.base_quantity, i.kilos
HAVING GREATEST(0, ROUND(COALESCE(i.handling_quantity, i.quantity, 0) - COALESCE(SUM(a.handling_quantity), 0), 3)) > 0.0005
    OR GREATEST(0, ROUND(COALESCE(i.base_quantity, i.kilos, 0) - COALESCE(SUM(a.base_quantity), 0), 3)) > 0.0005
ON DUPLICATE KEY UPDATE
  unallocated_handling_quantity = VALUES(unallocated_handling_quantity),
  unallocated_base_quantity = VALUES(unallocated_base_quantity),
  status = 'open', resolution_note = NULL, resolved_by = NULL, resolved_at = NULL;

