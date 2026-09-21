# NPEP N1 分离部署准备记录

日期：2026-09-21。本文记录上线前条件，不是部署完成报告。NPEP 代码仍在功能分支，`main` 才触发现有部署代理自动发布；**未来合入并推送 main 是生产发布动作**，应先审核迁移、外部代际配置与启用顺序。本轮不合并、不推送、不调用部署代理，不修改 `deploy/agent/server.js`，不接触线上秘密。

## 已知线上状态

用户确认使用 Docker 分离部署：网页 `https://newfires.top`，API `https://api.newfires.top`。

以下结果由 NPEduTools 协作任务提供，本任务未重复请求线上：使用正常系统 TLS 校验、禁止跟随重定向，仅 GET `/api/v2/npep/info`，携带 `X-NPEP-Version: 0.1` 和 UUID `X-Request-Id`。

| Origin | 观测 |
| --- | --- |
| `https://newfires.top` | TLS 校验通过，HTTP 200、`text/html`，不是 NPEP API 信封 |
| `https://api.newfires.top` | TLS 校验通过，HTTP 404、`application/json`，无 NPEP 信封 |

在功能尚未合入 main 的背景下，API 404 属于预期的未上线状态，**不标为部署故障**。这些响应不能用于正式配对，也不能单凭响应推断运行镜像版本或反代具体配置。网页 HTML 成功响应不代表 API 就绪。将来 NPEduTools 应使用 API origin（不附加 `/api/v2/npep` 路径），而不是网页 origin。

## 本地代码核查与启用条件

1. **版本与迁移**：后端镜像必须包含 N1 路由、Prisma 模型及 `20260920120000_npep_n1` 迁移；前端必须包含 N1 管理界面。现有 Docker 启动命令先执行 `prisma migrate deploy`，不等于迁移已在线上执行。记录待发布的前后端不可变提交及构建结果，再审核发布。
2. **反代**：`app.js` 挂载路径为 `/api/v2/npep`。共享部署的 Caddy/Nginx 示例把 API 域名代理到后端，保留完整路径；无需把 NPEP 转发到前端。实际网关尚未验收；必须保留 Authorization、协议与请求 ID 头，API 路径不能落入 SPA fallback，不能依赖跨 origin 跳转。
3. **分离域名配置**：前端构建的 `VITE_DEFAULT_KV_SERVER` 应为 `https://api.newfires.top`；后端 `FRONTEND_URL`、`CORS_ALLOWED_ORIGINS` 应允许 `https://newfires.top`，`BASE_URL` 对应 API origin。仓库模板有 `cs.newfires.top` 默认值，必须以审核后的现场配置为准，不代表现场配置错误。原生客户端不受浏览器 CORS 控制，网页管理员仍需验收跨域请求。
4. **开关与目录**：当前两个生产 Compose 文件都未传入 `NPEP_ENABLED`、`NPEP_DEPLOYMENT_FILE`，也未挂载外部代际目录。只向宿主机 env 文件加入变量不会自动传入容器。未来需显式接入这些环境变量及独立持久化目录，初始配置保持 `enabled: false`。挂载整个目录而非单文件，因为脚本采用原子重命名；目录不属于数据库卷或历史数据库备份。
5. **权限与激活**：Docker 使用 `USER node`，该用户需能读取配置、在目录内创建临时文件和原子替换；不能仅验证宿主机 root 可写。生成稳定 `serverInstanceId` 和首次 `deploymentEpoch` 后，审核执行 `scripts/npep-deployment.js activate --invalidate-all-old-devices` 的条件；该操作会废止旧授权并同步数据库代际，不是普通重启命令。普通重启/更新不能重新生成身份或自动打开旧配置。
6. **恢复保护**：`deploy/restore.sh` 仅在宿主机加载的 `NPEP_ENABLED=true` 时调用容器内 `prepare-restore`，容器内该变量不是 true 时也会直接跳过。因此宿主机恢复环境与容器开关、目录必须一致，并且所有恢复入口都须在还原数据库前关闭入口、轮换外部 epoch；恢复后保持关闭，审核后显式激活。不能把旧外部配置随数据库一起回滚。
7. **配对额度**：创建申请按 socket 对端地址限流（每分钟 5 次、每小时 30 次）。反代后可能共享同一额度；当前代码不读取任意转发 IP，单改 `TRUST_PROXY` 不会改变此路径。正式批量配对前核定受信代理与学校规模，不能直接取消限流。

## 审核后的上线顺序与验收

- 先准备明确版本的 CI 结果、迁移审阅、目录挂载/权限与恢复流程；确认实际自动部署会使用这些配置。现有通用 fullstack 默认跳过 N1，不能当作 N1 已通过：专项需显式 `FULLSTACK_NPEP=true` 运行前端 `tests/fullstack/npep.spec.js` 并记录实际执行结果。
- 经单独发布审核后才合入并推送 main；先验证镜像、迁移和关闭状态，最后显式激活 NPEP。关闭状态的 N1 服务应返回协议错误信封；普通 `/ready` 成功不能证明 NPEP 可用。
- 激活后先只读检查 API origin 的 info 信封、版本、请求 ID 和实例信息，再由现场人员使用指定测试绑定验收申请、网页批准、设备确认、上报、撤销及旧凭据拒绝。
- 另外验收真实大屏的断网/重连、休眠、进程重启与恢复运维。当前开发电脑不是班级大屏，本地回归不能替代现场结果。

当前结论：本地 N1 实现和隔离验收已有记录；生产尚未发布、Compose 运维接入及现场验收仍待完成。没有进行线上配对、激活或数据库写入。
