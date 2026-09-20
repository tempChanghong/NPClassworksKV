# NPEP N1 服务端契约审查

日期：2026-09-20。状态：共同 v0.1 契约审查草案，仅文档，不代表接口已实施或通过安全测试。

范围限于配对、撤销、`device.status` 与只读设备观测。通知和模式能力只保留独立名称，N1 不批准、不实现其执行 API。前期依据见 [服务端发现](NPEP-SERVER-DISCOVERY.md)；协议主文件由 NPEduTools 任务维护于 [NPEP-N1-CONTRACT.md](../../NPEduTools/docs/npep/NPEP-N1-CONTRACT.md)，本轮已读取交叉审查，最终字段及错误码以双方核对后的主文件为准。

## 1. 总体结论

以下方向可以继续进入契约定稿：

- 必选关联有效 `screenBindingId`；首期一个 binding 同时最多一个 active NPEP installation，单交互 Windows 用户。installationId 是本地标识，不是认证证明；deviceId 由服务端生成。
- 管理操作只允许本校 OWNER / ADMIN；设备端不持有管理员令牌，不复用大屏 token、PIN、fingerprint。只批准 `device.status`，未知或未来能力要求直接拒绝，不能静默提升。
- 管理员批准后，设备现场再次核对学校、班级、设备和能力。确认必须绑定审批版本和绑定代际，不能把“管理员批准过”当作无限期授权。
- 生产 HTTPS 正常校验证书。新设备 bearer 格式、路由和校验逻辑与现有账号 JWT、大屏 token 分离。

重点补足四类约束：凭据丢响应恢复、权限与绑定的事务边界、数据库恢复后的外部代际，以及状态运行会话的 fencing。下文是实施约束，不是要求本轮修改已有产品代码。

## 2. Confirm 丢响应：建议采用设备预生成凭据

“服务端生成随机长期秘密、只存不可逆哈希、响应丢失后原样取回秘密”三项不能同时实现。双方已倾向以下方案：

1. 本地使用 CSPRNG 生成 32 字节 candidate deviceSecret 和随机 credentialId UUID，与 pairingSecret 严格分开；先经 DPAPI 持久化 candidate、confirm requestId 和审批快照，成功落盘后才允许发送 confirm。
2. HTTPS confirm 携带候选凭据与现场认可的审批版本。服务端只存验证哈希，永不在 response、日志、审计正文或错误中回显秘密。凭据形式建议 `Authorization: Bearer npep1.<credentialId>.<secretBase64url>`；编码必须规范、长度受限。
3. Confirm 的同 requestId、同规范化 payload 重试返回同一公开结果；同键不同内容返回 409。同一个 pairing 不能消费两次、生成两个 device，也不能在重试时更换 credentialId/secret。
4. Confirm 响应丢失后，用已落盘的候选凭据请求 `device/me`。成功即恢复 deviceId、serverInstanceId、generation、binding 与授权能力等公开信息，不重新签发秘密。
5. `me` 暂时 401 不能证明 confirm 永远不会提交：原请求可能仍在途。保留候选凭据，在配对期限内按相同请求重试或查询，不生成新秘密。超时不可恢复时要求重新配对；服务端已有 active 记录必须先经过正常撤销流程，不由失败重试自动替换。
6. 配对过期后不得再创建激活结果；此前已成功激活的设备仍可用 `me` 恢复。Confirm 重试只读取已有结果，不延长配对、重置状态会话、刷新 lastSeen 或复活撤销凭据。需要原 pairing bearer 鉴权的幂等重试，必须在原期限内保留配对秘密的验证哈希，仅授权同次 confirm 收据读取；若激活后立即删除该哈希，就必须改为仅支持 device/me，不能同时承诺 confirm 200 重试。

