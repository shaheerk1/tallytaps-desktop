-- Every till is a fund, so an expense can be paid from it. Migration 089 made
-- funds for the drawers that existed then; drawers opened since had none.
INSERT IGNORE INTO fund_accounts (fund_code, name, fund_kind, cash_drawer_id, loc_code, currency_code, is_active, sort_order)
SELECT
  CONCAT('DRAWER-', w.location_code, '-', w.machine_code),
  CONCAT(d.name, ' (', w.machine_code, ')'),
  'pos_drawer', d.id, w.location_code, d.currency_code,
  IF(d.status = 'active', 1, 0), 10
FROM cash_drawers d
JOIN pos_workstations w ON w.id = d.workstation_id
LEFT JOIN fund_accounts f ON f.cash_drawer_id = d.id
WHERE f.id IS NULL;
