# NPEP N1 首次成对发布审核

日期：2026-09-21。本轮仅阅读代码、查询远端 refs、调用不写文件的版本解析函数。没有修改运行代码、切换分支、合并、推 main、触发部署、SSH、读取生产秘密或启用 NPEP。下列操作顺序是待批准方案，不是已执行记录。

## 结论

代码与固定组合的托管验收已经具备发布准备基础，但**现有自动部署没有把实际部署组合绑定到通过 CI 的那两个 SHA**。默认关闭 NPEP 只限制功能启用，不阻止代码更新和数据库迁移。首次上线应分为“关闭状态发布”和“现场启用”两个审核步骤。

不修改朋友服务器的 `deploy/agent/server.js` 也可以完成首次精确发布：暂停自动部署入口并排空在途任务、冻结两端 main，测试最终 SHA 后由服务器管理员调用现有 `upgrade.sh` 的双 SHA 参数。若希望全自动且无人工冻结，需另行修复发布版本绑定，不能把本轮方案说成现有系统已经保证。

## 当前远端和验收证据

本次 `git ls-remote origin` 读取结果；两个本地工作区开始审阅时均干净。

| 仓库 | main | 已受测功能分支 |
| --- | --- | --- |
| NPClassworks | `19756f654f94006084d1d954b8be4171db7c9a18` | `codex/npep-n1-admin-ui` → `e354bbd172190a8a201120d1da8356abfc9e7a33` |
| NPClassworksKV | `f731f3227a7c59585aff940f78354585d3b016b7` | `codex/npep-n1-server` → `88134b175e7f95055aacdb525b8b10dee1e6bc35` |

上述两个 main 都是对应功能分支的祖先。本报告若单独提交，会产生仅文档的后端新 HEAD；不要把它与受测代码 SHA 混淆。

