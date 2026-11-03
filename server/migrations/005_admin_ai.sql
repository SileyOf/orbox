CREATE TABLE site_settings (
  k          VARCHAR(64) PRIMARY KEY,
  v          JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN disabled TINYINT(1) NOT NULL DEFAULT 0 AFTER is_admin,
  ADD COLUMN last_login_at DATETIME NULL AFTER digest_last;

CREATE TABLE invites (
  code       CHAR(10) PRIMARY KEY,
  note       VARCHAR(100) NOT NULL DEFAULT '',
  created_by BIGINT UNSIGNED NULL,
  used_by    BIGINT UNSIGNED NULL,
  used_at    DATETIME NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- user_id 为空表示管理员提供给所有用户使用的共享模型服务
CREATE TABLE ai_providers (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NULL,
  name          VARCHAR(60) NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  base_url      VARCHAR(300) NOT NULL DEFAULT '',
  api_key_enc   TEXT NOT NULL,
  default_model VARCHAR(100) NOT NULL,
  models        JSON NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ai_providers_user (user_id),
  CONSTRAINT fk_ai_providers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_usage (
  user_id       BIGINT UNSIGNED NOT NULL,
  day           DATE NOT NULL,
  task          VARCHAR(24) NOT NULL,
  model         VARCHAR(100) NOT NULL,
  calls         INT NOT NULL DEFAULT 0,
  failures      INT NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, task, model),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
