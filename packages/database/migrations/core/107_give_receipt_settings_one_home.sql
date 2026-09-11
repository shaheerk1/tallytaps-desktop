-- Each receipt setting gets exactly one home.
--
-- The store's name, tagline, address and phone belong to `general`. Older
-- builds also kept `workstation.store_address_1/2` and `workstation.store_phone`,
-- and printed them whenever the General value was empty -- so the settings
-- screen could save one address while the bill printed another. The receipt
-- extras (header and footer lines, logo, language) stay in `workstation`, and
-- the printer lives in `printing.default_printer`; `workstation.default_printer`
-- was never read.
--
-- Nothing that prints today changes: wherever a General value was empty and the
-- bill fell back to the old copy (or to header line 1 or 2 for the name and
-- tagline), that text is moved into General first, in the same scope --
-- shared rows to shared rows, a location's rows to that location's.

UPDATE system_settings g
JOIN system_settings w
  ON w.scope_key = g.scope_key
 AND w.code = 'workstation'
 AND w.`key` = CASE g.`key`
                 WHEN 'store_name' THEN 'bill_header_1'
                 WHEN 'store_tagline' THEN 'bill_header_2'
                 ELSE g.`key`
               END
SET g.value = w.value, g.serialized = 0
WHERE g.code = 'general'
  AND g.`key` IN ('store_name', 'store_tagline', 'store_address_1', 'store_address_2', 'store_phone')
  AND COALESCE(TRIM(g.value), '') = ''
  AND COALESCE(TRIM(w.value), '') <> '';

-- Where General had no row at all, the old copy was all the bill had.
INSERT IGNORE INTO system_settings (loc_code, code, `key`, value, serialized)
SELECT w.loc_code, 'general',
       CASE w.`key`
         WHEN 'bill_header_1' THEN 'store_name'
         WHEN 'bill_header_2' THEN 'store_tagline'
         ELSE w.`key`
       END,
       w.value, 0
FROM system_settings w
WHERE w.code = 'workstation'
  AND w.`key` IN ('bill_header_1', 'bill_header_2', 'store_address_1', 'store_address_2', 'store_phone')
  AND COALESCE(TRIM(w.value), '') <> '';

DELETE FROM system_settings
WHERE code = 'workstation'
  AND `key` IN ('store_address_1', 'store_address_2', 'store_phone', 'default_printer');
