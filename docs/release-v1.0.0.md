# NPClassworksKV v1.0.0 · Nijika（伊地知虹夏）

NPClassworksKV v1.0.0 是 NPClassworks 的首个正式配套后端版本，提供学校组织、账号权限、作业通知、班级大屏和运维管理能力。

## 主要变化

- 从旧 KV 数据接口升级为基于 PostgreSQL 与 Prisma 的学校业务数据模型。
- 增加学校、学期、年级、行政班、教学班、学科和教学关系管理。
- 增加学校管理员、年级组长、班主任和任课教师的职责叠加与授权范围。
- 支持本地短账号、PIN/口令登录、大屏独立账号及可选 OAuth 配置。
- 增加作业与通知、教师确认、修订历史、重复检测和乐观并发控制。
- 支持教师多班发布，以及各目标班级后续独立修改。
- 增加通知送达记录、大屏心跳、离线提交和大屏值守审计。
- 增加后端 OOBE、组织与教师 JSON 导入、可视化管理接口和完整学期切换流程。
- 增加学校迁移包、自动备份、恢复、升级和回滚工具。
- 支持同源或独立 API 域名部署，并增加 CORS 与生产环境检查。
- 增加带签名鉴权的部署代理，无需向 GitHub Actions 提供 SSH 密码。
- 停用不再使用的 Classworks 1 接口、UUID 登录流程和旧设备服务。

## 部署与升级

- 推荐与 NPClassworks 前端 `v1.0.0` 配套部署。
- 新实例应从空数据库启动，通过 OOBE 创建学校和生产管理员账号。
- 升级早期测试实例前，必须先备份 PostgreSQL，再执行数据库迁移。
- 非 Docker 部署需要自行配置 Node.js 22、pnpm 10、PostgreSQL、进程守护和反向代理。
- 生产环境必须正确设置公开地址、前端来源、数据库连接和登录密钥。

详细步骤见[新手部署教程](./beginner-deployment-guide.md)和[自动部署说明](./automatic-deployment.md)。

## FAQ

### NPClassworksKV 是 ClassworksKV 的直接替代品吗？

不是直接替换。它源自 ClassworksKV，但数据结构、接口、权限和部署方式均已大幅调整，旧前端不能直接连接本版本。

### 能迁移原公共 Classworks 实例的数据吗？

本版本不提供旧 UUID 作业数据迁移。学校迁移工具用于 NPClassworks 实例之间的数据转移。

### 必须使用 Docker 吗？

不是，但 Docker Compose 是当前文档覆盖最完整的部署方式。手动部署需要由维护者自行处理依赖、数据库迁移、守护进程、HTTPS 与备份。

### Novark Power 会提供托管后端吗？

目前及可预见的较长时期内不会提供面向公众的官方实例。部署者需要自行维护服务器、数据库、域名、HTTPS 和备份。

## FullChangeLog

[查看后端完整变更：b01c2c2...v1.0.0](https://github.com/tempChanghong/NPClassworksKV/compare/b01c2c25987985d28adfef7045c26d9884236617...v1.0.0)

> Compare 链接会在仓库创建 `v1.0.0` 标签后生效。

## 致谢

感谢 ClassworksKV 原作者及贡献者为后端提供基础。

NPClassworksKV 由[星火动力（NOVARK POWER）](https://novark.ink/)维护，遵循 GNU AGPL-3.0 许可证。
