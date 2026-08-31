-- UI Priority Lists: named, ordered form lists that drive the sidebar order
-- and the auto-opened landing page for each user.
--
-- priority_lists.entries holds an ordered JSON array of form ids
-- (e.g. ["billing","items","dashboard"]). One list is flagged is_default=1 and
-- serves as the fallback for users with no assignment.
--
-- priority_list_assignments maps a list to a role or a user. A target can only
-- belong to one list (unique key). Resolution for a user is:
--   user assignment > first matching role assignment > default list.

DROP TABLE IF EXISTS priority_list_assignments;
DROP TABLE IF EXISTS priority_lists;

CREATE TABLE IF NOT EXISTS priority_lists (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  entries JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_priority_lists_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS priority_list_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  list_id BIGINT UNSIGNED NOT NULL,
  target_type ENUM('role', 'user') NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_priority_assign_target (target_type, target_id),
  KEY idx_priority_assign_list (list_id),
  CONSTRAINT fk_priority_assign_list FOREIGN KEY (list_id) REFERENCES priority_lists(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Baseline default list (matches the original hardcoded core order).
INSERT INTO priority_lists (name, is_default, entries)
VALUES ('Default', 1, '["dashboard","billing","users","roles","items","settings","plugins"]');
