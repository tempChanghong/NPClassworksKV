# NPClassworks 从零部署教程（新手版）

本文面向“会复制命令、懂一点域名和 Linux，但没有独立部署过完整网站”的维护者。主线方案是一台全新的境外 Ubuntu 云服务器，前端、后端、PostgreSQL 和 HTTPS 网关全部运行在同一台机器上。

示例域名使用 `cs.newfires.top`。换用其他域名时，请把全文中的它一起替换。

> 本教程对应当前的 NPClassworks 与 NPClassworksKV 仓库。不要混用 Classworks 1 的部署文档、`kv.houlang.cloud` 或旧 UUID 后端。

## 0. 最终会得到什么

```text
学生 / 教师 / 班级大屏
          │
          ▼
https://cs.newfires.top
          │
     Caddy（自动 HTTPS）
       ┌──┴──────────┐
       ▼             ▼
   Vue 前端      Node.js 后端
                       │
                       ▼
                  PostgreSQL
```

这套“同源部署”只需要一个域名：

- 网页和 API 都使用 `https://cs.newfires.top`；
- 浏览器不会遇到跨域配置问题；
- PostgreSQL 不开放公网端口；
- 内置 Caddy 占用服务器的 `80/443` 端口，并自动申请和续期 HTTPS 证书。

如果服务器已经有 Nginx、Caddy、1Panel、宝塔或其他网站占用了 `80/443`，不要照主线直接启动；请看文末“共享服务器部署”。

## 1. 购买服务器

### 1.1 推荐配置

| 用途 | CPU | 内存 | 系统盘 | 公网带宽 | 建议 |
| --- | ---: | ---: | ---: | ---: | --- |
| 临时测试 | 2 核 | 2 GB | 30 GB SSD | 5 Mbps | 能运行，但构建时容易内存紧张，不建议正式使用 |
| 学校正式使用 | **2 核** | **4 GB** | **50 GB NVMe/SSD** | **10–20 Mbps** | 性价比与余量较平衡，建议至少加 2 GB swap |
| 共享宿主机或希望升级更快 | 4 核 | 8 GB | 80–100 GB NVMe/SSD | 20 Mbps 以上 | 同机还有其他服务、日志或备份较多时更稳妥 |

其他选择：

- 系统：`Ubuntu Server 24.04 LTS 64 位`；
- 架构：优先 `x86_64 / AMD64`；
- 地区：天津校园访问通常先比较香港、东京、大阪、新加坡；线路质量比直线距离更重要，购买前使用商家的测试 IP 或 Looking Glass 实测延迟与丢包；
- 公网 IP：必须有一个可用的公网 IPv4；
- GPU：完全不需要；
- 流量：作业和通知以文本为主，通常不是瓶颈，但仍要查看商家的公平使用和超额计费规则；
- 快照：建议选择支持手动快照的服务商；
- 不选择中国大陆地域。本教程不处理 ICP 备案流程；服务商、域名注册商及 CDN 仍可能有各自的实名或合规要求。

Ubuntu 官方列出的 24.04 LTS 标准安全维护期到 2029 年 5 月，适合作为当前部署基线：<https://ubuntu.com/about/release-cycle>。

### 1.2 下单时记下这些信息

- 服务器公网 IPv4，例如 `203.0.113.10`；
- SSH 用户名，常见为 `root` 或 `ubuntu`；
- SSH 端口，默认 `22`；
- SSH 私钥文件或初始密码；
- 云厂商控制台中的“安全组/防火墙”入口。

### 1.3 放行端口

在云厂商安全组中设置：

| 协议 | 端口 | 来源 | 用途 |
| --- | ---: | --- | --- |
| TCP | 22 | 最好仅管理员固定 IP；没有固定 IP 时可暂时开放 | SSH 管理 |
| TCP | 80 | `0.0.0.0/0` | HTTP 跳转和证书签发 |
| TCP | 443 | `0.0.0.0/0` | HTTPS |
| UDP | 443 | `0.0.0.0/0`，可选 | HTTP/3 |

不要开放 `5432`。它是数据库端口，当前 Compose 已将数据库限制在 Docker 内部网络。

## 2. 配置域名

进入 `newfires.top` 的 DNS 管理页面，新建：

| 主机记录 | 类型 | 值 | 代理/CDN |
| --- | --- | --- | --- |
| `cs` | `A` | 服务器公网 IPv4 | 首次部署先关闭，仅做 DNS 解析 |

最终 `cs.newfires.top` 应解析到服务器 IP。可在 Windows PowerShell 检查：

