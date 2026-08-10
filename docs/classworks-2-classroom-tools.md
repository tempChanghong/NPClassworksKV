# Classworks 2：课堂工具中心

Classworks 2 已成为根路由 `/` 的正式主页；`/classworks-2` 仅作为兼容跳转保留。

课堂工具中心只对已绑定的行政班大屏开放。个人学生浏览器仍然只能查看作业，不会获得名单和考勤写入能力。

## 主页与工具边界

- 新主页使用独立的纯时间卡片，不再加载旧 `TimeCard` 中的噪声、KV 报告和旧作业依赖。
- 考勤、噪声监测、随机点名和考试看板集中在“课堂工具”全屏入口。
- 随机点名与考试看板通过前端工具注册表接入，未来可以独立停用或删除。
- 噪声采样和录音分析仍只在浏览器本地执行。

## 学生名单

`AdministrativeClassStudent` 保存行政班名单，不要求学生注册账号。名单使用停用而非物理删除，避免已有考勤快照立即失去引用。

大屏接口：

- `GET /api/v2/classroom-screens/students`
- `PUT /api/v2/classroom-screens/students`

更新名单时提交：

```json
{
  "students": [
    {"studentNumber": "01", "name": "张同学"},
    {"studentNumber": "02", "name": "李同学"}
  ]
}
```

## 每日考勤

`ClassAttendanceDay` 以“行政班 + 日期”为主键，仅保存非正常状态；未出现的在册学生均视为正常到校。

大屏接口：

- `GET /api/v2/classroom-screens/attendance/:date`
- `PUT /api/v2/classroom-screens/attendance/:date`

日期格式为 `YYYY-MM-DD`，状态中的学生 ID 必须属于当前绑定行政班，且不能同时出现在多个状态中：

```json
{
  "absent": ["student-id-1"],
  "late": ["student-id-2"],
  "excluded": []
}
```

随机点名使用同一名单和当天考勤状态，因此不再依赖 Classworks 1 的 UUID/KV `studentList` 与 `boardData.attendance`。
