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
| `ALLOW_REGISTRATION` | | 只作为初始值；之后在后台"注册与用户"里设置 |
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
2. 打开后台（默认 `https://box.example.com/admin`，也可以从 设置 → 后台管理 进入）：
   - **站点外观**：站点名、副标题、Logo、登录页说明、页脚、新用户默认主题，以及后台路径（建议改成不容易猜到的）。
   - **注册与用户**：注册方式（开放 / 凭邀请码 / 关闭）、邀请码、停用或删除用户、重置密码。
   - **集成**：Telegram、飞书 / Lark、Discord、Slack、Microsoft 的凭据都在这里填，保存后立即连接，不用改 `.env`、不用重启。
   - **共享模型**：给所有用户提供的模型服务（可选）。
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

### 在哪里看日志

- **后台 → 运行日志**：最近 3000 行，可按级别筛选、搜索（例如搜 `feishu`）、下载。连不上的平台在 后台 → 集成 里也会直接显示失败原因，并且每隔一段时间自动重试。
- **命令行**：在 `docker-compose.yml` 所在目录执行 `docker compose logs -f --tail=200`。
  注意 compose 起的容器名一般是 `目录名-orbox-1`，不是 `orbox`，所以 `docker logs orbox` 会找不到；用 `docker compose ps` 查看实际名字。
- **日志文件**：0.5 起默认同时写入容器内 `/app/logs/orbox.log`（5MB 轮转一次，保存在名为 `orbox-logs` 的 docker 卷里）：
  `docker compose exec orbox tail -f /app/logs/orbox.log`。
  想放到宿主机目录，可把 `docker-compose.yml` 里的 `orbox-logs:/app/logs` 改成 `./logs:/app/logs`，并先执行 `mkdir logs && sudo chown 1000:1000 logs`（容器以 node 用户运行）。

日志里的 Token、密码、API Key 会自动打码。

| 现象 | 原因和处理 |
|---|---|
| 启动即退出，提示"缺少环境变量" | `.env` 里对应项没填 |
| 启动报 `Invalid URL` / `PUBLIC_URL 格式不对` | `PUBLIC_URL` 要写完整地址，例如 `https://orbox.example.com`（0.5.1 起只写域名也会自动补 `https://`） |
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
| 飞书提示 `could not resolve bot identity via /open-apis/bot/v3/info` | 应用没有开启**机器人能力**，或开启后没有发布新版本。0.5 起会直接显示飞书返回的错误码和处理办法，发布通过后自动重连 |
| `[feishu]` 连不上或收不到消息 | 检查权限是否开通、事件和回调是否都选了长连接、应用版本是否已发布 |
| 飞书按钮点了没反应 | 回调 `card.action.trigger` 没有配置成长连接模式 |
| `[slack]` 启动失败 | App-Level Token 缺少 `connections:write`，或没开启 Socket Mode |
| AI 提示"这个邮箱没有开启 AI" | 在邮箱账号设置里打开"允许 AI 读取" |
| 过滤规则提示无法连接 ManageSieve | 邮件服务器没开放 4190 端口，或防火墙挡住了 |
| 日志里偶尔出现 `Connection lost: The server closed the connection` | 数据库（或中间的防火墙）断开了空闲连接。0.5 起会保活并自动换连接重试；仍频繁出现时把 MySQL 的 `wait_timeout` 调大（默认 8 小时即可） |
| 普通用户添加邮箱 / 模型服务提示"指向内网或本机地址" | 出于安全默认不允许普通用户连接内网地址。确需使用（例如同机的 Ollama）时，在 后台 → 注册与用户 里给这个用户开"允许连接内网地址" |
| 登录提示"失败次数太多" | 同一邮箱 15 分钟内输错 10 次（或同一 IP 30 次）会暂时锁定，15 分钟后自动解除；重启 Orbox 也会清除 |

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

**推荐在网页里配置**：后台 → 集成，每个平台都有分步说明，保存后立即连接并显示结果。
- 飞书 / Lark 可以**扫码一键创建应用**（权限、事件、回调自动预填），创建后只需在开放平台把事件和回调的订阅方式切到长连接、发布版本。
- Slack 提供可直接粘贴的**应用清单**（From a manifest），Socket Mode、权限、事件、交互一次配好。
- Discord 保存 Token 后会给出**邀请机器人进服务器**的链接。

网页里填的凭据保存在数据库（密钥加密），优先于 `.env`；`.env` 里的同名配置只作为初始值。下面是手动配置的说明，供参考。

用户在 设置 → 通知渠道 里绑定，并为每个渠道选择接收哪些事件（新邮件、验证码、计划提醒、早报、稍后处理）。

机器人里能做的事：新邮件和计划提醒；点按钮阅读全文、下载附件、查看链接、翻译、AI 摘要、标记已读、归档、转为待办；
`/inbox` 看未读、`/today` 看今日计划、`/add` 新建计划；配置了 AI 后直接用自然语言提问。

### Telegram

找 @BotFather 创建机器人，把 Token 填进 `TELEGRAM_BOT_TOKEN`。

### 飞书 / Lark

