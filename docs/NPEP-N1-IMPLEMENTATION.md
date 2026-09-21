# NPEP N1 服务端隔离实现与验收

日期：2026-09-20。分支：`codex/npep-n1-server`。基线：`151f70358b01f046c136ae961f64b060bd29bf82`。

本轮实现 **配对、撤销、只读设备状态**，不包含通知投递、模式切换、录制控制或网页管理界面。没有推送、部署生产服务器，也没有修改 `deploy/agent/server.js`。NPEP 默认关闭；版本号和 v1.1.5 release 文档不变。

## 契约与代码

- 共同契约：`../NPEduTools/docs/npep/NPEP-N1-CONTRACT.md`。服务端冻结的 wire schema 在 `domain/npep/wire.schema.json`，与设备侧 v0.1 字段一致。
- `routes/v2/npep.js`：14 个 N1 路由，统一版本头、请求 ID、错误信封、no-store、16 KiB 请求上限、严格 JSON 与独立认证域。挂载在通用 body parser、访问日志和错误日志之前。
- `domain/npep/wire.js`：重复/转义重复键拒绝、UTF-8 与 Unicode 标量校验、规范 base64url 解码、原始秘密字节 SHA-256、常量时间摘要比较。
- `services/npepService.js`：配对与确认幂等、管理员持久化会话复核、设备状态会话 CAS、序号防乱序、事务内撤销及审计。固定 90 天设备凭据，不滑动续期。
- Prisma 迁移 `20260920120000_npep_n1`：独立 NPEP 表、ACTIVE binding 部分唯一索引、credentialId 唯一索引、安全整数检查、绑定/班级/学期/学校生命周期触发器。触发器与原业务修改同事务，重新启用不复活旧授权；网页 PIN/token 重置不影响 NPEP。
- `services/npepMaintenanceService.js`：每分钟有界清理；配对摘要到期删除、申请到期后 24 小时回收、会话收据至设备凭据到期、设备到期后 24 小时回收、审计 90 天。每设备最多 10000 个会话收据，超限拒绝新会话，不删除仍需 fencing 的收据。

秘密不写入响应、审计、通用访问日志或遥测。HTTP 遥测忽略 NPEP 路径，并抑制该请求的子追踪；聚合 HTTP 指标仅记录固定路由模板。管理列表只返回协议白名单字段。学校迁移包仍使用业务集合白名单，测试确认不包含 NPEP 配对或设备授权。

## 锁与一致性

管理和设备操作按学校、账号/账号会话（涉及管理员时）、学期、班级、绑定、配对/设备的顺序取得锁；已有管理角色写路径使用学校锁。生命周期触发器在绑定锁内撤销设备并关闭状态会话。确认在等待锁之后重新判断有效期与批准人的会话、tokenVersion、localDisabled、学校角色。

先提交的心跳可成为最后一次观测；撤销先提交时，后续心跳不能修改 lastSeen 或恢复 ACTIVE。新的状态会话立即清空当前状态与 lastSeen，旧进程会话及重复开会话不能重新抢占。重复状态返回原 receivedAt，不刷新在线时间。

限流使用 PostgreSQL 原生 `INSERT ... ON CONFLICT ... RETURNING`，跨 Node 进程共享。配对查询使用共享 5 秒冷却，避免固定时间窗边界连发。创建按 socket 对端 IP 限制，不信任任意 X-Forwarded-For；将来反向代理部署时须明确设计受信代理与共享 NAT 额度，不能直接取消限流。

## 恢复门禁

配置须位于 PostgreSQL 备份之外：

```json
{
  "enabled": false,
  "serverInstanceId": "现场生成的稳定 UUIDv4",
  "deploymentEpoch": "每次恢复前重新生成的 UUIDv4"
}
```

环境变量为 `NPEP_ENABLED=true`、`NPEP_DEPLOYMENT_FILE=<该文件绝对路径>`。未启用、缺失/关闭配置、配置与数据库代际不一致均返回 503。每次事务开始和结束核对外部文件；普通重启不得自行换代际或自动同步旧库。

`node scripts/npep-config.js prepare-restore <宿主开关>` 核验宿主/容器开关、配置和目录权限，原子关闭外部入口并轮换 epoch；旧 `npep-deployment.js prepare-restore` 入口也要求显式传入宿主开关并调用同一检查。`activate --invalidate-all-old-devices` 在事务内废止旧设备、配对、会话并同步数据库代际，提交后才打开外部入口。`deploy/restore.sh` 无条件于停止后端/恢复库之前调用检查，失败则拒绝恢复；恢复后保持关闭，必须显式激活。

