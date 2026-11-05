ALTER TABLE users
  ADD COLUMN perms JSON NULL AFTER is_admin,
  ADD COLUMN last_seen_at DATETIME NULL AFTER last_login_at;

-- 计划的类型：普通待办 / 账单续费 / 生日纪念日；meta 里放金额、人物、农历日期等
ALTER TABLE tasks
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'task' AFTER user_id,
  ADD COLUMN meta JSON NULL AFTER tags,
  ADD KEY ix_tasks_kind (user_id, kind);

-- 简单记：随手记下的事情和花费，月底可以汇总、导出
CREATE TABLE notes (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  day          DATE NOT NULL,
  content      VARCHAR(1000) NOT NULL,
  amount       DECIMAL(12, 2) NULL,
  currency     VARCHAR(8) NOT NULL DEFAULT 'CNY',
  category     VARCHAR(30) NOT NULL DEFAULT '',
  tags         JSON NULL,
  reimbursable TINYINT(1) NOT NULL DEFAULT 0,
  reimbursed   TINYINT(1) NOT NULL DEFAULT 0,
  source       VARCHAR(16) NOT NULL DEFAULT 'web',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_notes_user_day (user_id, day),
  CONSTRAINT fk_notes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
