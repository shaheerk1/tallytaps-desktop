-- The supply code a cashier last used for an item, remembered for the day.
--
-- When a cashier moves on to an item without typing a code, Billing fills in the
-- code they used for that item earlier today. If that code names an open lot the
-- lot is selected; if not, the line goes without a lot, exactly as if it had
-- been typed. It is the text that is remembered, not a lot or a "no lot"
-- decision, so the rule for a filled-in code is the same as for a typed one.
--
-- A memory belongs to one business day. A row from an earlier day is simply not
-- read, so nothing carries over once the day is closed and a new one opened.
-- The location's default code (used when the supply code is not required) is
-- never stored here.

CREATE TABLE supply_code_memory (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loc_code VARCHAR(50) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  supply_code VARCHAR(120) NOT NULL,
  business_date DATE NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supply_code_memory_scope (loc_code, product_id, user_id),
  CONSTRAINT fk_supply_code_memory_location FOREIGN KEY (loc_code) REFERENCES pos_locations (loc_code) ON DELETE RESTRICT,
  CONSTRAINT fk_supply_code_memory_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_supply_code_memory_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
