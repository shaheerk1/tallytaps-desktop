-- A bill said to be paid, when the money never arrived.
--
-- The card declines after the receipt prints, the cash in the drawer is short,
-- or a customer says "put it on my account" once the bill is already closed.
-- Until now the only answer was a refund, which returns the goods too. This
-- lets the sale stand while the money moves back to being owed.
--
-- Nothing is erased: the original tender stays, a reversing payment line is
-- written against it, the drawer is corrected, and the customer's account
-- carries the debt. See billing.repository.js -> unsettleInvoice for the rules,
-- chiefly that cash can only be moved back while the shift that counted it is
-- still open.

ALTER TABLE customer_receivable_entries
  MODIFY COLUMN entry_type ENUM(
    'sale_debit', 'collection_credit', 'return_credit', 'refund_debit',
    'store_credit', 'manager_adjustment', 'cheque_dishonour_debit',
    'payment_reversal_debit'
  ) NOT NULL;

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('billing.payment.reverse', 'Billing Mark A Paid Bill Unpaid');

-- Deliberately given to administrators only: moving money out of a day's
-- takings is exactly what a dishonest entry would look like, so it stays with
-- whoever the shop trusts with the books.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'billing.payment.reverse'
WHERE r.role_key = 'admin';
