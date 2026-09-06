# 隔离备份恢复演练与历史分页（2026-09-06）

## 真实脚本演练

`tests/backupRestoreDatabase.integration.test.js` 将当前 `deploy/lib.sh`、`backup.sh`、`restore.sh` 原样复制到系统临时目录（仅转换换行）。配置仅包含测试数据库凭据、独立 Compose 项目名和临时备份目录，不读取生产配置。数据库 URL 必须指向本机且名称符合 npclassworks_test，项目名必须符合 npclassworks-integration-进程号；正常 `node --test` 不启用该测试。

脚本实际执行 pg_dump、pg_restore --list、SHA-256 校验、恢复前安全备份、dropdb/createdb/pg_restore 和服务停止/启动。standalone 与 shared 两种脚本分支都已运行。对比恢复前后的账号、学校成员、教学空间及科目规则、大屏绑定和凭据、作业、目标和全部历史修订，结果一致。演练中先改变作业正文、账号名称和绑定启用状态，确认恢复确实还原这些变化。

拒绝控制覆盖：没有 --yes、校验和不匹配、校验和正确但归档内容损坏。拒绝后数据库保持演练修改后的原值。备份脚本和恢复脚本自身无需修改。

测试 Compose 的 backend 是 node:22-alpine 就绪探针夹具，用来实际验证脚本停止、启动和探测服务；它不是完整生产后端。数据正确性由真实 PostgreSQL 与 Prisma 对比验证。因此本次不代表完整生产机器的灾难恢复或备份异地可用性验证。

通过现有 `pnpm test:database` 运行，已纳入部署前数据库门槛。测试容器和网络由原 runner 的 finally 清理；临时备份和脚本副本保留供检查。本次最终演练产物位于：

`C:/Users/CHANGH~1/AppData/Local/Temp/npclassworks-restore-test-5tGeZy`

## 历史接口分页与兼容

教师及大屏的 revisions 接口支持 `limit`（默认 20，上限 100）和 `beforeRevision`（正整数游标）。返回 `{items, nextBeforeRevision}`，没有后续页时游标为 null。先执行原有读取权限检查，再按 revision 倒序查询 `limit + 1` 条；下一页使用严格小于游标，因此期间新增版本不会导致重复或移位。

完全不带分页参数时仍返回旧数组，兼容已经部署的旧 PWA。新前端调用分页接口；若部署期间遇到旧后端数组，则在客户端分页显示，旧后端仍会传输完整数组，网络收益要等新后端上线后才生效。没有新增字段、迁移或改变恢复版本的 API。

真实数据库验证教师和大屏 45 个版本按 20/20/5 分页、认证状态、非法参数、旧响应格式、期间新增版本及恢复最早版本。HTTP 测试补充读取权限、无令牌及跨班级拒绝。45 版本夹具中，教师首屏 JSON 为 15455 字节，旧响应 34777 字节；大屏分别为 15455 / 34686 字节。这是响应体样本，不是生产流量或低配设备耗时测量。

## 最终检查

- 后端 `node --test`：154 项通过，8 个数据库入口明确跳过。
- `node scripts/run-database-tests.js`：50 项通过，无失败或跳过。
- 前端 `node --test tests/*.test.js`：208 项通过。
- Chromium E2E：8 项通过，包含真实按钮翻页并从最后一页恢复旧版本。
- 前端 ESLint、生产构建、PWA 校验，以及修改文件语法与差异检查通过。

没有修改 deploy/agent/server.js，没有访问生产服务器或数据库，没有推送部署。

## 本机测试环境

Docker Desktop 启动时再次遇到失效的 dockerInference、Secrets Engine engine.sock 通信节点；停止失败进程后通过 WSL 将这些节点以及 userAnalyticsOtlpHttp.sock 改名为带 20260906-history-test 后缀的文件保留，随后引擎恢复并实际完成演练。没有恢复出厂设置、删除数据库卷或升级 Docker。
