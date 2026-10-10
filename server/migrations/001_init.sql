CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL,
  name          VARCHAR(100) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  is_admin      TINYINT(1) NOT NULL DEFAULT 0,
  timezone      VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  settings      JSON NULL,
  digest_last   DATE NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id         CHAR(64) PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE accounts (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(190) NOT NULL,
  from_name    VARCHAR(100) NOT NULL DEFAULT '',
  color        VARCHAR(16) NOT NULL DEFAULT '#498a97',
  imap_host    VARCHAR(190) NOT NULL,
  imap_port    INT NOT NULL DEFAULT 993,
  imap_secure  TINYINT(1) NOT NULL DEFAULT 1,
  smtp_host    VARCHAR(190) NOT NULL,
  smtp_port    INT NOT NULL DEFAULT 465,
  smtp_secure  TINYINT(1) NOT NULL DEFAULT 1,
  username     VARCHAR(190) NOT NULL,
  password_enc TEXT NOT NULL,
  signature    TEXT NULL,
  notify       TINYINT(1) NOT NULL DEFAULT 1,
  save_sent    TINYINT(1) NOT NULL DEFAULT 1,
  sync_state   VARCHAR(16) NOT NULL DEFAULT 'idle',
  last_error   VARCHAR(500) NULL,
  last_sync_at DATETIME NULL,
  sort         INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_accounts_user (user_id),
  CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE folders (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NOT NULL,
  path           VARCHAR(255) NOT NULL,
  name           VARCHAR(255) NOT NULL,
  role           VARCHAR(16) NULL,
  uid_validity   BIGINT UNSIGNED NULL,
  last_uid       INT UNSIGNED NOT NULL DEFAULT 0,
  highest_modseq BIGINT UNSIGNED NULL,
  total          INT NOT NULL DEFAULT 0,
  unread         INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_folders_path (account_id, path),
  CONSTRAINT fk_folders_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE messages (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  account_id      BIGINT UNSIGNED NOT NULL,
  folder_id       BIGINT UNSIGNED NOT NULL,
  uid             INT UNSIGNED NOT NULL,
  message_id      VARCHAR(500) NULL,
  in_reply_to     VARCHAR(500) NULL,
  subject         VARCHAR(1000) NOT NULL DEFAULT '',
  from_name       VARCHAR(255) NOT NULL DEFAULT '',
  from_addr       VARCHAR(255) NOT NULL DEFAULT '',
  to_json         JSON NULL,
  cc_json         JSON NULL,
  reply_to        VARCHAR(255) NULL,
  date            DATETIME NOT NULL,
  size            INT UNSIGNED NOT NULL DEFAULT 0,
  seen            TINYINT(1) NOT NULL DEFAULT 0,
  flagged         TINYINT(1) NOT NULL DEFAULT 0,
  answered        TINYINT(1) NOT NULL DEFAULT 0,
  has_attachments TINYINT(1) NOT NULL DEFAULT 0,
  snippet         VARCHAR(400) NOT NULL DEFAULT '',
  body_fetched    TINYINT(1) NOT NULL DEFAULT 0,
  body_text       MEDIUMTEXT NULL,
  body_html       MEDIUMTEXT NULL,
  attachments     JSON NULL,
  UNIQUE KEY uq_messages_uid (folder_id, uid),
  KEY ix_messages_folder_date (folder_id, date),
  KEY ix_messages_user_date (user_id, date),
  KEY ix_messages_account (account_id),
  KEY ix_messages_ref (user_id, message_id(120)),
  FULLTEXT KEY ft_messages (subject, from_name, from_addr, body_text) WITH PARSER ngram,
  CONSTRAINT fk_messages_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tasks (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(500) NOT NULL,
  notes          TEXT NULL,
  due_at         DATETIME NULL,
  remind_before  INT NOT NULL DEFAULT 0,
  repeat_rule    JSON NULL,
  priority       TINYINT NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'open',
  completed_at   DATETIME NULL,
  next_remind_at DATETIME NULL,
  nag_interval   INT NOT NULL DEFAULT 0,
  nag_count      INT NOT NULL DEFAULT 0,
  mail_ref       VARCHAR(500) NULL,
  mail_subject   VARCHAR(500) NULL,
  source         VARCHAR(16) NOT NULL DEFAULT 'web',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_tasks_user (user_id, status, due_at),
  KEY ix_tasks_remind (status, next_remind_at),
  CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_logs (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  action     VARCHAR(16) NOT NULL,
  due_at     DATETIME NULL,
  via        VARCHAR(16) NOT NULL DEFAULT 'web',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_task_logs_task (task_id),
  KEY ix_task_logs_user (user_id, created_at),
  CONSTRAINT fk_task_logs_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tg_links (
  user_id   BIGINT UNSIGNED PRIMARY KEY,
  chat_id   BIGINT NOT NULL,
  username  VARCHAR(100) NOT NULL DEFAULT '',
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tg_chat (chat_id),
  CONSTRAINT fk_tg_links_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tg_link_codes (
  code       CHAR(32) PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  CONSTRAINT fk_tg_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
