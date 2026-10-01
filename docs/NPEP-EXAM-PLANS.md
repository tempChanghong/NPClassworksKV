# 考试方案通道 0.5

本地实现，未部署。先应用 `20260927000000_npep_exam_plans` 迁移。沿用 N1 设备身份和 N3 的学校／设备事务锁与管理员会话复查，不扩大配对令牌权限。

| 调用方 | 路由（前缀 `/api/v2/npep`） | 用途 |
|---|---|---|
| 设备 | POST `/device/exam-plan-status` | 方案许可、配置版本、播放器观测 |
| 设备 | GET `/device/exam-plans` | 当前单个待处理任务 |
| 设备 | POST `/device/exam-plans/:operationId/grant` | 放映前重新检查发起人并获取短期授权 |
| 设备 | POST `/device/exam-plans/:operationId/result` | 校验／启动结果，允许同内容幂等重传 |
| 学校管理员 | GET／POST `/schools/:schoolId/devices/:id/exam-plans` | 查看／投递原始 JSON 的 Base64 快照 |
| 学校管理员 | POST 上述路径 `/:operationId/start` | 明确确认准备 ID 和文件哈希 |
| 学校管理员 | POST 上述路径 `/:operationId/cancel` | 尚未授权启动时取消 |

所有请求头 `X-NPEP-Version: 0.5`，沿用请求编号相关性和不缓存规则。其他 NPEP 版本不变。正文及响应仍有 64 KiB 边界，源文件最多 24 KiB；摘要总长限 6000 个 UTF-16 单元。具体结构以 `domain/npep/exam-plan.schema.json` 为准。

任务 5 分钟过期，启动授权 30 秒，状态新鲜度 45 秒。`STARTED` 表示启动已受理，**不是**播放器就绪。查看 `status.player` 中同一个 `sessionId` 的实际状态；失联显示未知。已授权请求不会远程强制取消。

单测 `node --test tests/npepExamPlans.test.js`；原生数据库及真实 .NET HTTP 联调 `node scripts/run-native-npep-tests.js`。均不部署、不连接生产；后者启动并清理独立临时 PostgreSQL，播放器动作用测试替身。

用户操作和代码图见 [NPEduTools 一页流程](../../NPEduTools/docs/npep/EXAMAWARE-PLAN-REMOTE.md)。
