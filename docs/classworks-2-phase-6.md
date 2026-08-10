# Classworks 2 Phase 6：大屏协作录入、版本备份与教师认证

## 目标

- 行政班一体机可录入本班随行政班授课的科目。
- 存在走班科目的行政班一体机可选择本年级对应科目的走班教学班。
- 一、二班如果全部科目随行政班，系统自然只提供本行政班目标，不依赖硬编码班号。
- 教师账号发布或修改的版本自动认证；大屏保存的版本默认未认证。
- 每次保存产生不可覆盖的 `PublicationRevision` 完整快照。
- 教师认证当前快照；大屏再次修改后，新快照自动变为未认证。
- 恢复历史只创建新版本，不覆盖或删除任何仍在保留期内的历史。

## 大屏绑定

学校 OWNER/ADMIN 在已选择行政班的浏览器上点击“绑定为本班大屏”。服务端生成随机 256 位令牌，只在绑定响应中返回原文，数据库只保存 SHA-256 摘要。个人学生浏览器没有令牌，仍然只能查看作业。

大屏允许的目标由组织配置计算：

- `ADMIN_CLASS`：只能选择绑定的行政班，并且所选科目的 `deliveryMode` 必须为 `ADMIN_CLASS`。
- `COURSE_GROUP`：必须与绑定行政班同学期、同年级，并且该行政班的所选科目必须为 `COURSE_GROUP`。
- 每次大屏保存只能选择一个教学空间，避免一次误操作批量影响多个班。

## 认证与恢复

- `Publication` 保存当前生效快照和当前认证状态。
- `PublicationRevision` 保存版本号、完整快照、录入来源、认证人和恢复来源。
- 教师认证不改变内容版本号，只把当前版本与该版本记录标为已认证。
- 大屏修改任何已认证内容会创建新版本，并清空当前认证状态。
- 大屏恢复已认证历史时，因为内容逐字来自不可变快照，认证状态可以继承。
- 乐观锁继续使用 `If-Match`；过期页面保存会返回 `PUBLICATION_REVISION_CONFLICT`。

## 三天清理策略

服务启动后 30 秒执行一次检查，之后每 24 小时执行一次。仅满足以下全部条件的历史正文会被清理：

1. 未认证；
2. 不是当前版本；
3. 创建时间超过三天；
4. 类型为单科作业；
5. 该快照的全部目标教学空间均已停用。

系统保留版本号、时间、来源、科目、目标和 `purgedAt` 审计壳。认证版本、当前版本、通知以及仍启用教学空间的版本不会自动清理。设置 `PUBLICATION_REVISION_CLEANUP_DISABLED=true` 可关闭定时任务。

## 主要接口

- `POST /api/v2/admin/schools/:schoolId/classroom-screens/bind`
- `GET /api/v2/classroom-screens/session`
- `POST /api/v2/classroom-screens/publications`
- `PATCH /api/v2/classroom-screens/publications/:id`
- `GET /api/v2/classroom-screens/publications/:id/revisions`
- `POST /api/v2/classroom-screens/publications/:id/restore`
- `GET /api/v2/publications/:id/revisions`
- `POST /api/v2/publications/:id/certify`
- `POST /api/v2/publications/:id/restore`
