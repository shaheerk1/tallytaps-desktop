ALTER TABLE customer_advance_entries
  ADD COLUMN invoice_advance_allocation_id BIGINT UNSIGNED NULL AFTER advance_refund_id,
  ADD KEY idx_customer_advance_entries_allocation (invoice_advance_allocation_id),
  ADD CONSTRAINT fk_customer_advance_entry_allocation
    FOREIGN KEY (invoice_advance_allocation_id) REFERENCES invoice_advance_allocations(id) ON DELETE RESTRICT;

UPDATE payment_modes
SET configuration = JSON_OBJECT(
  'fundingSource','customer_advance',
  'requiresCustomer',TRUE,
  'allowOverpay',FALSE,
  'createsCashMovement',FALSE,
  'supportsRefundPayout',TRUE,
  'restoresCustomerAdvance',TRUE
)
WHERE mode_key = 'advance';
