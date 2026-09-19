-- Correct refund payouts that were charged to the customer as money owed.
--
-- A refund against a customer's bill cancels any unpaid part with a
-- return_credit, then hands back the rest -- money the customer had already
-- paid. That handed-back part was also posted as a refund_debit, which the
-- customer balance counts as owed. Nothing credited it back, so a bill paid in
-- full and then refunded in full left the customer owing the whole amount.
--
-- The refund code no longer posts it. Existing ones are corrected, not
-- deleted: each gets a matching return_credit on the same refund document, so
-- the customer statement shows both the original entry and its correction and
-- the account nets to what it should.
--
-- Safe to run again: an entry already corrected is skipped.

INSERT INTO customer_receivable_entries
  (business_day_id, customer_account_id, loc_code, mac_code, txn_date, document_type, document_no, entry_no,
   invoice_id, refund_id, cash_shift_id, entry_type, amount, reason, created_by, metadata)
SELECT d.business_day_id, d.customer_account_id, d.loc_code, d.mac_code, d.txn_date, d.document_type, d.document_no,
       nxt.last_entry_no + ROW_NUMBER() OVER (PARTITION BY d.loc_code, d.mac_code, d.txn_date, d.document_type, d.document_no ORDER BY d.id),
       d.invoice_id, d.refund_id, NULL, 'return_credit', d.amount,
       'Correction: refund payout was wrongly charged to the customer', d.created_by,
       JSON_OBJECT('correctsEntryId', d.id, 'migration', '123')
FROM customer_receivable_entries d
JOIN (
  SELECT loc_code, mac_code, txn_date, document_type, document_no, MAX(entry_no) AS last_entry_no
  FROM customer_receivable_entries
  GROUP BY loc_code, mac_code, txn_date, document_type, document_no
) nxt ON nxt.loc_code = d.loc_code AND nxt.mac_code = d.mac_code AND nxt.txn_date = d.txn_date
     AND nxt.document_type = d.document_type AND nxt.document_no = d.document_no
WHERE d.entry_type = 'refund_debit'
  AND d.document_type = 'refund'
  AND d.reason = 'Refund payout after debt settlement'
  AND NOT EXISTS (
    SELECT 1 FROM customer_receivable_entries c
    WHERE c.entry_type = 'return_credit'
      AND JSON_EXTRACT(c.metadata, '$.correctsEntryId') = d.id
  );
