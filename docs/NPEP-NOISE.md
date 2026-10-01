# N4.2 噪音监测接口

2026-10-01 已接入 [N4.3b–c 学校排程](NPEP-NOISE-SCHEDULES.md)：独立 0.7 管理、设备下发、执行回传和本次恢复；本地模拟闭环通过，未部署。下文仍描述独立的 0.6 手动监测。

协议版本 0.6，JSON 契约在 `domain/npep/noise.schema.json`，与桌面仓库副本统一测试比对。

| 接口（共同前缀 `/api/v2/npep`） | 身份／用途 |
| --- | --- |
| `GET /screen/noise` | 大屏凭据，查询自身绑定设备的提供方、状态与最近报告 |
| `POST /screen/noise/commands` | 大屏凭据，提交有期限的 START／STOP |
| `POST /device/noise-exchange` | NPEP 设备凭据，上报实际状态、命令回执和统计，取待执行命令 |
| `GET /schools/:schoolId/devices/:id/noise` | 学校管理员，查看有权限设备的报告 |

开始请求不等于已采集。命令绑定 Host 实例、修订号和会话，30 秒到期；状态 15 秒过期。报告以会话 ID 去重，重传不同内容拒绝。设备行锁串行化每设备事务。大屏凭据由具体 `screenBindingId` 映射，不能通过请求自选其他设备。

新增 `NpepNoiseDevice` 表保存有界 JSONB 状态：最多 64 条命令、200 份／30 天报告；维护任务也清理离线设备的超期报告。只有统计，无音频。绑定失效与会话替换沿用已有 NPEP 校验。

本地迁移：`node --env-file=deploy/.env.debug node_modules/prisma/build/index.js migrate deploy`。不要重新运行调试数据初始化来代替迁移。本次已应用到本机 `classworks_debug`，没有触碰生产环境。

统一测试位于相邻 NPEduTools 仓库 `scripts/test-npep-noise.ps1 -Browser -Database`；原生 PostgreSQL 测试使用临时集群、模拟音频，结束清理。完整任务卡：`NPEduTools/docs/npep/N4.2-NOISE-TAKEOVER.md`。代码未推送或部署。