补充约束：credentialId 由客户端选取不是客户端决定 deviceId；全库唯一碰撞直接拒绝，禁止 upsert 覆盖别的设备。只从 credentialId 查候选记录后，用严格解码后的秘密校验哈希；按主契约对 32 字节随机秘密的原始字节计算 SHA-256，常量时间比较。随机秘密高熵足够时该方式可用，不把人类配对码、PIN 当作高熵秘密；不同 bearer 前缀、路由和存储记录类型必须隔离，不能互相替换认证。

`device/me` 必须只读并重新核验撤销与代际，不签发新 runtime session，不更新 lastSeen。未知或错误凭据对外统一 401，不向猜测 credentialId 的请求透露设备存在性；匹配秘密后才能返回更具体的状态或失效原因。

旧 `createAuditMiddleware` 会记录请求 body 的脱敏结果，`domain/auditLog.js` 当前正则包含 secret/token/hash，能够匹配 `candidateDeviceSecret` 这样的命名。但它不是所有日志入口的保证，也不能依赖未来字段一直使用这些名字。实施时应让配对/confirm 路由使用明确白名单审计，并验证反向代理、HTTP 客户端异常和测试日志不记录秘密。

## 3. 配对、管理员撤权与改绑竞态

### 配对状态与唯一性

- 建议状态为待批准、已批准待现场确认、已确认，以及拒绝/取消/过期终态。批准不直接创建可用设备凭据；所有阶段共享不可延长的最终过期时间。
- 人类短码仅用于管理员定位申请，不是设备秘密；查询申请详情也需要当前管理员鉴权或对应 pairingSecret，不能公开枚举学校与设备信息。
- Approve 原子限定待批准状态并记录 approver、可撤销 session、tokenVersion、schoolId、bindingId、bindingRevision、有效班级/学期与能力集合。另一管理员不得静默覆盖已有审批；N1 需取消后重建。
- Confirm 核对不可变 approvalId 对应的现场确认快照、未过期、管理员仍有权、绑定仍有效，且 bindingRevision 完全相同。旧快照不自动套用新班级。
- 一个 active installation 的约束必须有数据库唯一性保证，例如部分唯一索引或唯一 active 槽位表，并锁 binding 串行创建；不能只用“先 count 再 insert”。
- 已占用绑定返回冲突，网页明确撤销原安装后再配对；禁止凭同一 installationId 自动夺取已有设备。安装标识可被复制，安全边界始终是独立秘密和有效授权。

### 可复用的锁与必须重新检查的内容

当前 `services/schoolOwnerPolicy.js:lockSchoolManagement` 锁 School 行后重新核验管理员；`schoolMembershipService` 的成员改权/删除也采用此锁。N1 approve/confirm 应复用同一学校串行点，并在事务里继续检查：

- Account 尚存在、未 localDisabled、tokenVersion 与审批或请求凭据一致；AccountSession 未撤销、未过期且属于该账号。N1 管理操作要求可撤销 session，不能走旧 JWT 无 session 的兼容路径。
- ScreenBinding 仍属于学校、有效且绑定代际匹配；行政班与学期仍有效。学校角色、账号状态、绑定及学期变更应通过行锁或版本 CAS 与本事务形成确定顺序。
- 设备、候选凭据、配对请求未撤销或消费，唯一 active 槽位可用；创建设备、确认申请与关键审计原子提交。

实现前统一锁顺序。已有权限管理可先锁 School 再写 Account，`revokeAllTokens` 先写 Account 再写 AccountSession；建议 N1 遵循兼容的 `School → Account → AccountSession → 学期/班级 → Binding → Device/Credential → Pairing` 顺序，复核所有变更路径后确定，死锁只有限次重试，不把此顺序当作未经测试的保证。

不在事务持锁期间等待现场操作、网络或 DPAPI。现场确认在客户端先完成，事务仅处理短时数据库核验与写入。权限变更若先提交，旧请求必须拒绝；若确认先提交，后续撤权不能把历史确认改写成未发生。建议确认前撤销审批资格会使申请失效；设备激活后，单个批准人的退出登录不自动停用整台设备，管理员角色变化是否级联撤销已激活设备需明确政策，不能含糊混入“注销”。

