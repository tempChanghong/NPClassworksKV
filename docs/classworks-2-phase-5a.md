# Classworks 2.0 第五阶段 A：上线前业务加固

本阶段解决正式部署前最容易影响学校实际使用的业务问题。

## 教师多设备会话

- 每次 OAuth 登录创建独立 `AccountSession`。
- 刷新令牌原文只返回客户端，数据库保存 SHA-256 摘要。
- 访问令牌和刷新令牌均携带 `sessionId`。
- `/accounts/logout` 只撤销当前设备会话。
- `/accounts/logout-all` 增加账户 tokenVersion 并撤销全部设备会话。
- 迁移前签发的 `Account.refreshToken` 仍可在过渡期刷新。

上线前必须执行：

```bash
pnpm exec prisma migrate deploy
```

对应迁移为 `20260809030000_account_sessions_phase5a`。

## 定时发布与自动失效

公开 feed 除当前内容外还返回 `nextTransitionAt`，其值是所选教学空间中：

- 下一条计划发布内容的 `publishAt`；
- 下一条当前可见内容的 `expiresAt`；
- 两者中更早的时间。

前端据此在边界刚过后重新读取 feed，无需在后端运行常驻定时任务。

## 验证

本阶段增加会话载荷、令牌摘要和时间边界的领域测试。真实数据库上的多设备登录、当前设备登出和全部登出仍应在部署阶段使用 PostgreSQL 集成测试覆盖。
