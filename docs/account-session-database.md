# 单会话退出的真实数据库回归

新增 `tests/accountSessionDatabase.integration.test.js`，使用实际 `/api/accounts/profile`、`/refresh`、`/logout` 路由、JWT 鉴权和 Prisma，不替换数据库方法。独立 pg 连接核对已提交记录。

覆盖同一账号的两个独立会话：

- 退出前，两份 access 可用，第一份 refresh 和临期自动续签可用。
- 第一份会话退出返回成功后，AccountSession.revokedAt 已提交；第二份会话整行不变，账号 tokenVersion 不变。
- 已退出会话的原 access、临期 access、退出前自动续签与 refresh 换出的 access 都返回 401，无新令牌响应头；refresh 和再次退出也被拒绝。
- 拒绝请求不会修改或复活已撤销会话；第二份会话仍可访问和刷新，并持久化 lastUsedAt，未额外创建会话。

## 执行与部署门槛

运行后端 `pnpm test:database`。新文件已加入 `scripts/run-database-tests.js` 的显式清单；现有 quality 与 production-deploy 工作流均运行该命令，生产 deploy 依赖 verify。因此推送这些改动后，新用例失败会阻止该次后端部署。没有修改工作流、部署代理、业务逻辑或数据库结构。

测试默认跳过；启用时，在导入 Prisma、加载 dotenv 或连接数据库之前，要求 DATABASE_URL 指向回环地址，且库名为 npclassworks_test 或其测试后缀。仅创建并清理本次随机账号及其级联会话，不清空数据库。

## 本轮验证（2026-09-07）

- 新用例和数据库运行脚本语法检查通过，git diff --check 通过。
- 后端 `node --test`：168 项通过、0 失败、12 个数据库入口跳过，包含本次新增入口。
- 显式启用新用例并分别传入远程地址、非测试库名，均在建立连接前被安全校验拒绝。
- 本机 Docker 引擎未运行，未启动 Docker Desktop，未执行 PostgreSQL 场景；新增用例尚待 GitHub CI 实测，不将编写完成或默认跳过表述为数据库验证通过。

此用例验证退出提交后发起的新请求，不宣称中断已经通过鉴权的在途业务请求，也不改变历史无 sessionId 令牌的兼容范围。没有推送、触发部署或访问生产服务器。

## 后续 PostgreSQL 实测（2026-09-07）

用户启动 Docker 后，通过前端的全链路运行器，在新建的隔离 PostgreSQL 17 数据库上应用全部已有迁移，再实际执行本文件对应的 accountSessionDatabase.integration.test.js：1 项通过、0 失败、0 跳过。随后三个浏览器全链路场景也全部通过。

这补齐了前文因 Docker 未运行而缺失的单会话持久化实测。通过时后端代码为 1bbb1e11fac90faeb415b24c947ef07a193b0d28；未修改后端业务代码或数据库结构。测试容器和网络已清理，未连接生产数据库。完整记录见前端 docs/fullstack-smoke-tests.md 的“Docker 启动后的完整实测”。本次没有运行后端完整 test:database 清单。
