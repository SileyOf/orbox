ALTER TABLE accounts
  ADD COLUMN auth_type VARCHAR(16) NOT NULL DEFAULT 'password' AFTER username,
  ADD COLUMN oauth_refresh_enc TEXT NULL AFTER password_enc;
