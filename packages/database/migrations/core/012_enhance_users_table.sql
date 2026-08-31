-- Add useful fields to users table for production POS usage
ALTER TABLE users
  ADD COLUMN email VARCHAR(255) NULL AFTER display_name,
  ADD COLUMN phone VARCHAR(30) NULL AFTER email,
  ADD COLUMN last_login_at TIMESTAMP NULL AFTER status,
  ADD COLUMN password_updated_at TIMESTAMP NULL AFTER last_login_at;
