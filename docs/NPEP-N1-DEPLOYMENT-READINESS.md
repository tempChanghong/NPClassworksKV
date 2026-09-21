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
4. **开关与目录**：两个生产 Compose 已接入默认 `NPEP_ENABLED=false`，固定容器路径 `/var/lib/npclassworks-npep/deployment.json`，以独立持久化命名卷 `npep-config` 挂载整个目录。实际卷名带 Compose 项目前缀；必须保持项目名稳定。初始配置保持 `enabled: false`。该卷不属于数据库备份，不得随数据库一起回滚；不得使用 `down --volumes` 清除生产卷。若现场改用 bind mount，须保持整目录挂载并单独核验 node 权限。
5. **权限与激活**：Docker 使用 `USER node`，该用户需能读取配置、在目录内创建临时文件和原子替换；不能仅验证宿主机 root 可写。生成稳定 `serverInstanceId` 和首次 `deploymentEpoch` 后，审核执行 `scripts/npep-deployment.js activate --invalidate-all-old-devices` 的条件；该操作会废止旧授权并同步数据库代际，不是普通重启命令。普通重启/更新不能重新生成身份或自动打开旧配置。
6. **恢复保护**：`deploy/restore.sh` 无条件调用正在运行容器内的 `npep-config.js prepare-restore <宿主开关>`，比较宿主与容器开关，核验配置及目录原子写权限。开关不一致、旧镜像缺命令或权限不足均在 stop/dropdb 前失败。即使双方均为 false，只要存在历史配置，仍关闭并轮换 epoch；只有双方关闭且没有配置才跳过轮换。`rollback.sh --restore-database` 仍先通过运行中的容器完成此检查，不能用旧镜像缺少功能作为绕过理由。所有恢复入口均须遵循此流程；恢复后保持关闭，审核后显式激活。
7. **配对额度**：创建申请按 socket 对端地址限流（每分钟 5 次、每小时 30 次）。反代后可能共享同一额度；当前代码不读取任意转发 IP，单改 `TRUST_PROXY` 不会改变此路径。正式批量配对前核定受信代理与学校规模，不能直接取消限流。

## 审核后的上线顺序与验收

- 先准备明确版本的 CI 结果、迁移审阅、目录挂载/权限与恢复流程。前端 contracts 和后端 production fullstack 现均额外要求 `pnpm test:e2e:npep`；专用 runner 强制启用隔离 NPEP、检查两端代码存在并核验 JSON 报告，空结果、跳过、失败及重试后通过均不能过门槛。版本记录保存在 `test-results/npep-metadata/versions.json`。生产功能开关保持关闭不影响测试门槛。
- 经单独发布审核后才合入并推送 main；先验证镜像、迁移和关闭状态，最后显式激活 NPEP。关闭状态的 N1 服务应返回协议错误信封；普通 `/ready` 成功不能证明 NPEP 可用。
- 激活后先只读检查 API origin 的 info 信封、版本、请求 ID 和实例信息，再由现场人员使用指定测试绑定验收申请、网页批准、设备确认、上报、撤销及旧凭据拒绝。
- 另外验收真实大屏的断网/重连、休眠、进程重启与恢复运维。当前开发电脑不是班级大屏，本地回归不能替代现场结果。

## 首次启用操作准备（尚未在线上执行）

沿用现场同一个 Compose 项目、生产 env 文件和对应 shared/standalone 文件。以下是命令的子命令示意，不应绕过现有项目配置直接执行裸 Compose：

1. `NPEP_ENABLED=false` 发布配套镜像，确认迁移及普通业务就绪；此时目录可以为空，不自动创建身份。
2. 在后端容器执行 `node scripts/npep-config.js init`，以 node 用户创建关闭的配置，已有文件会拒绝覆盖。`check` 探测同目录创建、重命名及删除临时文件，不改变身份。
3. 将宿主生产配置改为 `NPEP_ENABLED=true` 并重新创建后端容器；配置仍关闭，NPEP 不可配对。镜像启动会先检查文件格式/目录权限，之后才迁移和运行服务。
4. 审核后执行 `node scripts/npep-deployment.js activate --invalidate-all-old-devices`，同步数据库代际并打开入口，再按上文执行只读与现场验收。不要将激活加入自动部署脚本。

