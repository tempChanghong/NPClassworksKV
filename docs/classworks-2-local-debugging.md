# Classworks 2.0 本地完整调试

调试环境固定使用独立的 `npclassworks-debug` Compose 项目、`postgres-debug-data` 卷和 `classworks_debug` 数据库，不接触未来生产数据。

## 初始化与启动

在 NPClassworksKV 中运行：

```powershell
pnpm run debug:init
pnpm run debug:db:up
pnpm run debug:prepare
pnpm run debug:server
```

另开一个终端，在 NPClassworks 中运行：

```powershell
pnpm run dev
```

打开：

- 管理页：`http://localhost:3031/classworks-admin`
- Classworks 作业板：`http://localhost:3031/`

如果浏览器曾经访问过本地前端，请先清除 `localhost:3031` 的站点数据，以免旧 localStorage 覆盖 `.env.local` 中的后端地址。

Vite 会把 API、健康检查和 Socket.IO 从 3031 同源代理到本地后端3000，行为与生产环境的 Caddy 路由一致；浏览器不需要直接跨端口访问后端。

## 固定调试账号

所有账号的学校代码都是 `DEBUG-SCHOOL`。

| 身份 | 短账号 | PIN | 权限 |
|---|---|---|---|
| OWNER | `admin` | `260100` | 学校初始化与全部管理功能 |
| 备用管理员 | `backup-admin` | `260102` | 日常学校管理 |
| 一班教师 | `class1-teacher` | `260101` | 高二1班行政班 |
| 走班教师 | `walk-teacher` | `260103` | 高二3班与物理A1 |

这些账号只能用于本机调试，不要复制到生产环境。

## 停止

停止后端和前端终端后，在 NPClassworksKV 中运行：

```powershell
pnpm run debug:db:down
```

该命令保留调试数据库卷，方便下次继续。不要对生产 Compose 使用 `down -v`。
