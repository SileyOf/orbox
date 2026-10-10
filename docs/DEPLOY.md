# Orbox 部署文档（v0.1.0）

适用场景：一台 Linux 服务器跑 Orbox，MySQL 和 mailcow 各自独立部署。

## 1. 准备

| 需要 | 说明 |
|---|---|
| 服务器 | 任意 Linux，装好 Docker 和 Docker Compose 插件。1 核 512MB 即可起步 |
| MySQL 8 | 必须是 MySQL 8.0 及以上（全文搜索依赖 ngram 分词器，MariaDB 不行） |
| 域名 + HTTPS | 例如 `box.example.com`，由 Nginx / Caddy 反代 |
| Telegram 机器人 | 可选。给 Orbox 单独建一个，不要和别的程序共用 Token |

服务器需要能访问：你的 MySQL、各邮箱的 IMAP(993) / SMTP(465 或 587)、`api.telegram.org`、
以及（启用 Outlook 时）`login.microsoftonline.com`。

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

```bash
cd /opt/orbox
# 更新代码后
docker compose up -d --build
```

数据库迁移在启动时自动执行。升级前建议先按第 8 节备份。版本号见 设置页底部 或 `CHANGELOG.md`。

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

### 数据库连不上

先在 Orbox 所在的服务器上确认网络是否通（把地址换成 `.env` 里的 `DB_HOST`）：

```bash
docker run --rm busybox nc -zv -w 5 数据库地址 3306
```

- **数据库在另一台机器**：在那台机器的防火墙 / 云安全组里放行 Orbox 服务器的公网 IP 访问 3306；确认 MySQL 的 `bind-address` 不是 `127.0.0.1`；确认用户是 `'orbox'@'%'` 或对应 IP。
- **数据库和 Orbox 在同一台机器**：`DB_HOST` 填 `host.docker.internal`（不要填 `127.0.0.1`，也不要填本机公网 IP）。MySQL 需要监听 docker 网桥能到达的地址（`bind-address = 0.0.0.0`，再用防火墙挡住公网），并放行来自 docker 网段的连接，例如 `ufw allow from 172.16.0.0/12 to any port 3306`。用户的来源主机要允许 `172.%`。
- **数据库也是 Docker 容器**：把两个容器放进同一个 docker 网络，`DB_HOST` 填数据库容器名。

## 已知限制（0.1.0）

- 只能单实例运行：调度器和 Telegram 长轮询都假定只有一个进程。
- 草稿只保存在浏览器本地，不会同步到服务器的草稿箱。
- 每轮同步每个文件夹只缓存 30 封邮件的正文，老邮件的全文搜索要过一段时间才覆盖到。
- 没有管理后台，用户管理需要直接操作数据库。
