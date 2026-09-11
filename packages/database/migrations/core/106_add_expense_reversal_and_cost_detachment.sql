-- Reversing a mistaken expense, and taking a cost back off goods.
--
-- People make mistakes, and a small shop needs to undo them without a
-- bookkeeper. Nothing here deletes history: a reversal writes the opposite of
-- every record the expense created -- the money goes back to the fund it left,
-- the partner's claim falls back, the journal gets a mirror entry, and any cost
-- on goods is detached -- and the expense is marked void with who, when, and why.
--
-- A detachment is an allocation row with a negative amount, like the giving-up
-- side of a move between lots. Recomputing a lot's cost from its ledger then
-- also reverses whatever part of that cost had already been recognised as sold.

ALTER TABLE expense_allocations
  MODIFY COLUMN document_type ENUM('expense','reallocation','detachment') NOT NULL DEFAULT 'expense';

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('expenses.reverse', 'Expenses Reverse');

-- Whoever may record an expense may undo their mistakes; the reason and the
-- person are always kept on the voided record.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, target.id
FROM role_permissions rp
JOIN permissions source ON source.id = rp.permission_id AND source.permission_key = 'expenses.create'
JOIN permissions target ON target.permission_key = 'expenses.reverse';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'expenses.reverse'
WHERE r.role_key = 'admin';
