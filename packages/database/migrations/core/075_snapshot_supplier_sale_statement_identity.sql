ALTER TABLE supplier_sale_statements
  ADD COLUMN supplier_code_snapshot VARCHAR(120) NOT NULL DEFAULT '' AFTER supplier_id,
  ADD COLUMN supplier_name_snapshot VARCHAR(255) NOT NULL DEFAULT '' AFTER supplier_code_snapshot,
  ADD COLUMN commission_basis ENUM('net_merchandise') NOT NULL DEFAULT 'net_merchandise' AFTER build_mode;

UPDATE supplier_sale_statements st
JOIN suppliers s ON s.id = st.supplier_id
SET st.supplier_code_snapshot = COALESCE(s.supplier_code, ''),
    st.supplier_name_snapshot = s.name
WHERE st.supplier_code_snapshot = '' OR st.supplier_name_snapshot = '';