### 绑定不能失效后自动复活

当前 `setClassroomScreenActive` 主要改布尔值，改班也不统一增加独立绑定代际。比较当前 isActive/classId 无法识别“停用后启用”或“改班后又改回”。按主契约，新增独立 NPEP `bindingRevision`：停用、改绑及班级/学期停用时单调递增，同步永久撤销旧 NPEP Device/Credential，会话随之关闭；删除/重建也不能沿用旧授权。重新启用必须重新配对并取得新 deviceId，而不是把原记录恢复 ACTIVE。`credentialGeneration` 与旧浏览器 credentialVersion 分开，N1 不开放设备原位改绑或凭据轮换。单独重置网页 PIN/token 不自动撤销 NPEP，两种管理操作需明确区分。

每次 status 写入都在同一事务复查设备、凭据与 binding 代际，再更新状态；不能先鉴权，稍后不带条件地更新。对已失效凭据拒绝写入，也不能因重试更新在线时间。

## 4. 实例备份恢复 generation

仅将 serverInstanceId / generation 存在 PostgreSQL 中不足以防备份恢复复活旧凭据：恢复时撤销记录和新 generation 会一起回滚。

建议区分稳定的逻辑 serverInstanceId 与独立于数据库备份的 deployment generation。后者必须由所有后端副本一致读取；配对申请、设备凭据、runtime session 都绑定该值，设备请求在任何业务写入前比较。数据库恢复、克隆环境和学校迁移重新启用 NPEP 前，先更换 deployment generation，使恢复出来的旧凭据不可用；普通进程重启不改变 generation。

当前 `deploy/restore.sh` 是停止后端、drop/create 数据库、pg_restore、再启动后端，并无 NPEP generation 轮换；失败清理路径也可能重新启动后端。因此 **恢复前关闭 NPEP、成功更换独立 generation 后才允许启用** 应成为实施前置条件，不能仅在成功日志之后提醒操作员轮换。

该约束需要明确运维存储及恢复入口，但本轮不修改脚本或部署代理。任意直接恢复数据库、连外部 epoch 一同回滚整机镜像、把生产秘密复制到克隆环境的情况，无法仅靠应用数据库自动辨别。契约必须写清支持的恢复流程和边界，不宣称无条件检测所有回滚。设备见过新 generation 后不得接受旧 generation 回退；新 generation 则停止旧会话并重新配对，不自动续权。

## 5. 状态 session / epoch / seq

单独的客户端 runId 或启动后从 1 开始的 seq 不能阻止旧进程迟到写入。建议：

1. 每次 Host 运行生成新的 runId，开启状态会话带 requestId 与已知 expectedStatusEpoch；服务端对当前 epoch 做 CAS，仅一个请求能建立下一 epoch。
2. 会话 epoch 由服务端分配，runtimeSessionId/字段命名以主契约为准。旧 run/session 的状态不能覆盖新会话；旧 open-session 请求重试不能重新激活已被替代的会话。
3. 同 requestId 的 session-open 重试返回原结果，仅在仍是当前有效会话时可用于上报；已经被取代则明确拒绝。不能每次网络重试都增加 epoch，也不能简单看到 runId 不同就抢占。
4. Status 使用主契约的 sessionId、statusEpoch、sequence 字段，客户端从 1 开始生成但服务端首次允许任意正序号，随后递增且允许跳号，避免丢失 sequence=1 后卡住会话。sequence 必须为安全整数且有上限；同 epoch 同 sequence、同 requestId、同内容返回原接受结果，同 sequence 不同内容或 requestId 返回 409，低 sequence 返回 409。
5. 对同 sequence 相同请求的重试 **不刷新 lastSeenAt**，返回原样本的 receivedAt，而非重试时间；只有新的合法 sequence 才更新时间。新 session 将当前状态和当前 lastSeenAt 清为未知，旧运行的最后观测仅可独立保留为历史。旧离线心跳不排队补传，恢复网络生成当前观测；sampleAgeMs 采用单调时钟，不接受客户端自行给定服务器接收时间。
6. 本地保证同运行会话不复用序号。Status 超时不重传旧样本，以新采样、更大 sequence 和新 requestId 上报；代理重传仍按 DUPLICATE 处理。Session-open 超时则重试同 requestId，不增加 epoch。崩溃后新 run 重新建会话；409 不自动循环读取最新 epoch 后抢占，只能进入“另一实例/会话冲突”处理。
7. Session-open、status、revoke 对 Device/Credential 行采用同一顺序和事务条件，撤销先提交时所有后续写入拒绝。无效上报不能建立会话，也不能改变 capabilities。

