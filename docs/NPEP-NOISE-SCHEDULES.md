# 学校噪音排程（N4.3b–c）

当前任务卡与下发协议见 [N4.3c 跨端说明](../../NPEduTools/docs/npep/N4.3c-SCHEDULE-EXECUTION-20261001.md)。本地实现与合成音频闭环完成，尚未部署。更新后的配对桌面会接收有效规则并按学校时间执行；保存不等于设备已应用或正在采集。

- `routes/v2/npep.js`：0.7 管理路由及严格 JSON 边界。
- `domain/npep/noiseSchedules.js`：管理请求校验；`noiseScheduleRules.js`：共享纯规则。
- `services/npepNoiseScheduleService.js`：范围、预览、版本及幂等处理。
- `services/npepNoiseScheduleRepository.js`：目标／绑定读取与 SQL 存储。
- `20261001000000_npep_noise_schedules`：政策和请求结果表，审计沿用 `NpepAudit`。

验证：`node --test tests/npepNoiseSchedules.test.js`；数据库及跨端回归使用 `node scripts/run-native-npep-tests.js --desktop-root ../NPEduTools`，只操作临时测试实例。

管理规则仍为学校 OWNER／ADMIN 及当前会话，不接受教师、大屏凭据或其他学校对象。0.6 手动监测接口未扩充。

`npepNoiseScheduleRuntime.js` 提供有效规则指纹、当前设备／会话／序号隔离、执行观测和幂等本次恢复。0.7 设备 `POST /device/noise-schedule`；大屏 `GET /screen/noise-schedule`、`POST /screen/noise-schedule/resume`；管理员 `GET /schools/:schoolId/devices/:id/noise-schedule`。设备交换是能力声明，配对后的学校规则不需要额外授权开关；旧客户端没有新交换就不会自动启动。

迁移 `20261001010000_npep_noise_schedule_runtime` 为每设备状态、恢复命令和会话来源映射提供 JSON 聚合表。最多 200 条来源映射、32 条恢复命令；来源映射保留 30 天，包括离线维护清理。已有报告仍使用 0.6，通过 sessionId 关联，不增字段。设备恢复演练也包括这张表。
