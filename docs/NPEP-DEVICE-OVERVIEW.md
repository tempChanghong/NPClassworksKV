# 学校设备运维概览

2026-10-04。只读扩展，不修改设备状态上报协议或数据库；NPEduTools 无需随此次网页改动更新。

## 接口

`GET /api/v2/npep/schools/:schoolId/device-overview`

使用现有 `X-NPEP-Version: 0.1`、UUID `X-Request-Id` 和学校 OWNER／ADMIN 账号 Bearer 会话。部署开关、身份代际、有效账号会话与学校角色继续在事务内核验；浏览器大屏凭据、桌面设备凭据不具有此权限。响应沿用 NPEP 信封且 `Cache-Control: no-store`。

| 查询参数 | 规则 |
| --- | --- |
| `limit` | 默认 20，1–100 的十进制整数 |
| `cursor` | 上一页返回的 UUID；按设备 ID 升序继续读取 |
| `filter` | `ALL`、`ATTENTION`、`ONLINE` 或 `INACTIVE`，默认 `ALL` |
| `search` | 最多 100 个 Unicode 码点，去除首尾空白；按设备／现有大屏／有效班级名称作包含搜索 |

数组、重复参数、非法游标、额外参数等返回 `INVALID_REQUEST`。没有写入或远控操作。

`data` 返回：

- `asOf`：本次服务器观测时间。
- `summary`：本校**全部登记**的 `total`、`active`、`online`、`offline`、`unreported`、`attention`、`inactive`；不受筛选、搜索或分页影响。`total = active + inactive`，`active = online + offline + unreported`。多种检查原因只计一台设备。
- `matchedTotal`：当前筛选／搜索匹配的全部数量。
- `items`、`nextCursor`：这一页的公开设备资料及下页游标。

设备资料包括 ID、归属、绑定版本、授权状态／期限、连接观测、最近上报、原有软件状态，以及当前大屏／班级名称、`bindingChanged`、`issues`。没有凭据 ID、密钥、哈希、会话 ID、原音频或新的桌面采集内容。

## 解释规则

授权状态先核对部署身份代际、当前绑定版本、班级有效性及学期；已撤销／到期／失效不作为运行失败。历史绑定不能冒充新班级，也不按新班级名称命中搜索。

仍在授权且最近一分钟收到服务器上报为在线；没有有效上报为未上报，超过一分钟为失联。时间戳来自服务端，不能将设备未来时间当作在线。设备状态为最近观测，不代表当前进程或控制请求完成。

| `issues` | 含义 |
| --- | --- |
| `UNREPORTED` | 未收到有效上报 |
| `OFFLINE` | 最近一分钟未收到上报 |
| `MODE_NOT_READY` | 在线观测的模式未知或尚未配置 |
| `MODE_INCOMPLETE` | 在线观测的切换未完成或不可用 |
| `RECORDING_UNKNOWN` | 在线观测的录制状态未知 |
| `CLASSISLAND_NOT_CONNECTED` | 日常模式下课程桥接未连接 |
| `EXAMAWARE_NOT_CONNECTED` | 考试模式下看板桥接未连接 |

失联时只提示失联，不继续诊断历史桥接状态。日常模式下看板断开、考试模式下课程桥接断开不单独算异常。待检查不是强制拦截条件；单设备远控入口仍重新读取自身的状态和权限。

每次请求对本校登记与大屏资料做两次有范围限制、无逐台附加请求的查询，再生成同一时间的汇总和页数据。目前按校在内存中聚合，成本随该校历史登记数增长；超大规模学校后续可改为数据库投影／聚合。页面仅显式刷新与翻页，不增加自动轮询。跨页会重新读取，故不保证跨页事务快照。

## 网页兼容与验证

入口：学校管理 → 大屏设备 → 打开 NPEP 设备互联。运维计数可点击筛选，搜索需要提交。超过一分钟或刷新失败明确标注旧快照；刷新失败保留结果，权限失效清空数据。旧后端返回 404 时回退原设备列表并注明没有全校概览；重新打开面板会重试能力检查。其他错误和异常成功数据不会伪装成兼容回退。

纯规则测试：`node --test tests/npepDeviceOverview.test.js`。真实 HTTP／数据库测试包含在 `node scripts/run-native-npep-tests.js --skip-desktop` 中；该命令自行创建本机隔离 PostgreSQL 集群，不使用 Docker、不连接调试库或生产数据库。五项已有 .NET 模拟验收因显式选择 `--skip-desktop` 未运行。

完整任务与本轮结果见 [跨项目任务卡](../../NPEduTools/docs/iterations/NPEP-DEVICE-OVERVIEW-20261004.md)。
