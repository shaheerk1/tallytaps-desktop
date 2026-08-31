-- Add the 'partial' status for receipts settled with a credit/pending payment.
-- A finalized receipt is 'paid' when tender covers the total, 'partial' when an
-- outstanding (borrowed) balance remains — e.g. settled via the Pending paymode.

ALTER TABLE invoices
  MODIFY COLUMN status ENUM('draft', 'paid', 'partial', 'cancelled') NOT NULL DEFAULT 'draft';