```powershell
Resolve-DnsName cs.newfires.top
```

如果没有可用 IPv6，不要添加 `AAAA` 记录；错误的 IPv6 记录可能导致部分设备访问失败。

先完成 DNS，再启动 Caddy。Caddy 自动签发证书要求域名正确指向服务器，并且公网能访问 `80/443`：<https://caddyserver.com/docs/automatic-https>。

## 3. 第一次登录服务器

在 Windows PowerShell 中执行：

```powershell
ssh root@服务器公网IP
```

如果云厂商给的是 `ubuntu` 用户：

```powershell
ssh ubuntu@服务器公网IP
```

第一次连接会询问是否信任主机指纹。先与云厂商控制台显示的指纹核对，再输入 `yes`。不要在未核对时盲目信任发生变化的指纹。

若只能使用 root，建议创建日常部署账号：

```bash
adduser deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

保留当前 root 窗口，再打开一个新 PowerShell 测试：

```powershell
ssh deploy@服务器公网IP
```

只有新账号确实能登录并能执行 `sudo` 后，才考虑在 SSH 配置中关闭 root 或密码登录。不要先关掉唯一可用的登录方式。

后续命令假定使用 `deploy` 或 `ubuntu` 这类可执行 `sudo` 的普通账号。

## 4. 初始化 Ubuntu

更新系统并安装基础工具：

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git openssl ufw
sudo timedatectl set-timezone Asia/Shanghai
```

启用系统防火墙前，先确保 SSH 已放行：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status
```

如果 SSH 不是默认的 22 端口，应先放行实际端口（例如 `sudo ufw allow 2222/tcp`），再启用 UFW，否则可能把自己锁在服务器外。

> Docker 发布端口与 UFW 的交互有特殊之处，所以云厂商安全组仍是第一道边界。当前项目只向公网发布 `80/443`，不会发布 PostgreSQL。

### 4.1 为 4 GB 机器增加 swap

先查看是否已有 swap：

```bash
swapon --show
free -h
```

如果没有输出，再创建 2 GB swap，降低首次构建时因内存峰值被系统杀死的概率：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

不要重复向 `/etc/fstab` 添加同一行。

## 5. 安装 Docker Engine 与 Compose

以下使用 Docker 官方 apt 仓库，而不是来历不明的一键脚本。官方当前安装说明见：<https://docs.docker.com/engine/install/ubuntu/>。

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

允许当前部署账号运行 Docker：

```bash
sudo usermod -aG docker "$USER"
exit
```

重新 SSH 登录后检查：

```bash
docker version
docker compose version
```

能看到 Client、Server 和 Compose 版本才继续。`docker` 组实际上具有很高的系统权限，只给受信任的运维账号加入。

## 6. 下载前后端代码

两个仓库必须处于同一个父目录，并保持以下名称，否则 Compose 找不到前端：

```text
/opt/npclassworks/
├── NPClassworks/       # 前端
└── NPClassworksKV/     # 后端与部署文件
```

创建目录并克隆：

```bash
sudo mkdir -p /opt/npclassworks
sudo chown "$USER":"$USER" /opt/npclassworks
cd /opt/npclassworks
git clone https://github.com/tempChanghong/NPClassworks.git
git clone https://github.com/tempChanghong/NPClassworksKV.git
```

检查：

```bash
test -f /opt/npclassworks/NPClassworks/Dockerfile && echo '前端存在'
test -f /opt/npclassworks/NPClassworksKV/docker-compose.yml && echo '后端存在'
```

## 7. 生成生产环境配置

进入后端仓库：

```bash
cd /opt/npclassworks/NPClassworksKV
```

项目提供的初始化脚本会生成五组不同的强随机密钥。下面借用一次性 Node 容器运行脚本，不需要在宿主机额外安装 Node.js：

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" -w /app \
  node:22-alpine node scripts/init-production-env.js
```

如果提示“拒绝覆盖已有文件”，说明 `deploy/.env.production` 已存在。不要删除生产环境的旧文件；先确认这是初装遗留还是正在使用的真实配置。

编辑配置：

```bash
nano deploy/.env.production
```

至少把这些行改成：

```dotenv
CLASSWORKS_DOMAIN=cs.newfires.top
DEPLOY_MODE=standalone
VITE_DEFAULT_KV_SERVER=https://cs.newfires.top
CLASSWORKS_API_DOMAIN=cs.newfires.top
CORS_ALLOWED_ORIGINS=https://cs.newfires.top
```

