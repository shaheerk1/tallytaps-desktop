-- Recording money on an earlier date.
--
-- People remember late: a transfer made last week, a lorry a partner paid for
-- on Monday that we only hear about on Friday. Such an entry is dated the day
-- it actually happened, and keeps -- in its metadata -- the day it was typed
-- in, who typed it, and why it was late. Nothing is hidden and nothing is
-- edited afterwards.
--
-- The limits live in packages/core/security/entry-date.js: never into the
-- future, only a day this location was open, never money paid from a till (that
-- drawer was counted with its shift), and never inside a closed accounting
-- period. This permission decides who may do it at all; it is deliberately not
-- given to the roles that merely record expenses.

INSERT IGNORE INTO permissions (permission_key, name) VALUES
  ('money.backdate', 'Money Record On An Earlier Date');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'money.backdate'
WHERE r.role_key = 'admin';
