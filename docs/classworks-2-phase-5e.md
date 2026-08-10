# Classworks 2.0 第五阶段 E：账号生命周期与学期运维

本阶段在 Phase 5D 本地学校账号基础上补齐正式运行所需的管理能力，并继续保留 OAuth 邮箱模式作为学校初始化时的可选方案。

## 新增接口

### 本地账号自助与恢复

- `POST /accounts/local/change-pin`：已登录本地账号验证旧 PIN 后修改自己的 PIN，并撤销全部旧会话。
- `POST /accounts/local/recover-owner`：使用 `BOOTSTRAP_SETUP_KEY` 恢复指定学校 OWNER 的 PIN、锁定状态和登录能力。

### 学校账号管理

- `GET /api/v2/admin/schools/:schoolId/local-accounts`：列出属于该校的本地账号、学校角色、状态、最近登录和教学空间。
- `POST /api/v2/admin/schools/:schoolId/local-admins`：创建或提升第二管理员。OWNER 可创建 OWNER/ADMIN，ADMIN 只能创建 ADMIN。
- `PATCH /api/v2/admin/schools/:schoolId/local-accounts/:accountId`：修改姓名、重置 PIN、停用或启用账号。
- `DELETE /api/v2/admin/schools/:schoolId/local-accounts/:accountId`：软注销本校权限，保留历史发布内容。

保护规则包括：不得停用或注销自己；不得移除最后一名 OWNER；PIN 重置、停用、注销和应急恢复均递增令牌版本并撤销账号会话。

## 学期复制与状态

既有学期复制服务现在会一并复制：

- 年级、行政班、学科及一二班小科随班规则；
- 走班教学空间及来源行政班；
- 已认领教师成员关系；
- 尚未认领的 OAuth 邮箱邀请。

新学期保持 `DRAFT`。切换为 `ACTIVE` 时，事务内自动把同校其他启用学期改为 `ARCHIVED`。学校管理员的学校列表不再只返回启用学期，以支持归档回看和下一学期复制。

## 明文凭据边界

服务端只保存 bcrypt 哈希，任何接口都不能重新取回明文 PIN。管理端 CSV 仅使用本次提交时仍在浏览器内存中的初始/重置 PIN 生成；刷新页面后即消失。因此学校应在创建或重置后当场下载或发放，遗失时直接重置，不建立明文密码库。

## 测试覆盖

数据库集成测试使用真实 PostgreSQL 验证了：

- 初始 OWNER、第二 ADMIN、自助改 PIN 和 OWNER 应急恢复；
- 教师创建、PIN 重置、停用、启用与软注销；
- OAuth 邀请认领和未认领邀请继承；
- 学期结构、教师权限复制以及启用新学期时归档旧学期。

运行方式：

```powershell
$env:DATABASE_URL = "postgresql://..."
$env:RUN_DATABASE_TESTS = "true"
pnpm exec prisma db push
pnpm test
```

## 旧 UUID 数据范围

本校将使用新购买的服务器，原 Classworks 数据位于官方服务器，没有需要从自建实例原地升级的旧库。因此旧 UUID/KV 作业数据迁移明确排除在部署范围之外，不需要制作迁移脚本，也不应阻塞上线。

当前仍保留旧接口和表结构以保证兼容性；等新版稳定后是否清理，由后续独立阶段决定。
