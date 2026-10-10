# Orbox

当前版本 0.2.0，更新记录见 [CHANGELOG.md](CHANGELOG.md)。

起源系列的邮件与计划客户端：多邮箱 Webmail + Telegram 通知 + 带提醒的计划表。
兼容 mailcow，也能接入任何标准 IMAP/SMTP 邮箱。

## 结构

```
server/   Fastify + ImapFlow + Nodemailer + grammY，MySQL 8
  migrations/   SQL 迁移，启动时自动执行
  src/mail/     同步引擎（manager）、解析、发信
  src/tasks/    计划表、重复规则、调度器、一句话解析
  src/notify/   Telegram 机器人
web/      React + Vite 单页应用
```

IMAP 服务器始终是邮件的唯一真相，MySQL 里只是信封、标志和正文缓存，丢了可以重新同步。
需要备份的是 `users / accounts / tasks / task_logs / tg_links` 这几张表，以及 `.env` 里的 `APP_SECRET`。

## 本地开发

```bash
cp .env.example .env   # 填好数据库和 APP_SECRET
npm install
npm run dev            # 后端 :8787，前端 :5173
```

第一个注册的用户自动成为管理员。之后可把 `ALLOW_REGISTRATION` 设为 `false` 关闭注册。

## 部署

完整步骤（建库、配置、反代、Outlook 应用注册、备份、升级、排查）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

```bash
cp .env.example .env
docker compose up -d --build
```

## 路线

- [x] 多邮箱收发、搜索、附件、主题与强调色
- [x] Telegram 新邮件通知、计划提醒、按钮完成 / 稍后 / 跳过、每日早报
- [x] Outlook / Microsoft 365 OAuth 登录
- [x] 验证码提取、新邮件快速通道
- [x] 稍后处理、定时发送、服务器草稿、引用折叠、PWA、Bark / ntfy / Webhook
- [ ] 会话线程、Sieve 规则、Gmail OAuth、管理后台
- [ ] AI：摘要、待办提取、重要性分类、回复草稿
