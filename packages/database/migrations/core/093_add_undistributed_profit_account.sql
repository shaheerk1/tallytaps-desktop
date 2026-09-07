-- Allocating profit to a partner moves value between two equity accounts: it
-- leaves the pool of profit nobody has claimed yet and becomes that partner's
-- share. Without this account the allocation had no honest debit side.
INSERT INTO ledger_accounts (account_code, name, account_type, normal_balance, description, sort_order) VALUES
  ('3300', 'Undistributed profit', 'equity', 'credit', 'Profit the business has made that has not yet been allocated to anyone.', 205);
