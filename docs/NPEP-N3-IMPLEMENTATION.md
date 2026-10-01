# N3 服务端实现（2026-09-26）

> 2026-09-27 更新：N3 协议为 **0.4 / EXAM_MODE**，固定切换完整考试模式（含登录自启动）；成功回执必须包含 `startup=EXAM_MODE_APPLIED`。拒绝旧 0.3 请求和旧 scope 的新执行，仍允许查询、补报和现场结束旧历史。N1/N2 不变，本次无需新增数据库迁移；已有 N3 迁移仍须具备。三端配套更新，桌面旧许可失效后由现场重新开启。下文 0.3 为历史；未部署新版。

本地已实现 N3 0.3：本机许可镜像、状态、单设备 EXAM 申请、开始授权、结果事件、现场结束及网页查询。没有部署到生产。

契约运行副本为 `domain/npep/runtime-control.schema.json`，文档副本为 `docs/npep-n3/runtime-control.schema.json`，共享样例为 `docs/npep-n3/examples.json`。相比原审阅草案，管理状态补充了网页提交所需的 `controlEpoch`；当前历史只返回最近 20 项，nextCursor 为 null，不提供分页。此前审阅文档中的「仅草案」等描述保留为历史，当前状态以本文为准。

迁移：`prisma/migrations/20260926000000_npep_runtime_control/migration.sql`。策略和操作使用独立表，部分唯一索引约束单设备未解决操作；开始前在现有身份事务内复核原发起人的账号、会话、角色及设备授权。过期仅结束未获开始授权的请求；已经授权的未知结果保留，不能自动当作失败或重新执行。

本仓测试：`node --test tests/npepRuntime.test.js`；最新真实隔离 HTTP／PostgreSQL／.NET：`pnpm test:npep:native`。后者自动使用已安装的 PostgreSQL 工具创建临时集群，不调用 Docker，不访问 `classworks_debug`，并编译同级 NPEduTools 的验收程序。OS 动作由验收程序模拟；20 项实际数据库／HTTP 测试通过。首次运行需先还原三个仓库依赖。

跨仓统一入口在 NPEduTools：`./scripts/test-npep-n3.ps1 -Database`。完整实现、测试证据和现场边界见同级仓库 `NPEduTools/docs/npep/NPEP-N3-WEB-DELIVERY-20260926.md`。部署需正常执行迁移，不得仅更新路由文件。
