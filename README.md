# Orbox

自托管的**邮件 + 计划**客户端：多邮箱 Webmail、验证码秒推、带提醒的计划表、聊天机器人和 AI 助手。
兼容 mailcow，也能接入任何标准 IMAP / SMTP 邮箱，Outlook / Microsoft 365 支持 OAuth 登录。

> 当前版本 **0.5.1**，还没到 1.0：功能在快速迭代，可能有不兼容的改动。欢迎在 Issues 里反馈问题和建议。
> 更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

**邮件**
- 多用户、多邮箱，统一收件箱；IMAP IDLE 实时到达，新邮件快速通道
- 自动识别验证码（中 / 英 / 日 / 韩常见写法），通知里一键复制
- 会话线程、全文搜索、附件、稍后处理、定时发送、撤销发送、服务器草稿
- 链接提取（续费、验证、物流、退订……）与钓鱼链接提示
- HTML 邮件沙箱渲染，默认拦截远程图片（追踪像素）
- 可视化编辑服务器端过滤规则（Sieve）

**计划**
- 一句话添加（"明天9点 交报告"）、提前提醒、重复规则、没处理时反复提醒
- 周期计划：账单 / 续费（点"已付"自动记账并滚到下一期）、生日 / 纪念日（支持农历）
- 简单记：一句话记事记账，出差模式自动归集可报销花费，月底汇总、导出 CSV

**通知与机器人**
- Telegram、飞书 / Lark、Discord、Slack 机器人：推送、读全文、下载附件、处理邮件和计划
- Bark、ntfy、Webhook 推送；每个渠道可分别选择接收哪些事件；每日早报、免打扰时段

**AI（可选）**
- 接入 Claude 或任何 OpenAI 兼容接口（DeepSeek、通义、Kimi、Ollama……），多个服务按任务分配模型
- 摘要、翻译、提取待办、起草回复、重要邮件过滤；对话式助手（网页和聊天机器人里都能用）
- MCP 服务：让 Claude Desktop、Cursor 等外部 AI 把 Orbox 当作工具
- 每个邮箱默认不允许 AI 读取，需要单独开启

**管理**
- 后台：站点外观、注册方式（开放 / 邀请码 / 关闭）、用户与权限、网页配置机器人凭据、共享模型、运行日志
- 外观：浅色 / 深色 / 自动、通透 / 实色面板、强调色；可安装为 PWA

## 快速开始

需要：Docker（含 Compose 插件），以及一个 **MySQL 8.0+** 数据库（全文搜索依赖 ngram，MariaDB 不行）。

### 方式一：直接用 Docker Hub 镜像

```bash
mkdir orbox && cd orbox
curl -fsSLO https://raw.githubusercontent.com/SileyOf/orbox/main/docker-compose.hub.yml
curl -fsSL https://raw.githubusercontent.com/SileyOf/orbox/main/.env.example -o .env
# 编辑 .env：至少填数据库连接、APP_SECRET（openssl rand -hex 32）、PUBLIC_URL
docker compose -f docker-compose.hub.yml up -d
```

镜像：[`yuki955/orbox`](https://hub.docker.com/r/yuki955/orbox)，支持 `linux/amd64` 和 `linux/arm64`。

### 方式二：从源码构建

```bash
git clone https://github.com/SileyOf/orbox.git && cd orbox
cp .env.example .env   # 同上，填好配置
docker compose up -d --build
```

服务监听 `127.0.0.1:8787`，请用 Nginx / Caddy 反代并配置 HTTPS。打开网页后**第一个注册的用户自动成为管理员**。

建库、反代、Outlook 应用注册、各聊天平台配置、备份、升级、排查等完整步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 本地开发

```bash
cp .env.example .env   # 填好数据库和 APP_SECRET，PUBLIC_URL 用 http://localhost:5173
npm install
npm run dev            # 后端 :8787，前端 :5173
npm test -w server     # 验证码、链接、简单记解析的测试
```

```
server/   Fastify + ImapFlow + Nodemailer，MySQL 8
  migrations/   SQL 迁移，启动时自动执行
  src/mail/     同步引擎、解析、发信、Sieve
  src/tasks/    计划、重复规则、农历、调度器
  src/notes/    简单记
  src/bots/     聊天机器人网关
  src/ai/       模型接入、AI 功能、助手和工具（MCP 共用）
web/      React + Vite 单页应用
```

IMAP 服务器始终是邮件的唯一来源，MySQL 里只是信封、标志和正文缓存，丢了可以重新同步。
需要备份的是数据库（邮件缓存表可以不备份）和 `.env` 里的 `APP_SECRET`（邮箱密码等用它加密）。

## 路线

- [x] 多邮箱收发、搜索、附件、OAuth（Outlook）
- [x] 验证码提取、新邮件快速通道、稍后处理、定时发送、会话线程、Sieve、链接提取
- [x] Telegram / 飞书 / Discord / Slack 机器人，Bark / ntfy / Webhook
- [x] AI 多模型按任务分配、本地规则兜底、助手、MCP
- [x] 后台管理、用户权限、运行日志
- [x] 周期计划（账单、农历生日）、简单记
- [ ] Gmail OAuth、两步验证
- [ ] 1.0：稳定的数据结构和升级路径

## 许可证

Orbox 以 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布：**源码公开，可免费用于个人、学习、研究和非营利用途，可以修改和再分发**（需保留许可证和版权声明）。

**未经授权不得用于商业用途**（包括在公司内部使用、作为付费服务提供给他人等）。需要商业授权请通过 [Issues](https://github.com/SileyOf/orbox/issues) 联系作者。

注意：因为限制了商业用途，它不属于 OSI 定义的"开源许可证"，而是"源码公开"（source-available）。

Copyright (c) 2026 Yuki
