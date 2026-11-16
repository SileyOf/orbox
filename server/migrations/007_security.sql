-- 邮箱验证、两步验证、找回密码
ALTER TABLE users
  ADD COLUMN email_verified_at DATETIME NULL AFTER email,
  ADD COLUMN verify_pending TINYINT(1) NOT NULL DEFAULT 0 AFTER email_verified_at,
  ADD COLUMN totp_secret_enc VARCHAR(255) NULL,
  ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN email_otp TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN recovery_codes JSON NULL;

-- 发到邮箱的一次性验证码（只存哈希）：验证邮箱、更换邮箱、找回密码、邮箱两步验证
CREATE TABLE auth_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(190) NOT NULL,
  purpose    VARCHAR(16) NOT NULL,
  code_hash  CHAR(64) NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  user_id    BIGINT UNSIGNED NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_auth_codes_email (email, purpose),
  KEY ix_auth_codes_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OAuth 邮箱记下是哪家授权的（之前只有 Microsoft）
ALTER TABLE accounts ADD COLUMN oauth_provider VARCHAR(16) NULL AFTER auth_type;
UPDATE accounts SET oauth_provider = 'microsoft' WHERE auth_type = 'oauth'
