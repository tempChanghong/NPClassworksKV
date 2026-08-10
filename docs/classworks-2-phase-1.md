# Classworks 2.0 第一阶段：教学组织基础层

本阶段只增加新的教学目录，不改变现有 Device、UUID、AppInstall、KV 和 Socket 工作流。

## 关键规则

行政班的每个科目必须显式声明授课模式：

- `ADMIN_CLASS`：随行政班授课，学生不选择走班。高二1班、2班的物化生使用此模式。
- `COURSE_GROUP`：该行政班的学生从关联教学班中选择，例如物理A1、化学A2。

不能仅通过“是否存在教学班”推断授课模式。显式规则能够处理实验班、小科定班和未来学期调整。

## 新增只读 API

- `GET /api/v2/catalog/schools`
- `GET /api/v2/catalog/terms/current?schoolCode=...`
- `GET /api/v2/catalog/grades?termId=...`
- `GET /api/v2/catalog/subjects?schoolId=...`
- `GET /api/v2/catalog/workspaces?termId=...&gradeId=...&type=...`
- `GET /api/v2/catalog/administrative-classes/:id/course-options`

最后一个接口是学生选班和教师空间目录的共同基础。对于高二1班物理，它返回：

```json
{
  "deliveryMode": "ADMIN_CLASS",
  "followsAdministrativeClass": true,
  "requiresCourseGroupSelection": false,
  "courseGroups": []
}
```

对于高二5班物理，它返回：

```json
{
  "deliveryMode": "COURSE_GROUP",
  "followsAdministrativeClass": false,
  "requiresCourseGroupSelection": true,
  "courseGroups": [
    {"code": "G2-PHY-A1", "name": "物理A1"}
  ]
}
```

## 数据库迁移

部署前备份 PostgreSQL，然后执行：

```bash
npx prisma migrate deploy
```

迁移只创建新表与枚举，不修改或删除旧表。示例组织数据位于：

`config/examples/high-school-organization.example.json`

本阶段尚未提供写入/导入接口。下一阶段将加入管理员导入与教师工作空间 API。
