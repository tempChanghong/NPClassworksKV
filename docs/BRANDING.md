# NPClassworksKV 图标

本服务与 NPClassworks 使用同一暖橙 NPEP 标志：主色 `#D97732`、深折面 `#A94E24`、浅书页 `#F2B56B`。NPEduTools 继续使用青绿。

## 本仓入口

- `public/favicon.ico`：16、24、32、48、64、256 六帧 RGBA，前五帧采用小尺寸简化结构。
- `public/branding/logo-small.svg`：真实贝塞尔路径、透明背景，用作 SVG favicon。
- `public/branding/logo.svg`：与前端标准版相同的产品标志资产。
- `views/index.ejs`、`public/auth-success.html`、`public/auth-error.html` 均引用同一 SVG favicon 和 ICO。

没有独立 PWA manifest、Apple touch、maskable 或应用安装界面，因此未新增这些入口；状态／认证结果的内容与业务行为未改变。README 中的星火动力组织署名和标志保留。

可编辑 AI、完整 SVG／PNG、安装图标、青绿与暖橙对照图及制作说明位于相邻 NPClassworks 仓库的 `images/branding/`，不在两仓重复存放大型母版。

## 验证

隔离 Express 静态资源／EJS 模板夹具返回三张页面，favicon 链接正确；ICO 与两份 SVG 均返回 200，SHA-256 与 NPClassworks 母版导出相同。服务状态页在本地 Edge 中正常显示。未启动生产配置、数据库或 KV 业务服务；本仓无网页构建步骤。

保留 `codex/npep-n1-server` 原有 N1 和本地发布审核文档提交；发布准备复核已将图标改动整理为本地功能分支提交，未推送，未修改 main、部署代理、NPEP 开关或发布流程。当前资源与前端母版及原 HTTP 验证记录的 SHA-256 再次核对一致，三张页面引用也已复核；托管 CI 仍需针对新的最终提交运行。
