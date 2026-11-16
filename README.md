# Orbox

**自托管的邮件 + 计划客户端。** 把所有邮箱收进一个现代的网页界面，验证码秒推到手机，计划到点提醒，还能在 Telegram / 飞书里直接读信、处理待办。

兼容 mailcow 和任何标准 IMAP / SMTP 邮箱；Outlook / Microsoft 365 和 Gmail 支持 OAuth 登录。

[![版本](https://img.shields.io/badge/版本-0.7.0-cceb79)](CHANGELOG.md)
[![Docker](https://img.shields.io/docker/pulls/yuki955/orbox?label=docker%20pulls)](https://hub.docker.com/r/yuki955/orbox)
[![许可证](https://img.shields.io/badge/许可证-PolyForm%20Noncommercial-blue)](LICENSE)

> 还没到 1.0，功能在快速迭代。遇到问题或有想法，欢迎到 [Issues](https://github.com/SileyOf/orbox/issues) 反馈。

## 快速安装

需要一台装了 Docker（Compose 2.24+）的服务器，和一个 **MySQL 8.0+** 数据库（不支持 MariaDB）。

```bash
mkdir orbox && cd orbox
curl -fsSLO https://raw.githubusercontent.com/SileyOf/orbox/main/docker-compose.hub.yml
docker compose -f docker-compose.hub.yml up -d
docker compose -f docker-compose.hub.yml logs | grep 安装码
```

然后打开网页，跟着**安装向导**走四步：

1. 输入日志里的**安装码**
2. 填**数据库**地址和账号（库不存在会自动创建）
3. 填**站点名称**和访问地址
4. 创建**管理员账号**——完成，直接进入

不用写任何配置文件。密钥自动生成，和数据库连接一起保存在 `orbox-data` 数据卷里，**备份时请带上它**。

服务默认只监听本机 `127.0.0.1:8787`，请用 Nginx / Caddy 反向代理并配置 HTTPS 后，用域名访问。反代配置、备份、排查等见 [部署文档](docs/DEPLOY.md)。

<details>
<summary>其他安装方式：用 .env 配置 / 从源码构建</summary>

**用配置文件代替向导**：把 [.env.example](.env.example) 存成 compose 文件同目录的 `.env` 并填好。`.env` 里的配置优先于向导保存的配置。

**从源码构建**：

```bash
git clone https://github.com/SileyOf/orbox.git && cd orbox
cp .env.example .env   # 可以填好配置；也可以不改，启动后在安装向导里填
docker compose up -d --build
```

镜像 [`yuki955/orbox`](https://hub.docker.com/r/yuki955/orbox) 支持 `linux/amd64` 和 `linux/arm64`；想固定版本，把 compose 文件里的 `latest` 换成版本号。

</details>

**升级**：`docker compose -f docker-compose.hub.yml pull && docker compose -f docker-compose.hub.yml up -d`，数据库结构会在启动时自动升级。升级前建议先备份数据库。

## 能做什么

**📬 邮件**
- 多用户、多邮箱，统一收件箱；新邮件实时到达
- 自动识别**验证码**（中 / 英 / 日 / 韩常见写法），通知里一键复制
- 会话线程、全文搜索、稍后处理、定时发送、撤销发送、服务器草稿
- 自动提取续费、验证、物流、退订等关键链接，并提示可疑的钓鱼链接
- HTML 邮件在沙箱里渲染，默认拦截追踪图片
- 可视化编辑服务器端过滤规则（Sieve）

**✅ 计划**
- 一句话添加（"明天9点 交报告"），到点提醒，没处理会再催
- 周期计划：账单 / 续费（点"已付"自动记账并滚到下一期）、生日 / 纪念日（支持农历）
- 简单记：一句话记事记账，出差期间的花费自动归集，月底汇总、导出表格

**🔔 通知与机器人**
- Telegram、飞书 / Lark、Discord、Slack 机器人：推送、读全文、下载附件、处理邮件和计划
- Bark、ntfy、Webhook 推送；每个渠道可分别选择接收哪些事件；每日早报、免打扰时段

**🤖 AI（可选）**
- 接入 Claude 或任何 OpenAI 兼容接口（DeepSeek、通义、Kimi、Ollama……）
- 摘要、翻译、提取待办、起草回复、重要邮件过滤；网页和机器人里都能用的对话助手
- 便宜的模型做高频小任务，强的模型做理解和写作；关掉 AI 时用本地规则，不花钱
- MCP 服务：让 Claude Desktop、Cursor 等外部 AI 把 Orbox 当作工具
- 每个邮箱默认不允许 AI 读取，需要单独开启

**🔐 账号与管理**
- 两步验证（动态码 App、邮箱验证码、恢复码）、邮箱验证、邮件找回密码、登录设备管理
- 后台：站点外观、注册方式（开放 / 邀请码 / 关闭）、用户与权限、共享模型、运行日志
- 机器人、Outlook / Gmail 登录、系统发信的凭据都在网页里配置，带分步说明
- 浅色 / 深色 / 自动、通透 / 实色面板、强调色；可安装到手机主屏幕（PWA）

## 文档

| | |
|---|---|
| [部署文档](docs/DEPLOY.md) | 建库、反向代理、备份、升级、排查、各平台机器人和 OAuth 的配置 |
| [更新记录](CHANGELOG.md) | 每个版本的变化和升级说明 |
| [.env.example](.env.example) | 全部可用的环境变量 |

## 本地开发

```bash
cp .env.example .env   # 填好数据库和 APP_SECRET，PUBLIC_URL 用 http://localhost:5173
npm install
npm run dev            # 后端 :8787，前端 :5173
npm test -w server     # 解析器、地址校验、动态码等单元测试
```

```
server/   Fastify + ImapFlow + Nodemailer，MySQL 8
  migrations/   数据库迁移，启动时自动执行
  src/mail/     同步引擎、解析、发信、OAuth、Sieve
  src/tasks/    计划、重复规则、农历、调度器
  src/notes/    简单记
  src/bots/     聊天机器人网关
  src/ai/       模型接入、AI 功能、助手和工具（MCP 共用）
web/      React + Vite 单页应用
```

邮件服务器始终是邮件的唯一来源，MySQL 里只是信封、标志和正文缓存，丢了可以重新同步。
需要备份的是数据库（邮件缓存表可以不备份）和 `APP_SECRET`：用向导安装的在 `orbox-data` 数据卷的 `config.json` 里，用 `.env` 配置的在 `.env` 里。

## 路线

- [x] 多邮箱收发、搜索、会话线程、Sieve、链接提取、验证码识别
- [x] Outlook 和 Gmail 的 OAuth 登录
- [x] Telegram / 飞书 / Discord / Slack 机器人，Bark / ntfy / Webhook
- [x] AI 多模型按任务分配、助手、MCP
- [x] 后台管理、用户权限、运行日志、网页安装向导
- [x] 周期计划（账单、农历生日）、简单记
- [x] 两步验证、邮箱验证、找回密码
- [ ] 通行密钥（Passkey）、接口级自动化测试
- [ ] 1.0：稳定的数据结构和升级路径

## 许可证

Orbox 以 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布：**源码公开，可免费用于个人、学习、研究和非营利用途，可以修改和再分发**（需保留许可证和版权声明）。

**未经授权不得用于商业用途**（包括在公司内部使用、作为付费服务提供给他人等）。需要商业授权请通过 [Issues](https://github.com/SileyOf/orbox/issues) 联系作者。

因为限制了商业用途，它不属于 OSI 定义的"开源许可证"，而是"源码公开"（source-available）。

Copyright (c) 2026 Yuki