**尚未部署生产。** 生产 Compose 已接入默认关闭的 NPEP 开关和独立目录卷，启用步骤及检查见 [部署准备记录](NPEP-N1-DEPLOYMENT-READINESS.md)。仍需验收真实反代 TLS、受信代理、现场配置权限，以及操作员绕过恢复脚本的应急流程。这里不将本地恢复测试等同于生产恢复验收。

## 隔离运行

本次使用 `npclassworks-npep-n1` Docker Compose 项目，PostgreSQL 17，仅绑定 `127.0.0.1:55439`。联调库为 `npclassworks_test_npep`；服务端验证另用 `npclassworks_test_npep_verify`，不会重置联调库。

1. 用 `docker-compose.integration.yml`，设置 `INTEGRATION_POSTGRES_PORT=55439`、`INTEGRATION_POSTGRES_DB=npclassworks_test_npep`，启动上述专用项目的 postgres。
2. 将 DATABASE_URL 指向该本地测试库，执行 `pnpm exec prisma migrate deploy`。
3. 在 gitignored 的 `deploy/runtime/npep-n1/` 生成 `localhost.key`、`localhost.crt`（SAN 包括 localhost 和 127.0.0.1；仅测试客户端显式信任，不修改系统全局信任）。
4. 执行 `node scripts/npep-isolated-server.js`。脚本拒绝非 localhost 或非 `npclassworks_test_npep*` 数据库，监听 `https://localhost:34439`，写入 `fixture.json`，其中包含临时管理员令牌与虚构学校/绑定。**不要提交或粘贴该文件。** 令牌有效 8 小时，服务重启刷新；既有实例/代际保持不变。
5. 所有业务 POST 使用 JSON body 中 requestId；GET 使用 X-Request-Id，均带 X-NPEP-Version: 0.1。管理员和设备各用独立 bearer。

本轮联调结束后只停止本次 HTTPS 进程，保留专用 PostgreSQL 及其数据，不执行 Docker 全局关闭、WSL shutdown、reset 或卷清理。测试材料留在 ignored 目录；专用 PostgreSQL 使用 tmpfs，未来停止前如需保留当前数据，须先导出备份；这些数据都是可重新生成的测试夹具。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm test` | 186 通过，17 个真实数据库测试按默认环境跳过，0 失败 |
| `pnpm test:database` | 完整后端 PostgreSQL 回归 111/111，通过；包括既有备份恢复与权限撤销测试 |
| 新增 NPEP 专项最终运行 | 14/14（含父测试），覆盖 HTTP/PG、并发、迁移导出、清理、实际 pg_dump/pg_restore |
| wire 单元测试 | 3/3，含重复键/UTF-8/额外字段/能力/安全整数/秘密规范编码 |
| NPEduTools 真实客户端联调 | 对端报告两轮 9/9、10/10，通过本机 HTTPS、真实 PostgreSQL、DPAPI 恢复、Host 缓存状态、管理员撤销与本机清理 |

专项测试覆盖：未批准不能激活；旧无 session 管理员 JWT、VIEWER、错误秘密/认证域、跨校对象拒绝；confirm 丢响应后 me 恢复；同键不同内容拒绝；单 binding 并发确认只激活一台；凭据 ID 碰撞不覆盖；降权/注销/过期等待后拒绝；绑定改回/重新启用仍失效；心跳与撤销串行化；乱序/重复/旧会话；两独立 Node 进程共享配额；迁移包排除 NPEP 授权；恢复旧 ACTIVE 数据后外部 epoch 门禁拒绝，显式恢复激活废止旧授权。

联调发现并修复：Prisma 无法反序列化 advisory-lock 的 void 返回列（改为显式 text）；Prisma 普通 upsert 在并发创建限流桶时存在竞争（改为原生 PostgreSQL 原子语句）。

对端可复现 harness：`../NPEduTools/tests/NPEduTools.Npep.Acceptance/Program.cs`；对端详细报告：`../NPEduTools/docs/npep/NPEP-N1-IMPLEMENTATION-REPORT.md`。

## 下一阶段

N1 学校管理网页的短码解析、批准、设备列表与撤销，以及 NPEduTools 正式配对界面仍未实现；本轮批准通过真实接口测试完成。实际班级大屏、生产反代和运维权限尚未验收。通知投递、模式联动等后续能力须单独设计授权与版本，不能直接复用 device.status 权限扩展。
