# Git 推送后自动部署（无 SSH 凭据）

当前安全候选改动已停用工作区 Node 部署代理与旧备份 timer 安装器。
以下 Node 安装章节仅保留为历史参考，不应再执行。新部署入口要求 NPEssentials
独立受保护执行器；其完整依赖闭包及 Linux 验收尚未完成，当前不要直接更新生产。
未配置执行器时，新 Go 代理拒绝部署请求，但原生异地备份仍可运行。

GitHub Actions 不需要服务器 SSH 密码或私钥。服务器所有者在主机上运行一个很小的 Node.js 部署代理；GitHub 测试通过后，向代理发送带时间戳、随机数和 HMAC-SHA256 签名的升级请求。

部署代理只允许执行仓库中固定的 `deploy/ci-deploy.sh`，请求不能指定命令、目录、分支或 Git 引用。原有的升级前备份、双仓库拉取、Docker 重建、健康检查和失败回滚仍由现有脚本负责。

## 安全边界

- GitHub 只持有部署代理地址和一份独立随机密钥，不持有服务器登录凭据。
- 代理默认只监听 `127.0.0.1:19090`，必须由服务器现有 HTTPS 网关反向代理。
- 签名覆盖原始请求正文，时间戳有效期为5分钟，nonce 在10分钟内不可重放。
- 请求接受 `action=upgrade`、合法触发仓库和运行元数据，以及契约/全链路检查实际使用的 `backendCommit`、`frontendCommit` 两个完整 SHA。HMAC 覆盖整个提交对；代理将它们作为独立参数传给 CI 入口，入口不再重新选择 main。旧请求会返回 400。

- 同一时间只执行一次升级；同时到达的请求最多排队3个。
- 代理应使用独立的低权限部署用户运行。该用户仍需能读取两个仓库并访问 Docker，但不应是 root。

提交对协议必须协同升级：暂停两仓自动部署，等待代理空闲，先更新后端 `ci-deploy.sh`，再更新实际运行的 NPEssentials Go 或旧 Node 代理，最后启用两仓的新工作流。新代理每次检查 `# NP_DEPLOY_PROTOCOL=2` 兼容标记，回滚恢复旧入口时返回 `DEPLOY_PROTOCOL_UNSUPPORTED`。手动 `upgrade.sh` 仍支持标签/明确引用。协议与迁移细节见 NPEssentials 的 `docs/deploy-agent.md`。工作区脚本、环境与 Compose 的高权限信任边界尚需独立加固及 Linux 验收。

部署密钥不是 NPClassworks 管理员 PIN、`BOOTSTRAP_SETUP_KEY` 或 JWT 密钥，必须单独生成和保管。

## 1. 服务器所有者安装代理

以下操作由服务器所有者完成一次。假设后端位于 `/opt/npclassworks/NPClassworksKV`，运行用户是 `deploy`；路径不同时相应修改。

生成环境文件：

```bash
sudo install -m 600 /opt/npclassworks/NPClassworksKV/deploy/deploy-agent.env.example \
  /etc/npclassworks-deploy-agent.env
sudo sed -i "s#replace_with_at_least_32_random_bytes#$(openssl rand -hex 32)#" \
  /etc/npclassworks-deploy-agent.env
```

将示例 systemd 服务复制出来，并核对其中的 `User`、`Group`、`WorkingDirectory` 和 `ExecStart`：

```bash
sudo cp /opt/npclassworks/NPClassworksKV/deploy/npclassworks-deploy-agent.service.example \
  /etc/systemd/system/npclassworks-deploy-agent.service
sudo nano /etc/systemd/system/npclassworks-deploy-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now npclassworks-deploy-agent
curl http://127.0.0.1:19090/healthz
```

查看日志：

```bash
sudo journalctl -u npclassworks-deploy-agent -f
```

不要让另一个服务覆盖 `/etc/npclassworks-deploy-agent.env`。更新代码不会自动修改这个文件。

## 2. 接入现有 HTTPS 网关

可以使用单独的部署子域名，例如 `deploy-np.example.com`：

```caddyfile
deploy-np.example.com {
    reverse_proxy 127.0.0.1:19090
}
```

公网只开放网关的 `80/443`，不要开放 `19090`。部署 URL 必须使用有效 HTTPS，不能把密钥发送到明文 HTTP 地址。

如果代理放在 Cloudflare 等会限制长请求的平台之后，应关闭该部署子域名的代理，或确认允许最长约30分钟的响应；DNS 仍可指向现有网关。升级在 HTTP 连接意外断开后仍会继续，但 GitHub Actions 会显示失败，需要通过服务器日志确认结果。

## 3. 配置两个 GitHub 仓库

在前端和后端仓库的 `production` Environment 中配置相同的两个 Secret：

| Secret | 内容 |
| --- | --- |
| `DEPLOY_AGENT_URL` | 例如 `https://deploy-np.example.com`，末尾不要加 `/` |
| `DEPLOY_AGENT_SECRET` | `/etc/npclassworks-deploy-agent.env` 中的 `DEPLOY_AGENT_SECRET` |

不再配置 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS` 或 `DEPLOY_BACKEND_DIR`。

建议由服务器所有者把部署密钥通过私密方式单独交付；不要发到群聊、提交记录、Issue、Actions 日志或仓库文件中。

## 4. 首次验证

仅在已有同一份通过 CI 门禁的提交对时，在服务器确认入口可用；下列两个变量
必须填入该 CI 记录的完整 SHA，不能使用当前 main 或自行拼接两次运行的版本：

```bash
cd /opt/npclassworks/NPClassworksKV
bash deploy/ci-deploy.sh "$TESTED_BACKEND_COMMIT" "$TESTED_FRONTEND_COMMIT"
```

然后在 GitHub Actions 手动运行 **Deploy production server**。Action 会先执行测试，再发送升级请求并等待结果。成功后，前端或后端的 `main` 有新推送都会触发一次完整升级。

需要验证整条自动部署链路而又不想改变程序功能时，可以只修改本页说明并推送一次；仍应完整观察测试、签名请求、服务器升级和健康检查结果。

如果返回：

- `DEPLOY_PROTOCOL_UNSUPPORTED`：CI 入口是旧协议或无法读取，需完成协同更新；不要绕过门禁；

- `DEPLOY_SIGNATURE_INVALID`：两边密钥不一致，或者请求被修改；
- `DEPLOY_TIMESTAMP_INVALID`：服务器时间不准，检查 NTP；
- `DEPLOY_QUEUE_FULL`：短时间内推送过多，等待当前任务完成；
- `DEPLOY_FAILED`：查看响应末尾日志和 systemd journal；
- HTTP 502/504：检查共享网关超时设置以及部署代理是否运行。

生产仓库存在未提交修改时，原升级脚本仍会安全退出，不会覆盖这些文件。
