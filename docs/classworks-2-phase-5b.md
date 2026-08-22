# Classworks 2.0 第五阶段 B：单机生产部署

本阶段把两个仓库组合成适合一台海外云服务器的生产栈。默认域名为 `cs.newfires.top`，浏览器只访问一个 HTTPS 站点。

## 运行结构

- `caddy`：唯一对公网开放的容器，监听 80/443，自动申请和续期 TLS 证书。
- `frontend`：Nginx 静态托管 NPClassworks PWA，不直接暴露端口。
- `backend`：NPClassworksKV、Socket.IO 和 Classworks 2.0 API，不直接暴露端口。
- `postgres`：PostgreSQL 数据库，只在 Docker 内部网络可见。

Caddy 将 `/api`、`/accounts`、`/kv`、`/apps`、`/devices`、`/auth`、`/auto-auth`、`/socket.io`、健康检查和指标请求转发给后端，其余请求交给前端。因此旧 UUID/KV 模式与新版班级模式可以继续共用一个域名。

## 服务器准备

1. 为 `cs.newfires.top` 添加指向云服务器公网地址的 A 记录；只有服务器确实配置 IPv6 时才添加 AAAA 记录。
2. 防火墙只需对公网开放 SSH、TCP 80、TCP/UDP 443。不要开放 3000 和 5432。
3. 安装 Git、Docker Engine 和 Docker Compose。
4. 将两个仓库克隆为同级目录：

```text
/opt/npclassworks/NPClassworks
/opt/npclassworks/NPClassworksKV
```

联合 Compose 位于 NPClassworksKV，前端构建上下文默认是相邻的 `../NPClassworks`。

## 首次部署

在 NPClassworksKV 中执行：

```bash
pnpm run deploy:init
pnpm run deploy:check -- deploy/.env.production
docker compose --env-file deploy/.env.production build
docker compose --env-file deploy/.env.production up -d
docker compose --env-file deploy/.env.production ps
```

填写环境文件时：

- `POSTGRES_PASSWORD`、`JWT_SECRET`、`REFRESH_TOKEN_SECRET`、`METRICS_TOKEN` 使用不同的随机 URL-safe 值，至少 32 字符。
- Phase 5D 起 OAuth 为可选兼容方式；无邮箱学校需配置随机 `BOOTSTRAP_SETUP_KEY`，并可直接使用教师短账号与 PIN。
- 对应 OAuth 应用的回调地址为 `https://cs.newfires.top/accounts/oauth/<provider>/callback`。
- 环境文件已被 `.gitignore` 排除，不要上传到 Git。

后端容器每次启动都会先执行 `prisma migrate deploy`，成功后才启动 HTTP 服务。迁移失败时容器不会带着旧数据库结构继续运行。

## 验收

```bash
curl https://cs.newfires.top/check
curl https://cs.newfires.top/ready
docker compose --env-file deploy/.env.production logs --tail=200 backend caddy
```

随后在浏览器中依次验证：

1. 旧作业板可以读取原 UUID 数据。
2. `/classworks-2` 能列出学校、行政班和走班选项。
3. 一班、二班的小科显示为“随行政班”，不会要求选择走班。
4. 按学校选择的策略验证教师短账号/PIN或 OAuth 登录、发布测试通知、学生实时刷新均正常。
5. 在两台浏览器登录同一教师账户，一台退出后另一台仍保持登录。

## 数据与更新

持久数据保存在 Docker 命名卷 `postgres-data`，证书保存在 `caddy-data`。删除容器不会删除命名卷；不要使用 `docker compose down -v`，否则会删除数据库和证书数据。

仓库现已提供生产运维脚本：`bash deploy/backup.sh` 创建带 SHA-256 校验的 PostgreSQL 压缩备份，`sudo bash deploy/install-backup-timer.sh` 安装每日备份，`bash deploy/upgrade.sh <版本标签>` 在升级前自动备份并保留上一组镜像。应用回滚使用 `bash deploy/rollback.sh`；涉及不兼容数据库迁移时使用 `bash deploy/rollback.sh --restore-database --yes`。上线初期仍建议保留云厂商磁盘快照，并定期把 `deploy/backups` 复制到服务器之外。

## 健康与关闭

- `/check`：仅表示 Node 进程存活。
- `/ready`：额外执行 PostgreSQL 查询，供容器健康检查使用。
- 收到 SIGTERM/SIGINT 后，后端会关闭 Socket.IO、HTTP 与 Prisma，并最多等待 10 秒。
- `/metrics` 必须携带 `Authorization: Bearer <METRICS_TOKEN>`。
