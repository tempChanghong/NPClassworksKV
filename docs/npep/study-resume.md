# 当前自习时段恢复（协议 0.11）

0.10 配置、应用和执行接口保持原格式。恢复使用独立 0.11 接口，不向旧客户端的严格响应追加指令。设备明确不支持恢复接口时，0.10 的展示和采集许可仍可正常工作。

- 管理端 POST `/api/v2/npep/schools/:schoolId/devices/:id/study-settings/resume`，使用该校 OWNER/ADMIN 的有效账号会话；请求为 `resumeRequest`。
- 设备端 POST `/api/v2/npep/device/study-settings/resume-exchange`，使用设备凭据；请求和响应为 `resumeExchangeRequest` / `resumeExchangeResponse`。
- 管理端继续读取 0.10 管理状态。`resumeSupported` 只在收到当前配置、当前设备会话的十五秒内恢复 exchange 时为真；单有配置应用或采集 exchange 不能证明支持恢复。

创建请求需要当前版本、新鲜应用及执行回报、当前有效学校时段、已停止或故障的定时记录，且没有手动采集占用。只接受 `WINDOW_SKIPPED` / `WINDOW_FAILED`，时钟失效不能靠恢复指令绕过。设备使用自己的 ClassIsland 时钟及单调许可再次核查，不使用服务端时间推进学校排程。

KV 在既有 `NpepStudyDevice.data` 中保存最多三十二个恢复请求，同一时间至多一个待处理请求。请求绑定当前身份、run/session/statusEpoch、规则版本及精确时段，三十秒内投递；重复 requestId 核对相同内容并返回原请求。过期或绑定/版本变化的待处理指令不再投递，结果标为 UNKNOWN。设备 exchange 的重复序号不会更新新鲜度或重复投递。

Host 在既有停止日志中将指令消费与当前时段的停止标记解除一起持久化，再交给唯一排程执行器。修改配置或重启不会自动清除停止标记；重复 commandId 返回此前结果，不解除后来新产生的停止标记。若排程修改把旧时段拆成多段，只解除当前一段，其他段继续保留。

`ACCEPTED` 表示设备已处理指令，不等于麦克风已经采集。麦克风释放、启动、实际帧新鲜度和报告继续走现有执行/统计链路。后台分别显示请求受理、设备处理及新鲜采集；期限显示使用服务端剩余毫秒与浏览器单调计时。摄像头、手动监测及展示收起不受恢复指令控制。

本地审核：`D:/CodeProjects/NPEP-study-20261009/resume-review/REVIEW.md`。测试使用合成帧、虚拟学校时钟、实际本机 HTTP 和内存仓储；没有真实采集、迁移执行或生产验收。
