# NPEP N2 通知轮询（实现候选）

## 协议与兼容

N1 的设备注册、配对、状态及 `device.status` 能力保持 0.1。不增加新的配对授权：有效设备凭据默认可以接收当前绑定班级及其适用走班空间的通知。

仅以下接口使用 `X-NPEP-Version: 0.2`，仍使用原 `Bearer npep1.<credentialId>.<secret>`：

- `GET /api/v2/npep/device/notifications`：首轮无参数，下一页仅传 `cursor`。
- `POST /api/v2/npep/device/notification-receipts`：提交 `requestId` 和 1–100 个事件。

完整数据结构见 `domain/npep/notifications.schema.json`。外层保留 `protocolVersion/requestId/serverTime/data`，错误使用原错误 envelope。GET 必须携带 UUID v4 `X-Request-Id`；POST 使用 body.requestId。

正文长度额外按 **UTF-16 code units** 检查，与 JS `.length` / .NET `string.Length` 一致：title≤160、content≤8000、source≤120。JSON Schema 的 maxLength 仅为基础约束，不替代此限制。超长标题或正文拒绝整个快照，不截断正文；source 展示名可安全缩短且不切开代理对。

## 快照边界

每页 20 条，每设备一个物化快照，有效期 120 秒。最多 500 条且完整 items JSON 不超过 2 MiB；超限返回 503 `SNAPSHOT_LIMIT_EXCEEDED`，不得当作空收件箱。

每页重新核验外部门闩、数据库实例、凭据状态、绑定修订、班级与学期。仅包含已发布、已到发布时间、尚未到期且属于设备空间的 NOTICE。继续分页时当前可见集合或内容改变返回 409 `SNAPSHOT_INVALIDATED`；快照被另一个首请求替换、失效或过期返回 410 `SNAPSHOT_EXPIRED`。客户端应丢弃未完成轮次并重新读取，只有完整成功后才替换收件箱。

正常首轮建议间隔 10 秒，失败退避并加随机延迟。服务端每设备首请求上限 12 次/分钟，续页 180 次/分钟，回执 30 批/分钟；429 后遵守返回的重试建议。

`popupEnabled` 共用网页字段：MINOR 按作者选择，其余三级强制 true。false 仅关闭自动弹窗，不禁止接收，也不禁止用户手动打开后产生展示或关闭回执。

## 回执

事件包含 eventId、publicationId、revision、stage、occurredAt；stage 仅 RECEIVED / DISPLAYED / DISMISSED，三个阶段独立记录，关闭不推导展示或接收，更不代表人员已读。服务端单独记录 receivedAt。

以 deviceId+eventId 幂等：相同 payload 返回 DUPLICATE；同 ID 不同内容返回 REJECTED/IDEMPOTENCY_CONFLICT。只有已通过快照发送给该设备的修订可接收回执，否则 REJECTED/NOTICE_NOT_AVAILABLE。已经曝光的旧修订即使撤回或到期也可补传，但绝不会计入新修订。撤销设备权限后不再接收任何回执。

授权曝光证据与回执保留 90 天，定时每批最多清理 5000 条。每设备曝光证据上限 10000 条，回执上限 100000 条；超限明确返回 503，不静默丢弃。网页与 NPEduTools 的回执分别展示。

## 本地 HTTPS 联调 fixture

入口：`scripts/serve-npep-n2-fixture.js <private-directory> [port=55481]`。

脚本要求 NODE_ENV=test、RUN_DATABASE_TESTS=true，DATABASE_URL 必须指向 localhost/127.0.0.1，数据库名必须匹配 `npclassworks_test_n2_fixture_[a-z0-9_]+`，学校、设备及部署表必须为空。先对该一次性 PostgreSQL 数据库执行 Prisma migrations。不得指向已有开发库或生产库。

private-directory 需有 localhost-key.pem 和 localhost-cert.pem（SAN=DNS:localhost,IP:127.0.0.1）。只绑定 127.0.0.1；不要将本地证书安装到系统信任根。客户端为本次验收显式信任 fixture 证书或核验其 SHA-256。

启动后输出目录生成私有 fixture.json：origin、adminToken、certificateFile、schoolId、screenBindingId 可用于完整 N1 配对；该大屏未被预置设备占用。另一个预置设备凭据用于快速协议检查。notifications.expectedCount=23，silentPublicationId 为静默 MINOR；共 6 条静默通知。凭据只留在 ignored `deploy/runtime` 目录，不提交、不输出日志。

以下为 **fixture 专用** 控制接口，生产路由不挂载；使用 fixture.controlSecret 的 Bearer 鉴权：

- POST `/__fixture/notices`：`{title,content,priority,popupEnabled}` 新增同班通知。
- POST `/__fixture/notices/:id/revise`：`{content}` 修改并增加修订。
- POST `/__fixture/notices/:id/withdraw` 或 `/expire`：撤回/到期并增加修订。
- GET `/__fixture/receipts`：查看隔离学校全部设备回执。

控制接口用于驱动测试数据，不能据此宣称实际教师发布路由已通过桌面端联调。接收及回执使用真实 N2 路由、鉴权、Prisma 和 PostgreSQL。

结束后停止 fixture Node 进程，再删除本次专属一次性容器（数据在 tmpfs 中）。不得执行影响其他容器的全局清理。

## 2026-09-24 验证记录

- 本任务实际运行：完整 PostgreSQL 集成 117/117 通过；后端单元测试 192 通过、17 项数据库专用测试跳过；前端单元测试 513/513、Lint 和两项定向浏览器测试通过。
- NPEduTools 协调任务回报：真实 HTTPS/PostgreSQL 跨端验收 27/27 通过，覆盖原 N1 配对和状态上报、N2 两页共 23 条通知、静默通知不自动选中、接收回执及重复提交、手动打开静默通知后的展示/关闭回执、重启去重、数据库精确 27 条事件、修订/过期/撤回及管理员撤销。
- 跨端验收产物目录：`C:/Users/Changhong/NPEduTools-npep-ci-clean-20260921/.artifacts/npep-n2-acceptance-20260924`。此项由桌面协调任务执行并报告，本任务未重新运行桌面验收。
- 通知变化由隔离控制接口驱动，因此本轮不宣称真实教师发布界面至桌面弹窗的完整链路已通过，也不代表生产环境验收。未推送 main 或部署生产。
- 验收结束后已导出 `deploy/runtime/npep-n2-fixture/diagnostics/npep-n2-final.dump`，并实际恢复至另一个隔离数据库验证。原库与恢复库均为 25 条发布、2 台设备、27 条回执、49 条曝光证据、2 个快照、1 条配对记录；校验和及比对结果保存在同目录 `backup-verification.json`。
- HTTPS fixture 已结束且 55481 不再监听，专属容器 `npclassworks-n2-fixture-20260924` 已停止并保留。PostgreSQL 使用 tmpfs，数据恢复依赖上述已验证备份；未停止其他 Docker/WSL 服务。备份与凭据属于本地私有诊断文件，不提交版本库。
