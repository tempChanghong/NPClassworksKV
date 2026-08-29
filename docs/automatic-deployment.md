# Git 推送后自动部署

`restart: unless-stopped` 只会重启已经存在的容器，不会拉取 Git 提交或重建镜像。仓库现在通过 GitHub Actions 使用 SSH 调用服务器上的 `deploy/ci-deploy.sh`：

1. 推送 `main`；
2. GitHub Actions 先运行测试（前端还会运行生产构建）；
3. SSH 登录部署服务器；
4. 分别获取前后端仓库的 `origin/main`；
5. 升级前备份数据库并保留上一组镜像；
6. 重建并替换前后端容器；
7. 后端健康检查失败时自动恢复上一组应用镜像。

服务器端升级使用文件锁，同一时间只允许一个任务执行。前后端仓库必须同级放置，工作区必须干净，且部署用户需要能够读取两个 Git 仓库并运行 Docker。

## GitHub 配置

在**前端和后端两个 GitHub 仓库**的 `production` Environment 中分别配置相同内容：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `DEPLOY_HOST` | 服务器地址 |
| Secret | `DEPLOY_PORT` | SSH 端口；留空时使用 22 |
| Secret | `DEPLOY_USER` | 建议使用独立的低权限部署账号 |
| Secret | `DEPLOY_SSH_KEY` | 对应部署账号的 SSH 私钥 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 已人工核对指纹的服务器 known_hosts 行 |
| Variable | `DEPLOY_BACKEND_DIR` | 服务器上 NPClassworksKV 仓库的绝对路径 |

不要在 Actions 中临时使用不经核对的 `ssh-keyscan` 结果，也不要把私钥、生产 `.env` 或数据库密码提交到仓库。部署账号只需具备仓库读取、部署目录写入和 Docker 操作权限，不应使用 root。

首次配置后，先在 Actions 页面手动运行一次 **Deploy production server**。成功后，前后端任一仓库推送到 `main` 都会部署两个仓库当前的 `origin/main`。

手动执行同一流程：

```bash
cd /服务器上的/NPClassworksKV
bash deploy/ci-deploy.sh
```

若服务器仓库存在未提交修改，自动部署会安全退出而不会覆盖；应先检查并处理这些修改。
