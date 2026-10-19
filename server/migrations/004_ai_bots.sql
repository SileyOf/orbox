ALTER TABLE messages
  ADD COLUMN refs TEXT NULL AFTER in_reply_to,
  ADD COLUMN subject_key CHAR(40) NULL AFTER subject,
  ADD COLUMN thread_id CHAR(40) NULL AFTER subject_key,
  ADD COLUMN links JSON NULL AFTER attachments,
  ADD COLUMN ai_label VARCHAR(16) NULL AFTER code,
  ADD KEY ix_messages_thread (user_id, thread_id),
  ADD KEY ix_messages_subject_key (account_id, subject_key),
  ADD KEY ix_messages_unthreaded (account_id, thread_id);

ALTER TABLE accounts
  ADD COLUMN ai_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER save_sent,
  ADD COLUMN sieve_port INT NOT NULL DEFAULT 4190 AFTER ai_enabled;

CREATE TABLE bot_links (
  user_id   BIGINT UNSIGNED NOT NULL,
  platform  VARCHAR(16) NOT NULL,
  chat_id   VARCHAR(100) NOT NULL,
  username  VARCHAR(100) NOT NULL DEFAULT '',
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, platform),
  UNIQUE KEY uq_bot_chat (platform, chat_id),
  CONSTRAINT fk_bot_links_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO bot_links (user_id, platform, chat_id, username, linked_at)
  SELECT user_id, 'telegram', CAST(chat_id AS CHAR), username, linked_at FROM tg_links;

CREATE TABLE bot_link_codes (
  code       CHAR(8) PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_bot_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE tg_link_codes;
DROP TABLE tg_links;

CREATE TABLE ai_cache (
  user_id    BIGINT UNSIGNED NOT NULL,
  ref        VARCHAR(190) NOT NULL,
  kind       VARCHAR(16) NOT NULL,
  param      VARCHAR(32) NOT NULL DEFAULT '',
  content    MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, ref, kind, param),
  CONSTRAINT fk_ai_cache_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE api_tokens (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(100) NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  allow_send   TINYINT(1) NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_api_token (token_hash),
  CONSTRAINT fk_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
