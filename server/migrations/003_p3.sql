ALTER TABLE messages
  ADD COLUMN code VARCHAR(16) NULL AFTER snippet,
  ADD COLUMN notified TINYINT(1) NOT NULL DEFAULT 1 AFTER code,
  ADD COLUMN snoozed_until DATETIME NULL AFTER notified,
  ADD KEY ix_messages_notify (folder_id, notified),
  ADD KEY ix_messages_snooze (snoozed_until);

ALTER TABLE tasks ADD COLUMN tags JSON NULL AFTER priority;

CREATE TABLE outbox (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  send_at    DATETIME NOT NULL,
  subject    VARCHAR(1000) NOT NULL DEFAULT '',
  recipients VARCHAR(1000) NOT NULL DEFAULT '',
  envelope   JSON NOT NULL,
  raw        LONGBLOB NOT NULL,
  reply_ref  VARCHAR(500) NULL,
  status     VARCHAR(16) NOT NULL DEFAULT 'pending',
  error      VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_outbox_due (status, send_at),
  KEY ix_outbox_user (user_id),
  CONSTRAINT fk_outbox_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