已由协作任务核验的托管结果：前端 [contracts 35561798752](https://github.com/tempChanghong/NPClassworks/actions/runs/35561798752) 固定上述功能分支 SHA，契约 3/3、通用 fullstack 37 项通过且 N1 默认跳过，随后专用 N1 1/1、零跳过；后端 [quality 35561797164](https://github.com/tempChanghong/NPClassworksKV/actions/runs/35561797164) 普通测试 187 通过、17 数据库入口默认跳过，独立 PG 113/113、Docker 门槛通过。设备最终受测代码为 `0d9719cda0cf7d0c4fd7249bc0530b50ece451ab`，详见设备仓库托管报告。本轮不重复执行这些测试。

## 代码证据与阻塞边界

文件行号基于上表受测提交。`前端/` 表示 NPClassworks，其余均为 NPClassworksKV。

| 事实 | 文件位置 | 对发布的影响 |
| --- | --- | --- |
| 两端 push main 会进入生产工作流；部署依赖测试，但 `environment: production` 本身不证明有人审批准入 | 前端 `.github/workflows/production-deploy.yml:4,57-60`；后端同名文件 `4,98-101` | 必须另行核验实际 GitHub 环境保护、分支规则及在途任务，不能假设存在人工闸门 |
| 前端工作流测试触发版本 + backend main；后端工作流测试 frontend main + 触发后端版本 | 前端 `.github/workflows/contracts.yml:39,44,67`；后端 `.github/workflows/production-deploy.yml:40-58,87-88` | 仅一端包含 N1 时，新门槛应失败；失败阻止该工作流部署，但不阻止其他旧任务或直接代理请求 |
| 请求仅提交一个 commit 元数据；代理没有把它传给脚本 | 前端 `.github/workflows/production-deploy.yml:71-73`；后端同名文件 `110-114`；`deploy/agent/server.js:13,85-96,118,230` | CI 的受测组合没有传递到部署端，不支持简单追加两个字段（字段白名单会拒绝） |
| 固定脚本使用两个 origin/main，在升级锁内 fetch 后解析、检出并记录 | `deploy/ci-deploy.sh:8-12`；`deploy/upgrade.sh:45-59,84-85,102-104` | 固定的是部署时版本；不是此前受测版本。`deployed-release.json` 是事后证据，不是 CI 准入证明 |
| 兼容检查仅比较 epoch，并可选要求祖先提交；当前两端旧/新声明均 epoch=1、无 requiresPeerCommit | `deploy/release-plan.js:26-38`；两端 `deploy/compatibility.json:4` | 只读实测新后端+旧前端、旧后端+新前端均被解析器接受；不能以兼容声明代替 N1 配套和 SHA 验证 |
| 代理队列逐个执行，未对相同请求去重；每次升级重写上一版本记录 | `deploy/agent/server.js:153-175,208-210`；`deploy/upgrade.sh:62-80` | 两端各触发一次可能重复升级，覆盖首次上线前的回滚基线；首次发布只放行一次，单独保留原备份和镜像标记 |
| Compose 默认关闭、独立卷；镜像 node 用户先检查配置再迁移 | `docker-compose.shared.yml:33-34,61-62,79-81`；`Dockerfile:25-33` | 发布代码会自动迁移，功能仍关闭。实际现场是否使用该 Compose/项目名/镜像尚待管理员确认 |
| 当前恢复先核验运行容器并关闭/换代际，再停止并 dropdb | `deploy/restore.sh:53-58`；`scripts/npep-config.js:25-55` | 开关不一致、缺 helper、不可写时拒绝恢复；不能绕过检查追求恢复成功 |

GitHub concurrency 名称相同也不构成两个仓库之间的全局发布锁；服务器 upgrade.lock 可以串行升级，但不会核对 CI 结果。

协作任务于 2026-09-21 只读查询 GitHub API：两仓 production environment 的 `protection_rules=[]`、`deployment_branch_policy=null`；main 均 `protected=false`，`rules/branches/main=[]`，传统 protection endpoint 为 404。**当前没有 production 人工批准关卡，也没有已启用的 main 保护。** 两仓 production-deploy 的 queued/in_progress/waiting/requested/pending 查询均为零，这是当时 GitHub 侧快照，不证明 server.js 内部队列为空。未联系生产代理，也未确认朋友服务器运行的脚本与仓库 main 一致，须在正式发布前由管理员核验。

### 镜像发布也是独立发布入口

后端 `.github/workflows/docker-publish.yml:4-9,77-82` 在 main push、`v*` tag push 和手动触发时都会尝试推镜像；PR 只构建不推。该 job 不依赖 production-deploy/quality，也没有 production environment 审批。目标为 GHCR，配置 Docker Hub 变量和凭据时还会推 Docker Hub（`11-13,35-39,45-58`）；本轮没有读取或判断这些秘密是否实际存在。

按当前 `tags` 与 `latest=auto`（`65-73`）：main push 生成 `main` 与 `sha-<完整SHA>`，**不会仅因 main 是默认分支就生成 latest**；正式 SemVer `v*` 标签会生成版本/主次版本及 latest，预发布标签不应当作正式 latest。依据 [docker/metadata-action v5 官方说明](https://github.com/docker/metadata-action/blob/v5/README.md#latest-tag)。因此暂停 production-deploy 不等于暂停全部发布；维护窗口须一并处理 docker-publish、历史排队镜像任务及版本标签操作。发布新镜像不等于当前 Compose 服务器自动更新：当前升级脚本是在现场构建 `npclassworks-backend:current`，但外部镜像消费者仍可能受移动标签影响。前端另有手动 Pages 发布入口 `前端/.github/workflows/deploy.yml`，不得误当作纯测试入口。

## 建议顺序：先关闭状态发布，再单独启用

1. **一次性确认发布窗口与控制入口。** 暂停两仓库自动生产部署，或设置已验证有效的 production 人工审批；清点并取消不该执行的历史/排队任务，服务器管理员确认代理无正在执行/排队任务。停止无关 main 合入。不要只依赖“先合一端会失败”，旧工作流或已发送代理请求不受新门槛保护。
2. **确认回退材料和现场配置。** 管理员核对 `DEPLOY_MODE=shared`、项目名、工作目录、域名、反代及 `NPEP_ENABLED=false`；确认当前健康，保留升级前数据库备份校验、前后端镜像 ID/标签和原部署 manifest。只回传核验结论及非秘密版本信息，不上传 env 文件。
3. **先后端，再前端合入，期间部署仍暂停。** 这样前端 PR 的 contracts 能读取已含 N1 的 backend main。后端 main 自动工作流若先看到旧 frontend main，预期阻断；不要取消 N1 门槛。合并冲突或新提交必须重新测试，不能以此前功能分支通过直接批准最终合并提交。
4. **记录最终双 SHA，仅测试最终组合。** 在已有前端 contracts 手动入口传两个完整 SHA，等待实际 N1 零跳过通过；另对最终代码运行前端 `tests.yml`（含 Browser）及构建检查、后端 `quality.yml`。保持 main 冻结；不要用 production workflow_dispatch 代替纯测试，因为它会继续部署。分支保护若阻止先后端合入，应评估规则和测试计划，不擅自绕过保护。
5. **仅放行一次确定版本的发布。** 推荐管理员使用现有 `deploy/upgrade.sh --backend-ref <最终后端SHA> --frontend-ref <最终前端SHA> --rollback-on-failure`，沿用现场目录和 env。该命令是部署操作，本轮未执行；不需要更改 server.js。自动路径只有在两端 main 被严格冻结、确认均等于受测 SHA、排空旧请求后才可作为人工控制的替代，仍不是工程上的 SHA 绑定保证。发布后核对 `deployed-release.json` 两个值、运行镜像和普通业务。
6. **保持 NPEP 关闭做上线检查。** 数据库迁移成功、学校管理/作业/通知/大屏原流程正常、API origin `/api/v2/npep/info` 返回合法的关闭信封；不要把 `/ready` 200 或网页域名 HTML 200 当成互联就绪。此时可暂缓启用并结束发布窗口。
7. **管理员现场启用，另行授权。** 使用同一 Compose 配置执行后端 `node scripts/npep-config.js init`（创建关闭身份，已有文件拒绝覆盖），检查目录与 node 用户权限；宿主 env 改 true 后重建后端以同步容器开关；配置仍关闭。随后执行 `node scripts/npep-deployment.js activate --invalidate-all-old-devices`，再检查 API 信封及设备配对。初始化和激活不能放进每次自动部署。
8. **一台真实大屏试点后扩大。** OWNER/ADMIN 核对申请、批准、现场确认、状态更新及撤销；验证断网/休眠/重启。反代共享 socket IP 目前有创建配对限额，批量部署分批进行；不擅自关闭限流。验证后再恢复日常自动部署入口。

## 回滚和恢复边界

- **未启用 NPEP、普通应用故障**：优先恢复原前后端应用镜像。现有 `upgrade.sh:92-97` 只在启动完成后的 readiness 检查失败时自动回滚；构建失败、`compose up` 直接报错等在 `set -e` 下提前退出，并不都覆盖。旧代码对新 N1 附加表/触发器的完整兼容没有专门做“旧镜像+新库”验收，不保证自动回退足以恢复全部业务。
- **已启用过 NPEP**：在回退旧应用前先通过可信 N1 helper 关闭入口并换 epoch，核对成功，保留独立配置卷。仅应用回滚不会自动换 epoch；旧版本恢复脚本也没有新保护。将来重新升级不得重复 init 或还原旧配置卷；重新激活会废止旧授权并要求重新配对。
- **确需还原数据库**：`rollback.sh:40-49` 先重 tag 旧镜像、调用当前工作区 restore，再检出旧代码。restore 必须通过仍在运行的可信 N1 容器完成换代际之后才能 dropdb。若后端已经停止或运行旧容器，当前流程会拒绝，而不是自动接管；需管理员以明确的 N1 镜像和同一卷执行经过审核的离线关闭步骤，再走恢复流程，不能改成忽略失败。
- **停机和数据损失需单独批准**：`restore.sh` 是 drop/create/restore，恢复升级前备份会丢失其后的新业务写入。即便有 pre-restore 备份，也不能把还原当成无损撤销。恢复后保持 NPEP 关闭，验证数据及账号/绑定后再激活。
- 生产不能 `down --volumes`；不能把 npep-config 卷随旧数据库备份还原。新卷缺身份或旧配置代际不匹配必须保持不可配对。

## 用户需要集中处理的最少事项

1. 确定维护窗口。
2. 指定服务器操作者，并确认现场部署路径/方式。
3. 同意在窗口内短时收紧自动部署及镜像发布入口；具体暂停、核验、备份和精确 SHA 操作由任务与服务器管理员落实。

建议本次先发布默认关闭的代码；大屏试点作为后续单独步骤。NPEduTools 尚未制作 N1 试点 portable 包，现有打包默认 `InDev20260920` 不能当作新版本重传；试点前需确定新包标识、对应受测代码与校验值。届时再安排管理员初始化、开关同步、显式激活，以及学校管理员和一台真实大屏现场验收。

除上述确认外，最终 SHA 的记录、测试运行核验、审核清单和失败分析可继续由任务处理。用户不在场期间只整理方案，不自行推进合并或启用。

现在只需管理员提供最少只读信息：两个部署仓库当前 HEAD、实际部署方式/Compose 项目名是否符合本文、NPEP 是否保持关闭（仅布尔值）、代理是否空闲且无排队、备份和旧镜像是否可恢复。不要发送 env、token、数据库密码或完整配置输出。本报告不是要求用户立即执行合并或服务器命令。

## 如果选择工程上保证精确组合

另行授权后可设计签名发布清单：包含前后端不可变 SHA、各验收 run/结果，固定脚本只接受经验证的清单并拒绝未受测组合；两端工作流产出并引用同一清单。由于当前 server.js 不传请求字段给脚本且拒绝新字段，不能只改 Actions 就宣称实现；应选择可由固定脚本验证的受保护发布清单，或经朋友明确批准升级代理协议并重启代理。兼容 epoch/祖先约束可以增加混配保护，但不能替代精确 SHA 与 CI 证明。本轮只提出方案，没有实施。
