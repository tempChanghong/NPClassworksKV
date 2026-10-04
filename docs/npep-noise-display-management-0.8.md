# NPEP 定时监测展示与管理 0.8

2026-10-04。本能力与原有 0.6 噪声命令、0.7 排程状态并行，原 JSON Schema 不变。先执行 `prisma migrate deploy`，再发布 KV 和网页；未升级 KV 的大屏会明确报接口不支持。

- 学校管理员用 `GET/POST /api/v2/npep/schools/:schoolId/noise-display-settings` 按学期配置年级或班级的 `returnMinutes`（1–60，默认 10）。班级设置优先于年级，删除班级设置后继承年级。配置只影响新发起的临时返回，不修改采集时段。
- 已绑定大屏用 `GET /api/v2/npep/screen/noise-display` 读取有效分钟数及当前返回期限，用 `POST /screen/noise-display/return` 为正在实际采集的定时时段登记返回。期限由服务端按绑定及 `window.start/end` 保存；重复请求、刷新、重连或同一时段换采集会话不能续期。考试暂停会删除返回记录。离线未登记的返回携带原起点和记忆分钟数重试，服务端只取记忆值与现配置的较小值，所以不会因配置增大而延长，但配置缩短可能提前恢复。
- 定时 STOP 使用 `POST /screen/noise-management/commands`，须提交大屏 PIN；PIN 在 KV 服务最终创建命令前验证，不进入 0.6 命令记录。旧 `/screen/noise/commands` 对受保护的定时 STOP 返回 `MANAGEMENT_REQUIRED`，手动监测仍走 0.6。
- NPEduTools 用 `POST /device/noise-management/status` 上报保护状态，并在执行受保护 STOP 前调用 `POST /device/noise-management/authorize`。KV 同时核对当前设备会话、完整上下文、命令授权、排程时段和有效性。HTTP 接受命令不代表桌面已执行。

所有 0.8 路由要求 `X-NPEP-Version: 0.8` 与请求 ID。大屏端仍须遵守通知、编辑与考试优先级；KV 只保存期限与授权依据，不负责浏览器抢焦点。真实教室设备上的麦克风、触控和考试切换仍需现场验收。