1. 打开 [飞书开放平台](https://open.feishu.cn/app)（Lark 用 open.larksuite.com），创建**企业自建应用**（也可以在 后台 → 集成 里扫码创建）。
2. 应用能力 → 添加**机器人**。**扫码创建的应用也要确认这一步**，没开机器人能力时连接会报 `could not resolve bot identity`。
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

### 模型服务与任务分配

每个用户在 设置 → AI 里可以添加**多个模型服务**（Claude，或任意 OpenAI 兼容接口：OpenAI、DeepSeek、小米 MiMo、通义千问、Kimi、智谱、硅基流动、OpenRouter、本机 Ollama……），
然后给每项任务分配模型：

| 任务 | 类型 | 关闭时 |
|---|---|---|
| 通知过滤、验证码提取、链接整理 | 快速：每封新邮件都会触发，建议用便宜快速的模型 | 使用本地规则（零成本，准确率有限） |
| 摘要、翻译、提取待办、起草回复、助手 | 强：需要理解和写作 | 功能关闭 |

几项快速任务用同一个模型时会合成一次调用。AI 分拣最多等 8 秒，超时就按本地规则推送，不会拖慢通知。
AI 补出的验证码必须在邮件原文里出现，否则丢弃，避免模型编造。设置页底部有最近 30 天每项任务、每个模型的调用次数和 token 用量。

Claude 直连官方 API 时会自动开启服务器端拒答兜底（被安全策略拒绝时自动换模型重试）。

管理员可以在后台 → 共享模型 里提供服务器出资的模型服务，并决定是否允许普通用户使用。
0.3 版的单一模型配置和 `.env` 里的 `AI_*` 会在升级后自动转换成模型服务。

**隐私：**邮件内容会发给模型服务商。每个邮箱默认关闭 AI，需要在 设置 → 邮箱 → 编辑 里打开"允许 AI 读取这个邮箱"，
内置助手、AI 按钮、新邮件分拣和 MCP 外部连接都只能访问打开了的邮箱。

### MCP：让外部 AI 使用 Orbox

令牌只显示一次；不勾"允许直接发信"时，外部 AI 只能把邮件存进草稿箱。

在 设置 → AI 连接（MCP）里生成令牌。

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

设置 → 邮箱 → 漏斗图标。规则通过 ManageSieve（默认 4190 端口，mailcow 自带）保存到邮件服务器，
邮件到达时由服务器执行，Orbox 不在线也生效。Orbox 写的是名为 `orbox` 的脚本；第一次保存时如果已经有别的激活脚本
（比如 SOGo 的），会用 `include` 把它带上，原有规则照常生效。Outlook（OAuth）邮箱不支持。

## 14. 用户与权限

后台 → 注册与用户：
- **默认权限**：新用户和没有单独设置的用户使用这里的权限。包括邮箱数量上限、使用共享模型、自己添加模型服务、聊天机器人、MCP 外部连接、允许连接内网地址。
- 每个用户可以点"编辑"：改名字和登录邮箱、设为管理员、停用、单独设置权限、重置密码、退出所有设备、删除。
- 列表里的"最近活跃"按实际使用时间计算（0.5 之前只记录登录时间，所以老用户会显示为上次登录的时间）。
- 管理员不受权限限制。"允许连接内网地址"有探测服务器内网的风险，只给信任的人。

## 15. 周期计划与简单记

计划页新增两个标签：
- **周期**：账单 / 续费（每期金额、周期、提前几天提醒、付款链接；点"已付"后自动记一笔到简单记并滚动到下一期，页面上显示每月固定支出）；生日 / 纪念日（公历或农历，按出生年份显示年龄，每年提前提醒）。
- **简单记**：一句话记事、记账，例如 `打车 56 报销`、`昨天 酒店 ¥420`、`护照放在书房抽屉`。
  发 `出差 上海` 开始一次出差，期间记的花费自动打上这次出差的标签、标为可报销；发 `出差结束` 结束。按月或按出差汇总、标记已报销、导出 CSV（Excel 可直接打开）。
- 聊天机器人里：`记 打车 56` 直接记一笔；开了 AI 助手时直接说"今天出差去上海""打车花了 56""这个月出差报销一共多少"即可。

## 已知限制（0.1.0）

- 只能单实例运行：调度器和 Telegram 长轮询都假定只有一个进程。
- 定时发送的邮件整封存在数据库里，附件总大小上限 20MB；MySQL 的 `max_allowed_packet` 需不小于 64MB（MySQL 8 的默认值）。
- Bark / ntfy / Webhook 只能单向推送，没有操作按钮；出于安全考虑不允许填内网地址。
- 每轮同步每个文件夹只缓存 30 封邮件的正文，老邮件的全文搜索要过一段时间才覆盖到。
- AI 助手的对话保存在内存里，30 分钟不用或重启后从头开始。
- "浏览器打开原文"的链接 7 天内有效，拿到链接的人不登录也能看到那一封邮件，请勿转发。
- 聊天机器人只处理私聊消息。
- 登录失败的限流计数保存在内存里，重启后清零；多实例部署时各自计数。
- 简单记按币种分别汇总，不做汇率换算。
- 农历日期使用系统自带的 ICU 中国农历计算，个别年份与部分万年历可能相差一天。
