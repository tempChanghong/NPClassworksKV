# Classworks 2.0 第三阶段：统一发布与学生订阅

本阶段把作业和通知统一为 `Publication`，一条内容可同时发布到多个教学空间。旧 UUID/KV 接口和数据不删除，便于先在测试班试运行，再逐步切换前端。

## 数据结构

- `Publication`：正文、类型、科目、发布时间、截止时间、优先级、状态和修订号。
- `PublicationTarget`：发布内容与行政班、走班教学班或通知频道之间的多对多目标关系。
- 类型：`ASSIGNMENT`（作业）、`NOTICE`（通知）。
- 状态：`DRAFT`、`PUBLISHED`、`WITHDRAWN`。
- 每次修改递增 `revision`；更新和撤回必须提交旧修订号，防止两个老师页面互相覆盖。

## 一、二班与走班规则

规则不依赖“班号”硬编码，而依赖第一阶段导入的 `AdministrativeClassSubject.deliveryMode`：

- 高二1班、2班的物化生是 `ADMIN_CLASS`，作业直接选行政班，可一次同时选1班、2班。
- 其他班某小科是 `COURSE_GROUP` 时，不能把该科作业发给行政班，接口返回 `COURSE_GROUP_TARGET_REQUIRED`，必须选择物理A1、化学A2等具体教学班。
- 教学班的 `subjectId` 必须与作业科目一致，否则返回 `COURSE_GROUP_SUBJECT_MISMATCH`。
- 语数外继续发布到行政班。
- 通知可以不选科目，并可同时投递到行政班和教学班。

这使一、二班即使存在同名走班组，也不会被系统要求重复选班；其他班则不会误收不属于自己的小科作业。

## 教师接口

所有接口使用账户 JWT：

- `GET /api/v2/publications`：查看自己发布的内容；传 `workspaceId` 可查看某教学空间。
- `POST /api/v2/publications`：创建草稿或正式发布。
- `GET /api/v2/publications/:id`：读取详情，同时返回 `ETag: "<revision>"`。
- `PATCH /api/v2/publications/:id`：修改内容。
- `POST /api/v2/publications/:id/withdraw`：撤回。
- `POST /api/v2/publications/:id/clone`：复制成新草稿，可改目标、科目和时间。

创建示例：

```http
POST /api/v2/publications
Authorization: Bearer <account-jwt>
Content-Type: application/json

{
  "type": "ASSIGNMENT",
  "subjectId": "<physics-subject-id>",
  "title": "物理周末作业",
  "content": "完成练习册第 10—12 页",
  "status": "PUBLISHED",
  "publishAt": "2026-08-09T08:00:00+08:00",
  "dueAt": "2026-08-11T07:30:00+08:00",
  "targetWorkspaceIds": ["<class-1-id>", "<class-2-id>"]
}
```

修改时使用详情响应中的修订号：

```http
PATCH /api/v2/publications/<publication-id>
Authorization: Bearer <account-jwt>
If-Match: "3"
Content-Type: application/json

{"content":"更正：完成第 10—13 页"}
```

若内容已被别处修改，返回 HTTP 409 和 `PUBLICATION_REVISION_CONFLICT`，客户端应刷新后让老师确认，而不是静默覆盖。

## 学生自行选班

学生端先通过第一阶段目录选择一个行政班，再按该班的 `course-options` 选择需要的走班教学班。选择结果只需保存在浏览器本地，无需创建学生账号。

公开 feed：

```http
GET /api/v2/publications/feed?workspaceIds=<admin-class-id>,<physics-a1-id>,<chemistry-a2-id>
```

接口最多接受20个当前学期教学空间，只返回：

- 状态为 `PUBLISHED`；
- 已到 `publishAt`；
- 尚未到 `expiresAt`（或未设置失效时间）的内容。

公开响应不包含教师邮箱，也不会返回草稿或已撤回内容。多个目标命中同一条发布记录时只返回一次。

## 实时协同

Socket.IO 客户端发送：

```js
socket.emit("join-workspaces", {workspaceIds});
```

服务端校验这些空间属于当前启用学期后加入房间。创建、更新和撤回会发送 `publication.created`、`publication.updated`、`publication.withdrawn`。事件只含发布 ID、状态、修订号和更新时间；客户端收到后重新拉取 feed，正文始终以 HTTP/数据库结果为准。

## 部署顺序

1. 备份 PostgreSQL，并先完成第一、二阶段组织配置 dry-run。
2. 部署后端并执行 `pnpm exec prisma migrate deploy`，应用第三阶段迁移。
3. 用学校管理员账户导入组织、配置教师教学空间权限。
4. 先接入教师发布页，在少量班级验证创建、修改、撤回和多目标发布。
5. 再接入学生选班与公开 feed；旧作业板继续读取原 UUID/KV 数据，直到新链路验收完成。
6. 观察一至两周后再决定旧数据迁移和旧入口下线，不在本阶段直接删除旧表或旧接口。

第三阶段迁移文件为 `prisma/migrations/20260809020000_publications_phase3/migration.sql`。