初次两仓库上线不可假定原子发生：一端先合 main、另一端 main 尚无配套 N1 时，检查会阻断部署，这是预期保护。先通过前端现有 **contracts.yml** 的手动入口，选包含新工作流的功能分支，传 `frontend_ref` 和 `backend_ref` 两个完整提交 SHA，进行仅测试预验收；该工作流不调用部署代理。之后按审核的成对发布计划合入，待两端 main 就绪再对正确版本重跑失败检查。现有自动部署拉取 main 的机制未改动，不能把测试配对记录当作代理已部署该精确组合的证明。

后端 CI verify 还运行 `pnpm test:deployment:npep`：构建实际 Dockerfile，以独立命名测试卷验证 node 用户、默认关闭、缺配置、不可写/只读目录、重初始化拒绝及开关不一致。只清理本次随机命名的测试镜像和卷。真实 PG 恢复测试验证开关不一致时原数据保持、两种部署模式正常恢复。

当前结论：本地 Docker 与 CI 接入已完成，生产尚未发布，现场配置和实机验收仍待完成。没有进行线上配对、激活或数据库写入。

## 本轮本地验证

- 前端单元测试 513/513、完整 lint 通过；N1 真实浏览器 + 隔离 PostgreSQL 1/1，运行报告零跳过、零 flaky，账号会话前置数据库测试 1/1。
- 后端普通测试 187 通过、17 个数据库入口按默认环境跳过；显式完整 PostgreSQL 回归 113/113、零跳过，包括实际激活、pg_dump/pg_restore，以及新增恢复开关不一致时保留原数据库。
- `pnpm test:deployment:npep` 通过：实际生产 Dockerfile 构建、两套 Compose 的关闭/开启配置解析、非 root 用户初始化及原子写、持久化身份、恢复轮换、只读/不可写拒绝。负例要求精确退出码 1，避免把 Docker 启动错误误判为保护生效。
- 旧恢复 CLI 的显式宿主开关校验和关闭状态下历史代际轮换测试通过。首次回归发现激活函数缺导入，修正后完整数据库回归通过。

这些是本地功能分支结果；GitHub 托管 runner 和真实生产配置尚未运行验收。专用测试项目使用独立端口并已清理，不操作既有数据库和其他 Docker 服务。

## 后续托管回归：备份同秒撞名修复

最终图标组合的 KV quality `35608552240` 在真实 shared 恢复测试失败：一次被 NPEP 配置检查拒绝的恢复已经创建 `pre-restore` 备份，紧接着正常恢复在同一秒再次使用该标签。原文件名只有秒级时间与标签，因此拒绝同名；这是实际连续操作也可触发的备份命名限制，不是通过 sleep 或重跑解决的测试问题。

`backup.sh` 现用同目录 `mktemp` 原子分配带随机后缀的临时文件，校验后用不覆盖目标的原子硬链接发布 `.dump`，再删除临时名。保留时间、标签、校验文件、元数据及原保留期匹配；旧备份仍可恢复。备份目录必须支持同目录硬链接（通常的 Linux 本地文件系统支持）；不支持时明确失败，不回退到可覆盖的移动操作。

真实恢复测试固定 Bash 时钟，使全部嵌套 `pre-restore` 都处于同一秒；两种部署模式验证相同标签生成不同文件、原 dump/校验不变，以及恢复和权限拒绝流程。本地 D 盘 Docker bind mount 失败时使用 C 盘隔离副本运行，两个修改文件哈希与工作区一致，未重启 Docker/WSL 或操作其他容器。该修复的新提交仍需重新获得托管 CI 结果。

本次验证：部署配置检查 15/15，固定时钟的 standalone/shared 实际备份恢复及父测试通过，原子发布目标冲突检查保留原文件。完整 PG 113 项中 111 通过、2 失败（另一个 NPEP 维护用例及父测试）；不能报告全套通过。该用例使用宿主 `Date.now()-1000` 制造过期，而清理使用数据库时钟；只读测量显示 Docker 时钟落后宿主超过一秒，另行处理此夹具时钟来源问题，备份修复不修改维护逻辑。

随后独立修正维护测试的时间来源：使用 PostgreSQL `clock_timestamp()-interval` 设置过期夹具，并明确断言在数据库看来已过期；原摘要清空、当前设备可用及过期记录删除断言均保留，生产维护实现不变。最终在 C 盘相同代码的隔离环境重跑完整 PostgreSQL 回归 **113/113 通过、零跳过**，专用项目已清理。未加 sleep、重试或降低断言。最终提交仍待托管复核。
