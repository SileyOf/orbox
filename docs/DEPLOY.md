# Orbox 部署文档

适用场景：一台 Linux 服务器跑 Orbox，MySQL 和 mailcow 各自独立部署。

## 1. 准备

| 需要 | 说明 |
|---|---|
| 服务器 | 任意 Linux，装好 Docker 和 Docker Compose 插件。1 核 512MB 即可起步 |
| MySQL 8 | 必须是 MySQL 8.0 及以上（全文搜索依赖 ngram 分词器，MariaDB 不行） |
| 域名 + HTTPS | 例如 `box.example.com`，由 Nginx / Caddy 反代 |
| Telegram 机器人 | 可选。给 Orbox 单独建一个，不要和别的程序共用 Token |

服务器需要能访问：你的 MySQL、各邮箱的 IMAP(993) / SMTP(465 或 587) / ManageSieve(4190)、
启用的聊天平台（`api.telegram.org`、`open.feishu.cn`、`discord.com`、`slack.com`）、
启用 Outlook 时的 `login.microsoftonline.com`，以及你配置的 AI 模型服务。

## 2. 建库

```sql
CREATE DATABASE orbox CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'orbox'@'%' IDENTIFIED BY '换成强密码';
GRANT ALL PRIVILEGES ON orbox.* TO 'orbox'@'%';
```

表结构不用手动建，Orbox 启动时会自动执行 `server/migrations/` 里尚未执行的迁移。
建议把 `'%'` 换成 Orbox 服务器的 IP，并在防火墙上只对它放行 3306。

## 3. 配置

把代码放到服务器（例如 `/opt/orbox`），然后：

```bash
cd /opt/orbox
cp .env.example .env
openssl rand -hex 32   # 生成 APP_SECRET
```

编辑 `.env`：

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | | 容器内监听端口，默认 8787 |
| `PUBLIC_URL` | 是 | 对外访问地址，如 `https://box.example.com`，不带结尾斜杠。决定登录 Cookie 是否仅限 HTTPS、Telegram 消息里的"打开"链接、Outlook 回调地址 |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | 是 | MySQL 连接信息 |
| `APP_SECRET` | 是 | 加密邮箱密码和 OAuth 令牌的主密钥。**务必备份；丢失或更换后，所有邮箱都要重新填密码 / 重新授权** |
| `ALLOW_REGISTRATION` | | 是否开放注册，默认 `true`。第一个注册的用户是管理员；自己注册完后建议改成 `false` |
| `TELEGRAM_BOT_TOKEN` | | 留空则不启用通知 |
| `TELEGRAM_PROXY` | | 服务器直连不了 Telegram 时填 HTTP 代理，如 `http://127.0.0.1:7890`。日本等地区留空 |
| `MS_CLIENT_ID` `MS_CLIENT_SECRET` | | Outlook 登录用，见第 7 节 |
| `FEISHU_APP_ID` `FEISHU_APP_SECRET` `FEISHU_DOMAIN` | | 飞书 / Lark 机器人，见第 11 节 |
| `DISCORD_BOT_TOKEN` | | Discord 机器人，见第 11 节 |
| `SLACK_BOT_TOKEN` `SLACK_APP_TOKEN` | | Slack 机器人，见第 11 节 |
| `AI_PROVIDER` `AI_BASE_URL` `AI_API_KEY` `AI_MODEL` `AI_FAST_MODEL` `AI_SHARED` | | 服务器默认 AI 模型，见第 12 节 |

## 4. 启动

```bash
docker compose up -d --build
docker compose logs -f
```

正常的启动日志：

```
[migrate] applied 001_init.sql
[migrate] applied 002_oauth.sql
[mail] 0 个邮箱开始同步
[orbox] listening on :8787
[telegram] @你的机器人 已启动
```

容器只监听宿主机的 `127.0.0.1:8787`，不直接对外。

