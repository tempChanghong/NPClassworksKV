# 真实数据库权限撤销验证（2026-09-05）

## 结果

使用隔离 PostgreSQL 17、实际 Express 路由、JWT 鉴权和 Prisma 查询验证，未替换数据库方法。

| 场景 | 验证结果 |
| --- | --- |
| 停用大屏 | 数据库 isActive 持久化为 false；旧令牌的 session/feed/students 和补传均拒绝 |
| 解绑设备（reset-device） | tokenHash 改变、deviceFingerprint 清空、credentialVersion 增加；旧令牌拒绝 |
| 管理员降为 VIEWER / 移除成员 | 实际 SchoolMember 更新/删除；原 JWT 调用管理读取、修改学校、重置大屏均为 403，学校和设备数据保持原值 |
| 撤销先提交，补传已鉴权但仍等待请求锁 | 修改前停用与解绑两种情况均返回 201 并创建作业；修复后返回 SCREEN_TOKEN_INVALID / 401，不新增作业或修订 |
| 相同请求 ID 的旧重放 | 撤销后不会直接返回历史成功结果；在事务内先校验当前绑定 |
| 没有 clientRequestId 的旧上传 | 同样在写入前校验，不依赖幂等路径 |
| 补传先取得授权锁 | 该事务可完成一次写入；撤销等待其提交后生效，之后旧令牌请求拒绝 |

并发测试通过外部 PostgreSQL 事务持有 advisory/table 锁，再用 pg_stat_activity 与 pg_blocking_pids 确认真实查询正在等待。没有靠固定 sleep 猜测两个请求的先后，也没有修改生产方法来插入暂停钩子。所有请求、锁等待和测试均设有时间界限。

## 修复

`services/screenWriteAuthorization.js` 提供共享核验：大屏创建/补传、修改作业（包括多目标拆分）、恢复历史以及保存考勤，都在业务写入事务内取得 ClassroomScreenBinding 行的 FOR SHARE 锁，核对 isActive、tokenHash、credentialVersion 和 administrativeClassId，然后才执行幂等重放查询或创建作业与修订。

该锁持续到事务结束，因此停用或换发令牌与该次业务写入有明确顺序。多个普通上传可同时持有共享锁；撤销更新需要等待已经取得该锁的上传完成。输入验证仍在写入事务之前，减少锁持有时间。没有新增表、字段或迁移，没有更改请求/响应格式。

## 运行方式与 CI

在后端运行 `pnpm test:database`。现有脚本创建独立 Compose 项目，将 PostgreSQL 数据放在 tmpfs，仅绑定本机端口，覆盖 DATABASE_URL 后应用已有迁移；结束时移除本次测试容器和网络。新增测试还要求显式启用 RUN_DATABASE_TESTS，数据库只能是回环地址且名称为 npclassworks_test 或其测试后缀。

默认 `pnpm test` 明确跳过需要数据库的测试，不会把跳过计为通过。现有 `.github/workflows/quality.yml` 已运行 `pnpm test:database`，新增文件已加入脚本清单。本次未修改生产部署工作流或部署代理。

本机最终结果（Node 24.14.1，PostgreSQL 17）：

- `node --test`：153 项通过，6 个数据库测试入口明确跳过。
- `node scripts/run-database-tests.js`：38 项通过、0 跳过，包含原有 12 个撤销子场景和本轮新增的 20 个写入并发子场景。
- 原有并发幂等、OWNER 并发降权、审计和大屏命令、学校迁移、账号与任课关系流程均通过。
- 修改文件语法检查和 git diff --check 通过。

全库回归还修正了旧集成测试的夹具假设：硬编码 20 个班级改为核对实际导入的完整 ID 集合；物理走班来源改为从示例数据中选择真实来源班；已有两份作业时，复制断言检查两份内容并选择教师可确认的物理副本。没有为适配测试修改教学权限逻辑或示例配置。

## 验证边界

本次并发修复覆盖大屏创建/补传及复用创建服务的复制、修改作业、多目标拆分、恢复历史、考勤新增和更新。没有验证所有其他写入接口与撤销同时发生的情形，也不据此保证已进入执行过程的管理员写请求一定被中断。管理员测试覆盖撤销提交后旧 JWT 发起的新请求。

没有访问生产数据库、没有部署或推送。测试所用迁移均为已有迁移，此次改动不要求新增迁移或手动修改服务器。

## 本机 Docker 启动故障

测试准备阶段，本机 Docker Desktop 4.71.0 因失效的零字节通信节点无法启动。退出失败进程后，通过现有 WSL 将 dockerInference、Secrets Engine 的 engine.sock、userAnalyticsOtlpHttp.sock 改名为带时间戳的 .stale 文件保留；失败重启中新生成的 dockerInference 也作了相同处理。最终 Docker Engine 29.4.1 恢复，并实际完成了全部临时数据库测试。

未恢复出厂设置，未修改镜像、已有容器或数据库卷。相同错误在 Docker 官方项目的问题追踪中有用户复现记录：https://github.com/docker/desktop-feedback/issues/448 。本次恢复未升级 Docker，不能保证该旧版本以后不再遇到此问题。

## 后续写入并发验证（2026-09-05）

在请求已通过鉴权、尚未进入业务写入时，通过外部事务阻塞 Subject、PublicationRevision 或 AdministrativeClassStudent 查询，先完成管理员停用或 reset-device，再释放请求。修复前，普通修改、恢复历史、考勤新增和更新在这两种撤销后仍返回 200。修复后全部返回 SCREEN_TOKEN_INVALID / 401，完整作业、目标、修订或考勤数据库快照保持不变。

新增 20 个子场景覆盖两种撤销操作 × 五种写入（普通修改、多目标拆分、恢复历史、考勤新增、考勤更新）× 两种锁顺序。写入先持锁时，观察撤销确实等待当前写事务；释放后正常写入返回 200，撤销随后完成，旧令牌再次调用返回 401。多目标拆分核对原作业、副本和历史；原有版本冲突和通知/认证内容权限逻辑保持不变。

复现阶段的多目标拆分夹具最初缺少第二班级科目规则，导致 422；补齐规则后用于修复后的正反向验证，因此不将该初始失败计为该分支的漏洞复现证据。其他四种写入已有修复前真实 HTTP / PostgreSQL 证据。

命令：先对修改服务执行 node --check，再运行 node scripts/run-database-tests.js，最后 node --test；结果分别为语法通过、38/38 数据库测试通过、153 项普通测试通过并明确跳过 6 个数据库入口。独立只读审查未发现授权范围内具体可证实的绕过或新增回归。本轮未新增迁移、未改部署代理、未访问生产服务器。