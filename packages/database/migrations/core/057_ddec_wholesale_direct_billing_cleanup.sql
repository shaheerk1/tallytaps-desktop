-- This migration's DDL and data cleanup completed before a legacy permission
-- column name mismatch stopped its migration-record insert.  The schema is
-- now at the target DDEC state, so this final, idempotent statement only
-- clears the remaining plugin/SDL permission rows and lets the runner record
-- migration 057.  See the application migration log for the executed DDL.

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE permission_key LIKE 'plugins.%' OR permission_key LIKE 'sdl.%'
);
DELETE FROM permissions
WHERE permission_key LIKE 'plugins.%' OR permission_key LIKE 'sdl.%';
