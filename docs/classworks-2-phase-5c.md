# Classworks 2.0 第五阶段 C：学校初始化与教师分配

> Phase 5D 已新增无邮箱的教师短账号/PIN，并将其设为推荐默认方式。本文件中的邮箱预分配流程继续作为 `OAUTH_EMAIL` 兼容方案保留。

本阶段提供实际开学前需要的学校组织导入和教师排课工具。管理入口为前端 `/classworks-admin`，教师工作台也提供“学校管理”按钮。

## 组织模板

后端模板位于 `config/examples/newfires-high-school-organization.example.json`，管理页可以直接载入并编辑。模板包含高二 1 至 8 班：

- 1、2 班：语数外、物化生全部 `ADMIN_CLASS`，学生不会看到物化生走班选择。
- 3 班：示例固定历史，其余小科走班。
- 4 班：示例固定物理，其余小科走班。
- 5、6、7、8 班：示例分别固定化学、生物、地理、政治，其余小科走班。
- 每个走班科目提供两个教学班示例（A1/A2 或 B1/B2），并只关联授课模式为 `COURSE_GROUP` 的来源行政班。

三至八班的固定科目只是根据当前沟通形成的可编辑示例，不应在未核对学校实际选科组合、班级数量和教学班名称前直接导入。管理页强制先 dry-run；后端仍会在正式导入时再次完整校验。

## 教师首次登录前预分配

管理员可以按 OAuth 邮箱给尚未登录系统的教师分配行政班和走班教学班。系统写入 `WorkspaceMemberInvite`：

1. 邮箱统一转为小写进行匹配。
2. 教师首次以相同邮箱 OAuth 登录时，邀请自动转为 `WorkspaceMember`。
3. 已经登录过的教师会直接形成成员关系。
4. 相同邮箱若对应多个 OAuth 账户，批量导入会拒绝并要求先统一登录方式。
5. 已认领邀请保留认领时间；未认领邀请可以在管理页取消。

对应数据库迁移为 `20260809040000_workspace_member_invites_phase5c`。

## 管理 API

- `GET /api/v2/admin/organization/template`
- `POST /api/v2/admin/organization/import?dryRun=true`
- `POST /api/v2/admin/workspace-memberships/import?dryRun=true`
- `GET /api/v2/admin/schools/:schoolId/workspace-memberships?termId=...`
- `DELETE /api/v2/admin/workspaces/:workspaceId/invitations/:invitationId`
- `DELETE /api/v2/admin/workspaces/:workspaceId/members/:accountId`

教师批量分配示例：

```json
{
  "schoolId": "school-id",
  "termId": "term-id",
  "assignments": [
    {
      "email": "physics@example.com",
      "role": "TEACHER",
      "workspaceCodes": ["G2-C1", "G2-C2", "G2-PHY-A1"]
    }
  ]
}
```

单次最多导入 500 名教师。教学空间代码会统一大写，同一教师—教学空间出现冲突角色时整批拒绝写入。

## 推荐开学前顺序

1. 部署并执行全部 Prisma 迁移。
2. 第一个管理员完成 OAuth 登录，进入 `/classworks-admin`。
3. 载入模板，修改校名、代码、班级固定科目和实际走班教学班。
4. 预检无错误后正式导入。
5. 使用批量 JSON 按教师邮箱分配教学空间。
6. 让教师陆续登录并观察“待首次登录”标签消失。
7. 用一班、二班和一个普通走班学生视角分别验证选班和 feed。

教师邮箱必须与 OAuth 提供者实际返回的邮箱一致。没有邮箱或使用不同邮箱登录的账户不会自动认领邀请。