其他注意事项：

- 保留脚本生成的 `POSTGRES_PASSWORD`、`JWT_SECRET`、`REFRESH_TOKEN_SECRET`、`METRICS_TOKEN` 和 `BOOTSTRAP_SETUP_KEY`；
- 五个值不要改成相同内容；
- 不使用 OAuth 时，OAuth 的 Client ID/Secret 留空即可；
- `ALLOW_OAUTH_BOOTSTRAP=false` 保持不变；
- `.env.production` 绝不能提交到 Git 或发到群聊。

在 nano 中按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。

检查权限、占位符和 Compose 语法：

```bash
chmod 600 deploy/.env.production
if grep -q 'replace_with_' deploy/.env.production; then echo '错误：仍有占位符'; else echo '密钥已生成'; fi
docker compose --env-file deploy/.env.production config --quiet
```

最后一条没有输出且退出码为 0，表示 Compose 配置能被解析。

## 8. 确认 80/443 没被占用

```bash
sudo ss -ltnp | grep -E ':(80|443)\b' || echo '80/443 当前空闲'
```

如果能看到 Nginx、Caddy、Apache、1Panel 或其他程序，先不要停止陌生服务，也不要继续主线部署。改用文末的“共享服务器部署”，或让该服务器的维护者统一配置反向代理。

## 9. 首次构建并启动

```bash
cd /opt/npclassworks/NPClassworksKV
docker compose --env-file deploy/.env.production up -d --build
```

第一次会下载 Node、PostgreSQL、Nginx、Caddy 镜像并构建前端，耗时取决于服务器和国际网络，数分钟没有新画面不等于失败。不要反复按 `Ctrl+C` 或同时启动第二份构建。

查看状态：

```bash
docker compose --env-file deploy/.env.production ps
```

正常时 `postgres`、`backend`、`frontend`、`caddy` 均为运行状态，带健康检查的服务最终应显示 `healthy`。

如果某个服务异常：

```bash
docker compose --env-file deploy/.env.production logs --tail=150 postgres backend frontend caddy
```

## 10. 从公网验收

在服务器执行：

```bash
curl -fsS https://cs.newfires.top/ready && echo
curl -I https://cs.newfires.top/
```

然后用一台不在服务器上的电脑或手机访问：

```text
https://cs.newfires.top/
https://cs.newfires.top/setup
```

不要只在服务器本机测试。手机可暂时关闭 Wi-Fi，用移动网络验证公网、DNS 和证书链。

若 HTTPS 证书没有签发，依次检查：

1. `cs.newfires.top` 的 A 记录是否真的是这台服务器；
2. 是否存在错误 AAAA 记录；
3. 云安全组和 UFW 是否允许 TCP `80/443`；
4. 是否有其他服务占用端口；
5. `docker compose ... logs caddy` 中的具体错误。

## 11. 完成 OOBE

查看一次性初始化密钥：

```bash
sed -n 's/^BOOTSTRAP_SETUP_KEY=//p' deploy/.env.production
```

不要截图或转发该值。在 `/setup` 页面中：

1. 完成服务检查并输入 `BOOTSTRAP_SETUP_KEY`；
2. 创建首位 OWNER 管理员账号；
3. 设置学校名称、代号和当前学期；
4. 保存一次性账号交付信息；
5. 执行“上线前登录测试”；
6. 按真实情况可视化创建年级、行政班、走班教学班和教师关系；
7. 创建并绑定班级大屏账号。

`BOOTSTRAP_SETUP_KEY` 不是教师或管理员的日常密码。完成 OOBE 后仍要把生产环境文件安全保存，因为它也用于受控的 OWNER 恢复流程。

初装时不要急着导入不确定的分班数据。学校名称和学期已经在 OOBE 中建立；组织 JSON 是可选的批量导入工具，不是进入管理后台的必填项。

## 12. 上线后的必要设置

### 12.1 安装每日数据库备份

```bash
cd /opt/npclassworks/NPClassworksKV
bash deploy/backup.sh --label first-production
sudo bash deploy/install-backup-timer.sh
systemctl list-timers npclassworks-backup.timer --no-pager
```

默认每天约 03:30 备份，保留 14 天。查看结果：

```bash
ls -lh deploy/backups
sudo journalctl -u npclassworks-backup.service --no-pager -n 100
```

本机备份不能防止整块云盘损坏或账号被盗。至少定期把 `.dump`、对应 `.sha256` 和 `.meta` 复制到另一台机器或对象存储，并定期做恢复演练。

