# 当前业务运行指标与开发入口

## 指标

后端 `/metrics` 继续沿用现有访问控制，未改抓取配置或服务器代理。新增指标：

| 指标 | 用途 |
| --- | --- |
| classworks_http_requests_total | 按 method、route、status 统计完成/中断请求 |
| classworks_http_failures_total | 4xx、5xx 和连接中断；409 等业务拒绝也在内，应按状态区分 |
| classworks_http_request_duration_seconds | 请求结束/连接断开时的耗时直方图，可按接口查看延迟分布 |
| classworks_socket_connections | 当前实际 Socket.IO 连接数，非独立设备数，也不代表已鉴权大屏数 |

route 只使用固定挂载前缀和 Express 路由模板，例如 `/api/v2/publications/:publicationId`，不含 ID、查询参数或凭据；未匹配请求归入 unmatched，异常方法归入 OTHER。finish 与 close 事件共同保证请求只统计一次；中断状态标为 aborted。`/metrics` 抓取本身不计入请求指标。

Socket.IO 连接由实际连接和断开事件增减。指标不查询或扫描业务表；删除了启动时读取旧 Device/KVStore 计数的逻辑及三个旧指标：classworks_online_devices_total、classworks_registered_devices_total、classworks_keys_total。如果已有外部面板引用旧名称，需要调整查询；本次没有修改或配置外部监控系统。

指标保存在当前进程内，重启后重新计数；部署有多个实例时需由采集端聚合。本次不新增大屏唯一在线率、离线积压或数据库备份监控。

## 本地开发

在后端先执行 `pnpm debug:init`、`pnpm debug:db:up`、`pnpm debug:prepare`，然后 `pnpm dev`。新命令使用 Node 22 自带的 `--watch` 与 `--env-file=deploy/.env.debug`，通过 scripts/dev-server.js 设置 development 并加载实际 bin/www。支持 Windows 与 Linux，无需 nodemon 或 shell 环境变量赋值。

缺少调试环境文件时明确失败；不会通过 dev 命令创建数据库或自动运行迁移。`pnpm start` 和 `pnpm debug:server` 的行为不变。

## 验证

2026-09-07：3 项真实 HTTP/Socket 指标测试通过；后端普通测试 171 项通过、0 失败、12 个数据库入口跳过。开发脚本语法检查通过，未启动实际开发数据库或生产服务器。无需新增数据库迁移，未改 deploy/agent/server.js，未推送或部署。
