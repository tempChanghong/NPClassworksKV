# Classworks 2.0 第二阶段：配置写入与教师空间授权

本阶段在第一阶段教学目录上增加学校管理员、组织导入、学期生命周期和教师教学空间成员关系，仍不切换旧 KV 作业发布流程。

## 首次初始化与组织导入

第一个导入学校配置的登录账户自动成为该学校 `OWNER`。系统已有学校后，新学校不能通过普通导入创建；已有学校只能由 `OWNER` 或 `ADMIN` 更新。

先执行 dry-run：

```http
POST /api/v2/admin/organization/import?dryRun=true
Authorization: Bearer <account-jwt>
Content-Type: application/json

{ ...config/examples/high-school-organization.example.json... }
```

校验通过后移除 `dryRun=true` 正式写入。导入以学校、学期、年级、科目和教学空间代码为稳定键执行 upsert。导入文档中出现的行政班科目规则、教学班来源关系会按文档替换；文档中完全省略的旧教学空间不会自动删除。

## 一、二班规则

一、二班小科必须配置为：

```json
{"PHY": "ADMIN_CLASS", "CHE": "ADMIN_CLASS", "BIO": "ADMIN_CLASS"}
```

如果某个走班教学班把一、二班列为来源，同时该科目仍为 `ADMIN_CLASS`，导入校验会返回 `DELIVERY_MODE_CONFLICT` 并拒绝写入。

## 学期管理

- `POST /api/v2/admin/terms/:termId/status`，Body：`{"status":"ACTIVE"}`
- `POST /api/v2/admin/terms/:termId/clone`

启用一个学期时，同校其他 ACTIVE 学期自动归档。复制学期会复制年级、教学空间、授课规则、来源班级关系和教师成员，旧 Device 绑定不会复制。

## 教师教学空间

- `PUT /api/v2/admin/workspaces/:workspaceId/members`
- `DELETE /api/v2/admin/workspaces/:workspaceId/members/:accountId`
- `GET /api/v2/me/workspaces`
- `GET /api/v2/me/schools`

添加成员可按 `accountId` 或邮箱：

```json
{"email":"teacher@example.com", "role":"TEACHER"}
```

教师登录一次后，可以通过 `/api/v2/me/workspaces` 获取当前学期内自己有权操作的所有行政班和教学班。

## 学校管理员

- `GET /api/v2/admin/schools/:schoolId/members`
- `PUT /api/v2/admin/schools/:schoolId/members`
- `DELETE /api/v2/admin/schools/:schoolId/members/:accountId`

`OWNER` 和 `ADMIN` 可以维护学校配置；只有 `OWNER` 可以授予或移除其他 `OWNER`，并且系统禁止移除最后一个 `OWNER`。