### 12.2 做一次云服务器快照

确认 OOBE、登录、发布作业和大屏显示均正常后，在云厂商控制台创建手动快照，名称可写：

```text
npclassworks-v1.0.0-initial-可用日期
```

数据库备份用于恢复业务数据，云盘快照用于恢复整机；两者不能互相完全替代。

### 12.3 手动升级

收到代码更新后，在服务器执行：

```bash
cd /opt/npclassworks/NPClassworksKV
bash deploy/ci-deploy.sh
```

该脚本会获取两个仓库的 `origin/main`、升级前备份数据库、重建容器、检查后端健康，并在健康检查失败时恢复上一组应用镜像。

升级前应确认：

```bash
git status --short
git -C ../NPClassworks status --short
```

两个仓库都应没有未提交修改。不要在生产服务器上直接编辑源代码。

### 12.4 可选：Git 推送后自动部署

先保证手动升级成功，再配置 GitHub Actions。完整项目约束见 [Git 推送后自动部署](./automatic-deployment.md)。

在管理员的 Windows PowerShell 中生成一把只用于部署的密钥：

```powershell
ssh-keygen -t ed25519 -C "npclassworks-github-actions" -f "$env:USERPROFILE\.ssh\npclassworks_actions"
Get-Content "$env:USERPROFILE\.ssh\npclassworks_actions.pub" | ssh deploy@服务器公网IP "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

测试私钥能否登录：

```powershell
ssh -i "$env:USERPROFILE\.ssh\npclassworks_actions" deploy@服务器公网IP
```

然后在**前端和后端两个 GitHub 仓库**的 `Settings → Environments → New environment` 中创建 `production` Environment，并配置：

- `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`；
- `DEPLOY_SSH_KEY`：`npclassworks_actions` 私钥文件的完整内容，不是 `.pub`；
- `DEPLOY_KNOWN_HOSTS`：服务器 SSH 主机密钥的 known_hosts 行，必须先与服务器或云控制台显示的指纹人工核对；
- `DEPLOY_BACKEND_DIR=/opt/npclassworks/NPClassworksKV`。

前三项和两个密钥放在 Environment secrets；`DEPLOY_BACKEND_DIR` 放在 Environment variables。私钥不得上传到仓库、网盘公开链接或聊天群。

建议首次在 Actions 页面手动运行并观察全流程，成功后再依赖 push 自动部署。GitHub Environment 可限制部署分支、保存环境 Secret，并可加入人工批准规则：<https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments>。

## 13. 班级大屏验收清单

至少用真实或接近真实的一体机完成一次：

- 打开首页并进入大屏模式；
- 用大屏账号完成绑定，确认不能无 PIN 从普通首页直接绑定；
- 发布一条作业和一条通知，检查实时出现与刷新后仍存在；
- 让页面失去焦点，检查通知声音策略；
- 断网后查看离线状态，再恢复网络验证同步；
- 检查 1080p、2K、4K 下正文大小和触控距离；
- 选择真实麦克风并测试噪音监测；
- 验证教师、学生、管理员三类账号互相不能越权；
- 用手机网络检查学生查看作业；
- 完成一次备份，并确认文件非空。

不要在第一天把所有班级都接入。建议先用一个测试班完成 1–2 天试运行，再逐步创建正式大屏账号。

## 14. 常见故障

### 页面打不开

```bash
docker compose --env-file deploy/.env.production ps
docker compose --env-file deploy/.env.production logs --tail=150 caddy frontend
```

同时检查 DNS、安全组、UFW 和端口占用。

### 页面能开，但提示后端不可用或 OOBE 要求补环境变量

```bash
docker compose --env-file deploy/.env.production logs --tail=200 backend postgres
curl -i https://cs.newfires.top/ready
```

重点检查 `.env.production` 中是否仍有占位符、五组密钥是否不同、数据库是否 healthy。

### 修改了 `.env.production`，页面仍没变化

前端后端地址是在前端构建时写入的。改完后必须重建：

```bash
docker compose --env-file deploy/.env.production up -d --build --force-recreate
```

随后在浏览器强制刷新。PWA 可能短暂保留旧静态资源；不要仅凭普通刷新判断容器没有更新。

### `address already in use` 或 Caddy 启动失败

说明 `80/443` 很可能已被其他网关占用。不要杀掉服务器上的其他网站，改用共享模式。

### 构建时出现 `Killed`、退出码 137

通常是内存不足。确认 swap 已启用；仍失败时升级到 4 核 8 GB，或在资源更充足的构建机上构建镜像。

### 磁盘空间不足

```bash
df -h
docker system df
du -sh deploy/backups
```

先确认哪些内容占空间，再做清理。不要执行 `docker compose down -v`，其中 `-v` 会删除数据库卷。

## 15. 共享服务器部署（已有统一网关）

以下情况使用 `shared`：

- 同一台服务器还有其他网站；
- `80/443` 已由统一 Caddy/Nginx 占用；
- 运维人员明确要求应用只监听回环高位端口。

`shared` 只表示 NPClassworks 不直接占用宿主机的 `80/443`，**不表示前后端必须分域**。统一网关可以在同一个域名下按请求路径分别代理前端和后端。

### 15.1 推荐：共享网关、前后端同源

对于完全由自己控制的新部署，仍推荐只使用 `cs.newfires.top`：

```dotenv
CLASSWORKS_DOMAIN=cs.newfires.top
DEPLOY_MODE=shared
VITE_DEFAULT_KV_SERVER=https://cs.newfires.top
CLASSWORKS_API_DOMAIN=cs.newfires.top
CORS_ALLOWED_ORIGINS=https://cs.newfires.top
SHARED_FRONTEND_PORT=13080
SHARED_BACKEND_PORT=13000
```

启动后，宿主机统一网关在同一站点内按路径分流：

```text
cs.newfires.top 的 /api、/accounts、/socket.io、/check、/ready、/metrics
    -> http://127.0.0.1:13000

