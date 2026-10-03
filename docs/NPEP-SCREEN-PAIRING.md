# 班级大屏预授权配对

学校管理员预先开放某个有效班级大屏的网页配对；大屏网页用自己的登录凭据生成 8 位、10 分钟有效的一次性码。NPEduTools 输入后端地址和码后读取固定归属，在本机确认，管理员不必同时在线。旧桌面创建码／管理员批准流程继续支持。

新增迁移：`20261002000000_npep_screen_pairing`。已有大屏的 `npepPairingEnabled` 默认 false；已有配对的 `approvalSource` 默认 ADMIN。先正常应用迁移并重新生成 Prisma，再升级三端；现有设备无需重新配对。

接口前缀 `/api/v2/npep`，协议 `0.1`：

| 接口 | 身份 |
| --- | --- |
| GET `/schools/:schoolId/pairing-access` | 学校管理员账号 |
| POST `/schools/:schoolId/screen-bindings/:bindingId/pairing-access` | 学校管理员；requestId、enabled、expectedRevision |
| POST `/schools/:schoolId/pairing-access/preview` | 学校管理员；requestId、termId、targetType（SCHOOL／GRADE）、targetId（全校为 null）、enabled |
| POST `/schools/:schoolId/pairing-access/batch` | 学校管理员；同预览请求，加 previewDigest |
| GET `/screen/pairing` | `X-Classworks-Screen-Token`；读取自己的授权与占用状态 |
| POST `/screen/pairing` | 同上；requestId；返回 userCode、expiresAt、state |
| POST `/pairings/claim` | 未配对桌面；原 createPairing 字段加 userCode；归属由码决定 |

兑换形成 SCREEN 来源的 APPROVED 申请。创建响应沿用 PENDING 结构供桌面持久化；后续配对查询返回 APPROVED 和固定归属；确认沿用原接口。长期秘密仍由桌面产生，服务器存哈希。码、批准和确认在实际 SQL 事务中检查学校、绑定、授权版本、登录凭据版本和实例代际。响应丢失可使用同一请求 ID 与候选恢复；生成新码会取消旧的未兑换码。

关闭预授权使未完成网页申请失效，不撤销现有设备；撤销已有设备使用现有 revoke。重置网页大屏凭据不撤销已连接设备，但会使未确认的网页配对失效。已占用的大屏不会被替换。

批量实现：`services/npepPairingBatch.js`。范围限定指定 ACTIVE 学期的现有启用大屏及启用行政班；年级校验属于该学期，全校包括未分年级班级。排除停用项，未来新建大屏仍默认未开放。预览显示数量及前 50 台，不截断实际提交范围。

预览摘要覆盖实例、作用范围／操作、名单、绑定／班级归属及授权／登录凭据版本。提交事务按学校 → 学期 → 班级 → 大屏的顺序锁定并重建摘要，变化则返回 409 PREAUTHORIZATION_CHANGED，整批回滚。仅变化项递增授权版本并取消 READY 码，已兑换未确认申请由版本检查失效；无需修改项保留码与版本，现有设备授权不变。审计动作为 SCREEN_PAIRING_BATCH_ENABLED／DISABLED，以请求 ID 为 objectId。沿用既有迁移，无新增表。

批量不保存可恢复的请求结果；成功回执丢失后，旧摘要可能失效，调用方先刷新再预览，不自动重发。短码及单次配对的原有幂等恢复另行保留。学校管理员会话、权限及学期状态在提交时重新验证。

实现入口：`services/npepScreenPairing.js`、`services/npepService.js`、`routes/v2/npep.js`。过期码由已有定时维护有界清理。字段和模型对应 `prisma/schema.prisma`，不要手工修改生成的 Prisma 客户端。

测试：`node scripts/run-native-npep-tests.js` 创建独立原生 PostgreSQL，应用迁移，运行真实 HTTP 与 .NET 跨端验收，结束清理。新增配对用例在 `tests/helpers/screenPairingDatabase.js`；不会访问 classworks_debug，也不使用 Docker。2026-10-02 批量扩展后：42 项通过，含管理员退出后确认、竞态兑换、过期／替换码、授权撤销、登录轮换、占用保护及真实 .NET 重启上报撤销。

批量真实数据库用例在 `tests/helpers/pairingBatchDatabase.js`，覆盖年级／学期范围、名单及版本变化、并发提交、无改动码保留、未完成申请失效、已有设备保留、账号权限和超过 50 台范围。

原生 runner 已加入升级阶段：先在独立临时集群应用本次配对迁移之前的迁移链，通过原生 SQL 写合成旧设备／旧申请；再应用新迁移，运行 `tests/npepPairingUpgrade.integration.test.js`，通过后才运行原 42 项验收。升级包含 5 个子用例（加父用例共 6 项）：原数据与凭据不变、旧凭据会话上报、已批准申请确认、旧待审批码继续审批确认、新屏默认未开放及迁移重跑。不会执行旧程序二进制，也不读取调试／生产库。

三仓联合 CI 位于桌面仓库 `.github/workflows/npep-pairing.yml`，使用完整的桌面／网页／后端 SHA 运行同一验证入口；说明见桌面 `docs/iterations/NPEP-PAIRING-AUTOMATION-20261002.md`。本次没有修改现有生产部署工作流。

当前只完成本地实现和自动验收；没有执行生产部署或现场设备配对。
