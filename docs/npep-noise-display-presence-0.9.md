# NPEP 0.9 定时噪声展示在线状态与原生返回

本契约只处理已经由 0.6 噪声交换和 0.7 排程回传确认的 **同一台设备、同一次采集、同一个定时时段**。网页展示心跳是诊断信号，不会启动、停止或锁定采集。桌面端根据学校服务的有效租约与网页状态决定是否展示本地备用画面；考试与通知仍可覆盖它。0.8 网页返回、设置和受保护停止接口保持原样。

三个 POST 均使用 `X-NPEP-Version: 0.9`、JSON、`requestId`（UUIDv4）和同值的 `X-Request-Id`。请求对象拒绝额外字段。屏幕使用 `X-Classworks-Screen-Token`；设备使用已有的 `npep1` Bearer 凭据。服务端每次重新核对屏幕绑定、设备身份、当前运行会话、0.6/0.7 回传、采集 `instanceId/revision/captureSessionId` 和完整 `window`。窗口时间采用学校本地时间 `yyyy-MM-ddTHH:mm:ss.fff`，没有时区后缀。

## 网页心跳

`POST /api/v2/npep/screen/noise-display/presence` 请求字段为 `requestId, displaySessionId, sequence, state, instanceId, revision, captureSessionId, window`。`displaySessionId` 是当前浏览器标签页的 UUIDv4，重新绑定时更新；`sequence` 从 1 递增。`state` 只能是 `DISPLAY_VISIBLE`、`RETURNING`、`BLOCKED`、`HIDDEN`。网页在状态转换时和每 5 秒发送一次。服务端以接收时间计时，不接受客户端时间戳；相同序号与内容的重试不会刷新在线时间，序号倒退或同序号内容变化返回 409。`RETURNING` 需要本时段仍有效的学校返回租约，否则返回 `RETURN_LEASE_REQUIRED`。每个大屏当前凭据最多接纳 8 个近期标签页；有新心跳写入时清除超过 60 秒的记录。

响应 `data` 为 `{accepted:true,serverNow}`。网页暂时无法报告时，不把它推断为采集结束；明确收到 HTTP 404／426 时，网页停止重试该版本心跳，网络或其他暂时性失败仍可重试。

## 桌面观察与返回

`POST /api/v2/npep/device/noise-display/observe` 请求字段为 `requestId, context, instanceId, revision, captureSessionId, window`。`context` 是现有 0.6/0.7 的完整运行上下文。响应 `data` 恰有 `supported, serverNow, returnMinutes, presence, activeReturn`。`presence` 是 `{state,ageMs}`：有效租约优先表现为 `RETURNING/0`；否则在 12 秒内任一标签页可见时为 `DISPLAY_VISIBLE`，再依次选择 `BLOCKED`、`HIDDEN`；全部过期则为 `UNKNOWN/null`。屏幕心跳序号重试不会延长该期限。桌面应对短暂心跳丢失保留约 18–20 秒宽限，再考虑本地备用画面，并把未知状态表述为“网页状态未确认”。

`POST /api/v2/npep/device/noise-display/return` 使用相同范围字段以及稳定的 `requestId`。离线补登记时必须同时附带 `offlineStartedAt`（严格 UTC 毫秒格式 `yyyy-MM-ddTHH:mm:ss.fffZ`）和 `returnMinutes`（1–60）；两项都省略表示在线返回。服务端沿用 0.8 的保护：离线开始时间不得早于一小时或晚于服务器当前时间，实际分钟数不超过当前学校设置和离线记忆值。相同请求 ID 的重试不延长期限；本时段已有有效租约时，原租约优先。网页和桌面看到同一条返回租约。

有效 `activeReturn` 为 `{requestId,window,startedAt,expiresAt,returnMinutes,remainingSeconds}`；没有有效租约时 observe 返回 `null`。离线补登记若到达服务端时已自然过期，**仅 return POST** 仍返回原租约及 `remainingSeconds:0`，供桌面确认该请求已登记并清除待同步记录；随后的 observe 返回 `activeReturn:null`。返回作业板只影响展示，不会停止采集。完全退出桌面应用仍遵循 0.8 的本地管理密码保护。

具体正反例在 [`../domain/npep/noise-display-presence-wire-cases.json`](../domain/npep/noise-display-presence-wire-cases.json)。旧服务对 0.9 路径返回 426；设备不能把 426 当成网页已经消失的证据。数据迁移新增 `NpepNoiseDisplayPresence`，保留短期心跳，不存原始音频。

[P3 独立守护](../../NPEduTools/docs/iterations/SCHEDULED-NOISE-GUARD-20261004.md)在桌面本地监督 Host；本 0.9 HTTP 契约不承载守护恢复状态。重启期间网页与桌面都需重新取得新鲜的 0.6/0.7 同会话证据，陈旧或未知状态不能表述为已经恢复采集。