## 5. 反向代理

Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name box.example.com;
    # 证书配置略

    client_max_body_size 30m;   # 单个附件上限 25MB

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 实时推送用的是 SSE 长连接，不能缓冲，也不能被短超时掐断
    location /api/events {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Caddy 更简单：

```
box.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

如果域名套了 CDN，确认它不会缓冲或掐断 `/api/events`，否则新邮件和提醒不会实时出现在网页上（Telegram 通知不受影响）。

## 6. 首次使用

1. 打开 `https://box.example.com`，注册账号（第一个注册的是管理员）。
2. 把 `.env` 里的 `ALLOW_REGISTRATION` 改成 `false`，执行 `docker compose up -d` 生效。
3. 设置 → 添加邮箱。mailcow 填法：

   | 项 | 值 |
   |---|---|
   | IMAP 服务器 | mailcow 的邮件主机名（如 `mail.example.com`，不是套了 CDN 的网页域名），993，SSL/TLS |
   | SMTP 服务器 | 留空（同 IMAP），465，SSL/TLS |
   | 用户名 | 完整邮箱地址 |
   | 密码 | 建议在 mailcow 用户面板里单独生成一个"应用密码" |

4. 设置 → 通知 → 绑定 Telegram，在机器人对话里按 Start。点"测试"确认能收到消息。
5. 设置 → 账户里确认时区正确，提醒时间和每日早报都按它计算。
6. 手机上用浏览器打开后选择"添加到主屏幕"，可以像 App 一样使用（需要 HTTPS）。
7. 需要 Telegram 之外的推送时，在 设置 → 更多通知通道 里填 Bark / ntfy / Webhook 地址，点"测试"确认。

如果 Orbox 服务器的 IP 被 mailcow 的 fail2ban 封禁（密码填错几次就会触发），在 mailcow 管理后台把它加入白名单。

## 7. 启用 Outlook 登录（可选）

Outlook / Hotmail / Microsoft 365 已停用密码登录，必须注册一个 Microsoft 应用走 OAuth。

1. 打开 [Microsoft Entra 管理中心](https://entra.microsoft.com) → 应用注册 → 新注册。
2. 受支持的帐户类型选 **"任何组织目录中的帐户和个人 Microsoft 帐户"**。
3. 重定向 URI 选 **Web**，填 `https://box.example.com/api/oauth/microsoft/callback`
   （就是 `PUBLIC_URL` 加上 `/api/oauth/microsoft/callback`，必须完全一致）。
4. 注册后在"概述"页复制 **应用程序(客户端) ID** → `MS_CLIENT_ID`。
5. 证书和密码 → 新客户端密码，复制 **值**（不是密码 ID）→ `MS_CLIENT_SECRET`。密码有有效期，到期前要换新的。
6. API 权限 → 添加权限 → 我的组织使用的 API → 搜索 **Office 365 Exchange Online** → 委托的权限，勾选
   `IMAP.AccessAsUser.All` 和 `SMTP.Send`；再到 Microsoft Graph → 委托的权限里勾选 `offline_access`、`openid`、`email`、`profile`。
7. 写入 `.env` 后 `docker compose up -d`。之后在"添加邮箱 → Outlook"里点"使用 Microsoft 账号登录"。

说明：
- 个人版 Outlook 需要先在 outlook.com 的 设置 → 邮件 → 转发和 IMAP 里开启 IMAP。
- 企业版（Microsoft 365）如果管理员关闭了 SMTP AUTH 或限制了第三方应用，授权会失败，需要管理员放行。
- 邮箱提示"授权已失效"时，在设置里编辑该邮箱点"重新授权"。

## 8. 备份

邮件本身始终在邮件服务器上，Orbox 的数据库里只是缓存，丢了可以重新同步。需要备份的是：

- **`.env`**，尤其是 `APP_SECRET`。
- **这些表**：`users`、`accounts`、`tasks`、`task_logs`、`tg_links`、`schema_migrations`。

```bash
mysqldump --single-transaction -h 数据库主机 -u orbox -p orbox \
  users accounts tasks task_logs tg_links schema_migrations > orbox-$(date +%F).sql
```

整库备份也可以，只是 `messages` 表会比较大。恢复时导入备份、放回原来的 `.env`，启动后邮件会自动重新同步。

## 9. 升级

每个新版本会提供一个升级包 `orbox-upgrade-旧版本-to-新版本.tar.gz`，里面只有变化的文件和一个升级脚本，不需要重新上传整份源码。

```bash
tar -xzf orbox-upgrade-0.1.0-to-0.1.1.tar.gz
sh orbox-upgrade-0.1.0-to-0.1.1/upgrade.sh /opt/orbox
```

脚本会做这些事：

1. 检查部署目录的当前版本是否与升级包的起始版本一致，不一致就中止（跨多个版本时按顺序逐个应用）。
2. 把将被替换的文件备份到部署目录下的 `.upgrade-backup/旧版本-to-新版本/`。
3. 覆盖变化的文件、删除已移除的文件。**不会动 `.env` 和数据库。**
4. 执行 `docker compose up -d --build` 重建并重启；数据库迁移在启动时自动执行。

可选的环境变量：`NO_RESTART=1` 只替换文件不重启；`FORCE=1` 跳过版本检查。

回滚：把 `.upgrade-backup/…/` 里的文件拷回原位，再执行 `docker compose up -d --build`。如果该版本包含数据库迁移，回滚前请先恢复升级前的数据库备份（见第 8 节）。

如果你改过 `docker-compose.yml`（例如端口），升级包恰好也更新了它时会被覆盖，改动可以从备份目录里找回。

当前版本号见 设置页底部，各版本内容见 `CHANGELOG.md`。

## 10. 排查

| 现象 | 原因和处理 |
|---|---|
| 启动即退出，提示"缺少环境变量" | `.env` 里对应项没填 |
| `[db] 无法连接…ETIMEDOUT` | 容器到数据库的网络不通，见下方"数据库连不上" |
| `[db] 无法连接…ECONNREFUSED` | 地址或端口不对。`DB_HOST` 写成了 `127.0.0.1` / `localhost` 时指向的是容器自己 |
| `[db] 无法连接…ER_ACCESS_DENIED` | 账号密码不对，或该用户不允许从 Orbox 的来源地址登录 |
| 迁移报 `ngram` 相关错误 | 数据库不是 MySQL 8 |
| 邮箱显示"连接失败" | 把鼠标悬停看具体原因。常见：主机名填成了网页域名、端口和 SSL 选项不匹配、IP 被 fail2ban 封禁 |
| `[telegram] 连接失败…重试` | 服务器到 Telegram 网络不通，配置 `TELEGRAM_PROXY` |
| `[telegram] 轮询中断…Token 正被另一个程序轮询` | 同一个 Token 在别处也在运行。给 Orbox 换一个专用机器人 |
| 登录后立刻又掉线 | `PUBLIC_URL` 是 https 但实际用 http 访问，或反代没有传 `X-Forwarded-Proto` |
| 网页不实时刷新，但手动刷新有新邮件 | 反代或 CDN 缓冲了 `/api/events`，见第 5 节 |
| Outlook 授权报 `redirect_uri` 不匹配 | Entra 里填的重定向 URI 和 `PUBLIC_URL` 不一致 |
| `[feishu]` 连不上或收不到消息 | 检查权限是否开通、事件和回调是否都选了长连接、应用版本是否已发布 |
| 飞书按钮点了没反应 | 回调 `card.action.trigger` 没有配置成长连接模式 |
| `[slack]` 启动失败 | App-Level Token 缺少 `connections:write`，或没开启 Socket Mode |
| AI 提示"这个邮箱没有开启 AI" | 在邮箱账号设置里打开"允许 AI 读取" |
| 过滤规则提示无法连接 ManageSieve | 邮件服务器没开放 4190 端口，或防火墙挡住了 |

### 数据库连不上

先在 Orbox 所在的服务器上确认网络是否通（把地址换成 `.env` 里的 `DB_HOST`）：

```bash
docker run --rm busybox nc -zv -w 5 数据库地址 3306
```

- **数据库在另一台机器**：在那台机器的防火墙 / 云安全组里放行 Orbox 服务器的公网 IP 访问 3306；确认 MySQL 的 `bind-address` 不是 `127.0.0.1`；确认用户是 `'orbox'@'%'` 或对应 IP。
- **数据库和 Orbox 在同一台机器**：`DB_HOST` 填 `host.docker.internal`（不要填 `127.0.0.1`，也不要填本机公网 IP）。MySQL 需要监听 docker 网桥能到达的地址（`bind-address = 0.0.0.0`，再用防火墙挡住公网），并放行来自 docker 网段的连接，例如 `ufw allow from 172.16.0.0/12 to any port 3306`。用户的来源主机要允许 `172.%`。
- **数据库也是 Docker 容器**：把两个容器放进同一个 docker 网络，`DB_HOST` 填数据库容器名。

## 11. 聊天机器人

四个平台都是 Orbox 主动连出去（长轮询 / WebSocket），不需要公网回调地址。每个平台只能有一个程序使用同一个机器人凭据。
配好后重启，网页 设置 → 聊天机器人 → 绑定，按提示把绑定码发给机器人即可。

机器人里能做的事：新邮件和计划提醒；点按钮阅读全文、下载附件、查看链接、翻译、AI 摘要、标记已读、归档、转为待办；
`/inbox` 看未读、`/today` 看今日计划、`/add` 新建计划；配置了 AI 后直接用自然语言提问。

### Telegram

找 @BotFather 创建机器人，把 Token 填进 `TELEGRAM_BOT_TOKEN`。

### 飞书 / Lark

1. 打开 [飞书开放平台](https://open.feishu.cn/app)（Lark 用 open.larksuite.com），创建**企业自建应用**。
2. 应用能力 → 添加**机器人**。
3. 权限管理里开通：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
   - `im:message:send_as_bot`（以应用的身份发消息）
   - `im:resource`（获取与上传图片或文件资源，发附件用）
4. 把 App ID / App Secret 填进 `.env`（Lark 还要设 `FEISHU_DOMAIN=lark`），**先启动 Orbox**，日志里出现 `[feishu] … 已连接`。
5. 事件与回调：
   - 事件配置 → 订阅方式选**使用长连接接收事件**，添加事件 `im.message.receive_v1`（接收消息）。
   - 回调配置 → 订阅方式选**使用长连接接收回调**，添加回调 `card.action.trigger`（卡片回传交互）。
   - 切换成长连接时平台会检查连接是否在线，所以要先完成第 4 步。
6. 创建版本并发布（需要企业管理员审核通过）。之后在飞书里搜索机器人，私聊发送 `绑定 绑定码`。

### Discord

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token，填进 `DISCORD_BOT_TOKEN`。
2. 私信不需要开启任何特权 Intent。
3. Installation 里开启 User Install（装到自己账号，最简单），或用 OAuth2 链接（scope 选 `bot`，权限勾选 Send Messages、Attach Files）把机器人拉进你的服务器。
4. 私信机器人，发送 `绑定 绑定码`。

### Slack

1. 打开 [Slack API](https://api.slack.com/apps) → Create New App → From scratch。
2. Socket Mode → 开启，生成 App-Level Token（scope `connections:write`，`xapp-` 开头）→ `SLACK_APP_TOKEN`。
3. OAuth & Permissions → Bot Token Scopes 添加 `chat:write`、`im:history`、`im:read`、`im:write`、`files:write`。
4. Event Subscriptions → 开启，Subscribe to bot events 添加 `message.im`。
5. Interactivity & Shortcuts → 开启（Socket Mode 下不用填地址）。
6. App Home → 打开 Messages Tab，并勾选允许用户在消息页发消息。
7. Install to Workspace，把 `xoxb-` 开头的 Bot User OAuth Token 填进 `SLACK_BOT_TOKEN`。
8. 在 Slack 里打开应用的私信，发送 `绑定 绑定码`。

## 12. AI 与 MCP

### 模型

每个用户在 设置 → AI 里配置自己的模型：

- **Claude**：接口类型选 Claude，填 Anthropic API Key，默认模型 `claude-opus-5-5`。直连官方 API 时会自动开启服务器端拒答兜底（被安全策略拒绝时自动换模型重试）。
- **OpenAI 兼容**：OpenAI、DeepSeek、通义千问、Kimi、OpenRouter、本机 Ollama 等，填接口地址、模型名和 Key。
- **快速模型**（可选）：只用于"只推送重要邮件"的分类，可以填更便宜的模型。

管理员也可以在 `.env` 里配一个服务器默认模型，设 `AI_SHARED=true` 后没有自己配置的用户也能用（费用由服务器承担）。

**隐私：**邮件内容会发给模型服务商。每个邮箱默认关闭 AI，需要在 设置 → 邮箱账号 → 编辑 里打开"允许 AI 读取这个邮箱"，
内置助手、AI 按钮和 MCP 外部连接都只能访问打开了的邮箱。

AI 生成的摘要、翻译、待办建议按邮件缓存在数据库 `ai_cache` 表里，同一封邮件不会重复调用模型。

### MCP：让外部 AI 使用 Orbox

设置 → AI 连接（MCP）→ 生成令牌。令牌只显示一次；不勾"允许直接发信"时，外部 AI 只能把邮件存进草稿箱。

**Hermes**（`~/.hermes/config.yaml`，改完在会话里执行 `/reload-mcp`）：

```yaml
mcp_servers:
  orbox:
    url: "https://box.example.com/mcp"
    headers:
      Authorization: "Bearer ${ORBOX_TOKEN}"
```

把令牌写进 `~/.hermes/.env`：`ORBOX_TOKEN=orbox_…`。

**Claude Desktop / Cursor 等**：网页生成令牌后会给出可直接复制的 JSON 配置（HTTP 传输，带 Authorization 请求头）。

提供的工具：`list_accounts`、`search_mail`、`read_mail`、`mark_mail`、`archive_mail`、`list_tasks`、`create_task`、`complete_task`、`draft_email`，
授权发信时另有 `send_email`。

## 13. 服务器端过滤规则（Sieve）

设置 → 邮箱账号 → 漏斗图标。规则通过 ManageSieve（默认 4190 端口，mailcow 自带）保存到邮件服务器，
邮件到达时由服务器执行，Orbox 不在线也生效。Orbox 写的是名为 `orbox` 的脚本；第一次保存时如果已经有别的激活脚本
（比如 SOGo 的），会用 `include` 把它带上，原有规则照常生效。Outlook（OAuth）邮箱不支持。

## 已知限制（0.1.0）

- 只能单实例运行：调度器和 Telegram 长轮询都假定只有一个进程。
- 定时发送的邮件整封存在数据库里，附件总大小上限 20MB；MySQL 的 `max_allowed_packet` 需不小于 64MB（MySQL 8 的默认值）。
- Bark / ntfy / Webhook 只能单向推送，没有操作按钮；出于安全考虑不允许填内网地址。
- 每轮同步每个文件夹只缓存 30 封邮件的正文，老邮件的全文搜索要过一段时间才覆盖到。
- 没有管理后台，用户管理需要直接操作数据库。
- AI 助手的对话保存在内存里，30 分钟不用或重启后从头开始。
- "浏览器打开原文"的链接 7 天内有效，拿到链接的人不登录也能看到那一封邮件，请勿转发。
- 聊天机器人只处理私聊消息。
