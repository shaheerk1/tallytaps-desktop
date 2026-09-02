-- The tender tile and the printed receipt both render the payment mode's
-- display name, and "Use Advance" reads as an instruction rather than a tender
-- beside Cash, Card and Cheque. The screens that need the fuller wording label
-- it themselves.

UPDATE payment_modes SET display_name = 'Advance' WHERE mode_key = 'advance';
