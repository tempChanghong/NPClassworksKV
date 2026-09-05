# 大屏新增作业的幂等提交

`POST /api/v2/classroom-screens/publications` 接受可选的 `clientRequestId` 字段（1–100 位字母、数字、下划线或连字符）。前端在首次提交前生成该 ID，离线队列持久化并在自动、手动重试中复用它。旧队列以已有队列项 ID 作为稳定标识。

服务端在完成大屏目标权限校验后，按「大屏绑定 ID + clientRequestId」获取 PostgreSQL 事务锁，检查创建记录。首次创建、修订快照和请求身份在同一事务中保存，并有复合唯一索引兜底。同一请求的并发/后续重试返回已有作业，不增加作业、修订或重复广播创建事件。

请求内容采用规范化 JSON 的 SHA-256 摘要校验。同一 ID 的不同内容返回 `409 PUBLICATION_REQUEST_CONFLICT`。`allowDuplicate` 只代表确认提交，不参与内容摘要；业务重复检查首次拒绝后，可用原 ID 确认重试。不同大屏的同名 ID 相互隔离。

创建身份与 `latestScreenBindingId` 分开保存，教师修订、认证或撤回不会改变它。重试返回当前作业状态，不覆盖后续编辑。不带 ID 的旧客户端继续工作，但不具备此项幂等保证。升级前已成功创建且未记录 ID 的请求，无法追溯补建对应关系，仍由重复作业检查保护。

现有双域名自动部署无需手动执行迁移：两个仓库的 GitHub main 推送触发部署代理，代理运行 `deploy/ci-deploy.sh`，调用 `upgrade.sh` 拉取两个仓库各自的 `origin/main`，备份数据库、构建并启动应用。后端 Docker 启动命令先执行 `prisma migrate deploy`，成功后才启动服务，升级脚本随后检查 `/ready`。`newfires.top` 与 `api.newfires.top` 的域名分离不改变这一过程。

本次前后端修改都需要提交到对应仓库，尤其要包含后端迁移文件。新增迁移 `20260905000000_screen_publication_idempotency` 仅增加可空列和索引；生成的 Prisma Client 已同步。只有绕开现有 Docker 启动流程进行自定义部署时，才需要另行执行迁移。

验证：`pnpm test` 包含请求标识/摘要测试；`pnpm test:database` 在隔离 PostgreSQL 中验证并发创建、响应重试、内容冲突、修订后重试、绑定隔离与失败回滚后的确认重试。