cs.newfires.top 的其他请求
    -> http://127.0.0.1:13080
```

Caddy 可直接参考 `deploy/Caddyfile.shared-same-origin.example`。这种方式既不会让 NPClassworks 独占整台服务器的 `80/443`，也不会引入跨域问题。

### 15.2 可选：前端与 API 分域

只有希望独立迁移、限流或扩展 API 时，才需要 `api.newfires.top`：

```dotenv
CLASSWORKS_DOMAIN=cs.newfires.top
DEPLOY_MODE=shared
VITE_DEFAULT_KV_SERVER=https://api.newfires.top
CLASSWORKS_API_DOMAIN=api.newfires.top
CORS_ALLOWED_ORIGINS=https://cs.newfires.top
SHARED_FRONTEND_PORT=13080
SHARED_BACKEND_PORT=13000
```

启动命令改为：

```bash
docker compose --env-file deploy/.env.production \
  -f docker-compose.shared.yml up -d --build
```

此时应用只监听：

- 前端：`127.0.0.1:13080`；
- 后端：`127.0.0.1:13000`；
- PostgreSQL：仍不映射到宿主机。

分域时，由服务器现有网关配置：

```text
cs.newfires.top  -> http://127.0.0.1:13080
api.newfires.top -> http://127.0.0.1:13000
```

可参考仓库中的 `deploy/Caddyfile.shared.example` 或 `deploy/nginx.shared.conf.example`。Socket.IO 也必须被正确反代。共享网关属于整台服务器的公共基础设施，应由服务器维护者合并配置；不要再启动项目自带的 Caddy，也不要让本项目抢占 `80/443`。

## 16. 不要做这些事

- 不要把 `deploy/.env.production`、SSH 私钥或数据库备份提交到 Git；
- 不要把 PostgreSQL 的 `5432` 暴露到公网；
- 不要在不知道含义时执行 `docker compose down -v`；
- 不要用 `git reset --hard` 解决生产服务器的代码冲突；
- 不要把 `BOOTSTRAP_SETUP_KEY` 当成教师通用密码；
- 不要同时运行多次升级；项目升级脚本已有文件锁；
- 不要只做本机备份而从不复制到异地；
- 不要在未验证新 SSH 登录方式前关闭 root/密码登录；
- 不要在正式服务器保留调试环境变量或暴露调试页面。

## 17. 最终上线判定

只有以下项目全部通过，才算部署完成：

- `https://cs.newfires.top` 证书正常且无浏览器警告；
- `/ready` 返回成功；
- 四个容器均稳定运行；
- OOBE 完成，OWNER 登录测试通过；
- 教师、学生、大屏账号各验证一次；
- 作业、通知、实时同步、刷新持久化均通过；
- 大屏断网与恢复同步通过；
- 首份数据库备份已生成并复制到另一位置；
- 云服务器快照已创建；
- 运维人员知道如何查看日志、手动升级和回滚。

到这里，才适合把正式网址和账号交付给学校使用。
