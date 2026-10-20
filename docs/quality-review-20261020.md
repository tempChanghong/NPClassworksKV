# KV 本地整体复验

2026-10-20。起点 `385db88547f0a12dd4a848366743a98dab4eaef2`，从原 `codex/manual-study-homework-20261020` 新建 `codex/classworks-quality-20261020`，保留原分支及已有修复。本轮业务提交 `eb25f04c3f2bbf28d4f81a1a9193f5f20f80a950`。

## 修复

`services/publicationService.js:copyScreenBoardDate` 原本可以将 `PUBLISHED` 但发布时间仍在未来的作业复制为立即可见内容。来源查询现与大屏可见时间保持一致，只复制已经到达发布时间的记录。新增 `workspaceAssignmentDatabase.integration.test.js` 数据库反例，覆盖尚未发布来源不被复制，原有正常与重复复制断言继续通过。

前端的真实 HTTP 回归同时验证：正常来源复制一项，未来来源与草稿不复制；重复操作不新增，原未来记录及版本不变。本轮不修改数据库模型、迁移或现有学校设置。

## 验证

- 全量单元测试：607 项，587 通过、20 项原有数据库条件跳过、0 失败；`.artifacts/quality-unit-final.log`。
- 原生自有临时 PostgreSQL：142 项，137 通过、5 项依赖 .NET 验收程序的检查跳过、0 失败。覆盖身份/会话、组织与权限、名册/考勤、发布版本/幂等、通知送达、定时发布、周查询、迁校等业务。
- 对应前端真实 API、数据库与 PWA 回归：网页主流程 39 通过、NPEP 管理 1 通过、手写保存 39 通过；人工入口启动冒烟 1 通过，人工结论仍为 `PENDING`。
- 原生套件没有执行依赖 Docker Compose 部署脚本的备份恢复测试；未设置虚假 Compose 环境，也没有使用 Docker。五项桌面检查、实际设备及生产验收仍未完成。
- 测试期间生成的 Prisma 客户端已按原内容还原，最终通过记录显示源码稳定、自有集群停止及删除成功，结束时 KV 工作区干净。失败复现保留已停止集群供诊断。

完整的跨仓源码范围、失败反例、隔离脚本路径及每项原始结果编号记录在本地前端 `D:\CodeProjects\NPClassworks\docs\classworks-quality-review-20261020.md`。原始结果位于该仓库 `.artifacts/quality-review/`。本轮仅本地分批 Commit，未推送、未创建 PR、未运行远端 CI、未部署，NPEssentials 与 NPEduTools 未改动。
