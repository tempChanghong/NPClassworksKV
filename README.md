<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./images/官网用星火动力反色.svg">
    <img src="./images/星火动力0702.svg" width="112" alt="星火动力 NOVARK POWER">
  </picture>
</p>

<h1 align="center">NPClassworksKV</h1>

<p align="center">
  NPClassworks 的后端、实时同步与学校数据服务<br>
  由 <strong>星火动力（NOVARK POWER）</strong> 维护
</p>

![License](https://img.shields.io/github/license/tempChanghong/NPClassworksKV?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169e1?style=flat-square&logo=postgresql&logoColor=white)

NPClassworksKV 是 [NPClassworks](https://github.com/tempChanghong/NPClassworks) 的配套后端，负责学校组织结构、账号与权限、作业和通知、历史版本、班级大屏设备以及 Socket.IO 实时同步。它源自 Classworks 后端体系，现已针对多行政班、选科定班和走班教学进行了扩展。

当前版本：**v1.0.0 · Nijika（伊地知虹夏）**，与同一产品发布中的 NPClassworks 前端保持一致。

## 主要能力

- 学校、学期、年级、行政班、走班教学班和学科规则
- 学生、教师、学校管理员和班级大屏账号体系
- 本地短账号、个人 PIN、学校通用教师口令及可选 OAuth
- 作业、通知、教师认证、修订历史和恢复机制
- 大屏独立设备绑定、课堂工具与通知送达回执
- 学校级快捷词、快捷截止时间等统一配置
- PostgreSQL + Prisma 数据层和数据库迁移
- Socket.IO 房间同步、限流、健康检查和可观测性接口

Classworks 1 的 UUID/KV、应用安装、旧设备授权和 token Socket 通道已经退役；对应 HTTP 路径由生产网关返回 410。为保证全新安装、升级和回滚一致，历史 Prisma 迁移和遗留表结构暂不删除。

## 本地调试

环境要求：Node.js 22+、pnpm 10+、Docker。

```bash
git clone https://github.com/tempChanghong/NPClassworksKV.git
cd NPClassworksKV
pnpm install
pnpm run debug:init
pnpm run debug:db:up
pnpm run debug:prepare
pnpm run debug:server
```

默认后端地址为 `http://localhost:3000`。调试数据库只监听本机 `127.0.0.1:55432`。

```bash
pnpm test
pnpm run debug:db:status
```

## 生产部署

仓库提供 Docker Compose、Caddy 和生产环境初始化脚本。推荐只向公网暴露 HTTPS 网关，PostgreSQL 保持在内部网络。

```bash
pnpm run deploy:init
pnpm run deploy:check
docker compose --env-file deploy/.env.production up -d --build
```

服务就绪后打开前端 `/setup`。向导会检查关键环境、验证一次性初始化密钥，并在同一事务中创建首位管理员、学校和启用学期。随后可以继续预检并导入行政班/走班结构、创建首批教师及其任课空间、建立班级大屏账号，也可以跳过任意可选步骤，稍后在学校后台补充。安装中途关闭页面后，重新输入初始化密钥即可从现有数据继续。

首次部署前应配置强随机密钥、生产域名和一次性管理员初始化密钥。`BOOTSTRAP_SETUP_KEY` 只用于换取15分钟的初始化会话和 OWNER 恢复，不是日常登录密码。不要把 `.env`、OAuth Client Secret、JWT 密钥或数据库密码提交到仓库。

部署容器会在服务启动前执行 Prisma migrations。更多阶段设计和联调说明见 [`docs`](./docs)。

## 备份、恢复与升级

生产脚本统一读取 `deploy/.env.production`，备份默认写入不纳入 Git 的 `deploy/backups`。每日备份默认保留14天，可通过 `BACKUP_RETENTION_DAYS` 调整。

```bash
# 手动备份；输出最终 .dump 路径，并同时生成 SHA-256 与元数据
bash deploy/backup.sh

# 安装每天 03:30 执行的 systemd 计时器
sudo bash deploy/install-backup-timer.sh

# 恢复前会再备份一次当前数据库；--yes 用于确认替换数据
bash deploy/restore.sh deploy/backups/npclassworks_xxx.dump --yes
```

升级脚本要求前后端仓库同级放置且工作区干净。它会先备份数据库、保留当前前后端镜像，再构建和启动新版本。传入相同 Git 标签时，两个仓库都会切换到该标签；不传标签则部署当前已检出的代码。

```bash
bash deploy/upgrade.sh v1.0.1

# 仅回退前后端代码与镜像，不改变升级后的数据库
bash deploy/rollback.sh

# 同时恢复升级前数据库；会替换当前数据库，必须显式确认
bash deploy/rollback.sh --restore-database --yes
```

数据库迁移不保证向下兼容。如果升级包含破坏性迁移，应使用带数据库恢复的完整回滚。定时器状态和日志可用 `systemctl status npclassworks-backup.timer`、`journalctl -u npclassworks-backup.service` 查看。

## 健康检查

- `GET /check`：进程存活检查
- `GET /ready`：数据库就绪检查
- `GET /metrics`：Prometheus 指标；生产环境应配置访问令牌

## 项目关系与致谢

NPClassworksKV 是 Classworks 生态的衍生后端，不是 Classworks 官方服务。感谢上游作者和贡献者；本项目保留相关版权与许可证声明。

项目维护与部署支持：**星火动力（NOVARK POWER）**。

品牌素材位于 [`images`](./images)；反色版本用于深色背景，请勿改变图形比例。

## 开源协议

本项目遵循 [GNU AGPL-3.0](./LICENSE)。