保有同一合法 secret 的复制安装仍可以尝试发起新会话，epoch 不是硬件证明或抗密钥盗取机制。首期需本地单实例锁、DPAPI 保护及人工撤销机制；不宣称服务端能区分共享秘密的两个完全相同客户端。

只读状态应使用白名单字段：版本、能力、运行模式、切换阶段、桥接可用性与采样时间。枚举允许明确 UNKNOWN，不把未知映射为正常。限制文本和请求体大小，不上传截图、录制内容、完整课表或 arbitrary runtimeStatus；N1 设备自报状态不是硬件可信证明。

## 6. 与主契约对齐的错误码

以下采用主契约命名，不再另设 NPEP_ 前缀。HTTP 状态码和客户端动作应固定，message 仅供显示，不能靠中文文案判断分支。

| HTTP | 建议业务错误 | 客户端行为 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 修正字段，不自动重试错误 payload。 |
| 401 | AUTH_INVALID / CREDENTIAL_EXPIRED | 停止状态上报；confirm 丢响应恢复期按上述边界保留候选秘密，不据此立即重建凭据。 |
| 403 | SCHOOL_ADMIN_REQUIRED / CAPABILITY_DENIED / APPROVER_NO_LONGER_AUTHORIZED | 停止操作；能力仅允许 device.status。 |
| 404 | NOT_FOUND | 跨校或不可访问资源不泄露详情；不是重配对授权。 |
| 409 | PAIRING_STATE_CONFLICT / BINDING_CHANGED / REVISION_CONFLICT | 重新展示有效状态，不能静默确认变化后的审批或自动覆盖。 |
| 409 | BINDING_OCCUPIED / CREDENTIAL_ID_CONFLICT | 不替换现有设备；credentialId 碰撞不 upsert、不覆盖已有秘密，仅同次 confirm 幂等可复用自身 credentialId。 |
| 409 | IDEMPOTENCY_CONFLICT | 相同 requestId 不得换 payload；保留原请求用于查证。 |
| 409 | SESSION_SUPERSEDED / SEQUENCE_CONFLICT / STALE_SEQUENCE | 停止旧会话上报；不自动夺取当前会话或无限提高 sequence。 |
| 410 | PAIRING_EXPIRED | 不再激活；已完成的配对可以用有效 device/me 恢复公开信息。 |
| 409 | INSTANCE_MISMATCH | 停止使用旧授权，不自动迁移到另一实例或 epoch。 |
| 413 / 429 | PAYLOAD_TOO_LARGE / RATE_LIMITED | 限制体积；按 Retry-After 和抖动退避，不延长配对期限。 |
| 426 | PROTOCOL_UNSUPPORTED | 明示协议不兼容，停止业务请求，不退回其他身份类型。 |
| 503 | TEMPORARILY_UNAVAILABLE | 不推断操作未提交；保留幂等标识与候选凭据，限次退避恢复。 |

配对尝试、申请创建、human code 查询、状态上报分别限频；错误响应带 requestId 便于审计，但不得包含 token、secret、哈希或完整原始请求。对过期 session/seq 拒绝时可返回合法设备自己的 currentEpoch 等同步提示，不泄露其他安装的秘密。

## 7. N1 实施前应覆盖的契约样例与测试

- Confirm 数据库已提交但响应断开：device/me 恢复同 deviceId；重复 confirm 不新增、不旋转凭据。
- Confirm 未提交、仍在途、配对随后到期三种情况分别处理，不能用一次 401 推断最终结果。
- 同配对两个 confirm，不同 secret 或不同 approvalRevision；同 binding 两个并发配对，唯一 active 约束成立。
- 管理员在 approve 后降权/禁用/注销审批会话、binding 改班/停用，confirm 必须重新核验。
- 停用再启用、改班再改回、学校学期停用后恢复，旧 NPEP 凭据不能复活。
- Revoke 与 status 并发，先提交的撤销使迟到状态拒绝且不刷新 lastSeen；confirm 重试亦不能复活设备。
- 旧 run 的大 seq、同 seq 改内容、丢 open-session 响应、重复旧 open 请求，不能倒退或夺回状态会话。
- 恢复旧数据库后独立 generation 已换，旧设备/配对/session 全部失效；外部 generation 未配置时 NPEP 保持关闭。
- 错误秘密/跨校查询、未来能力、超大 payload、secret 日志泄露、非 HTTPS 和异常证书均有明确拒绝路径。

本轮尚未运行这些测试，也没有新增实现或迁移。机器可检查示例只能证明样例结构与约定一致，不能替代数据库并发、凭据恢复及真实客户端验证。

## 8. 主契约交叉审查记录

2026-09-20 已读取并最终复核主文件 v0.1，复核快照 SHA-256 为 `1afd58c435e6616a6dcd5091c0432f700b2e3325fdad2b997e089dc361490d07`。此哈希标识本次确认的契约文档基线，不代表产品代码版本。后续协议修改需要对应复核。

已对齐：设备预生成候选秘密并先 DPAPI 保存、device/me 恢复、在途 confirm 的 401 边界、当前管理员会话核验、激活后普通注销不撤设备、独立 bindingRevision、恢复外部 deploymentEpoch 门禁、session CAS、不重传旧 status 样本以及首次可接收跳号。错误码采用主契约，未创建第二套协议。

结论：本次提出的契约阻塞均已闭环，当前主文档可以作为 N1 隔离环境实现基线。以下修订均已在最终主文件中核对：

1. **确认幂等的鉴权矛盾：已解决。** 主文档区分设备本地删除原始 pairingSecret 与服务端保留验证摘要至原 expiresAt；激活后配对 bearer 仅可查询激活状态或重放同次收据，不再批准、取消激活或生成新凭据。到期之后只用有效设备 bearer 恢复。
2. **重复状态接收时间：已解决。** DUPLICATE 明确返回原 receivedAt；新 session 当前 lastSeenAt=null、状态 UNKNOWN，旧观测只能独立保存为历史。
3. **候选 credentialId 碰撞：已解决。** 主文档已增加固定 409 CREDENTIAL_ID_CONFLICT，明确全局唯一、不 upsert、不覆盖已有秘密，只有同次 confirm 幂等收据可命中自身 credentialId。

已只读检查同目录 `n1-wire.schema.json`、`n1-examples.json` 均可解析，样例数量为 41；检查验证脚本使用 PowerShell 7.5 的 `-DateKind String` 保留时间字符串。41 项结构正反例全部通过的执行结果由 NPEduTools 任务提供，本端未重复执行，也不把它计作真实服务端测试。

生命周期事务改造、恢复门禁、统一锁序、真实并发回归和本地凭据保护仍是实施验收条件，本文结论不构成生产上线批准。未发现需要把通知、考试模式或任意执行提前纳入 N1 的理由。本轮没有实施任何产品功能。
