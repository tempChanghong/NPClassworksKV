# NPEP N3.0 服务端契约与数据设计审阅

日期：2026-09-25。状态：**设计草案，未接入运行路由、未生成迁移、未部署**。

依据：`D:/CodeProjects/NPEduTools/docs/npep/NPEP-N3-RUNTIME-CONTROL-PLAN.md` v1.0；本轮读取 KV HEAD `ebcdc74c4cd862a3fbca39b23225fdfd88e89576` 的实际实现。前端现有三项未提交 N2 变更保持原样。当前没有运行 Windows 操作或访问生产设备。

## 1. 审阅结论与冻结程度

用户已定范围：单设备、固定 EXAM/CURRENT_RUNTIME；启动已配置 ExamAware2、目标就绪后正常退出指定 ClassIsland；独立暂停后续自动录课；不停止现有录制，不修改 Windows 自启动；现场一次许可，服务器不能代开。N1 0.1 / N2 0.2 原样保留。

协调任务已认可并要求补入的六项原则：

1. 本地许可增加持久递增修订，旧重传不能覆盖新关闭。
2. 已批准开始后失联不直接判 EXPIRED，更不能释放未解决槽位。
3. 当前上传会话与原执行会话分开；允许有依据的历史补报，禁止重启续跑旧许可。
4. outcome 与 resolvedAt 分开；现场处理不把历史 PARTIAL/FAILED 改写成成功。
5. 正式开始在同一短事务复核创建者当下账号、会话、学校角色和设备绑定；不能先锁 Device 再反向锁 Account。
6. N3 状态使用独立序号，不占用 N1 lastSequence。

本稿的路由名、字段拼写、枚举、数量限制和保存期限仍是**建议冻结值**。协调任务另已采纳独立 controlEpoch（现有恢复互联不保证更换 N1 会话）。其持久顺序规则、运行观察枚举、旧凭据失效后未解决任务的现场关联规则，以及执行权限模型，仍需双端共同冻结。不得仅因文档和 Schema 校验通过就认为 HTTP 或 Windows 行为已实现。

## 2. 现有实现可复用与不能照搬之处

| 当前文件/实现 | 核实情况及 N3 要求 |
| --- | --- |
| routes/v2/npep.js | 只有 N2 两个通知端点显式选 0.2，其余默认 0.1。N3 要按完整路由族分派 0.3，覆盖尾斜杠和大小写，与 Express 匹配一致；未知路径拒绝。 |
| domain/npep/wire.js | 可复用严格 JSON、重复键/非法 Unicode 拒绝、UUID、canonical digest、有限错误 envelope；不修改 N1 schema 或全局 capabilities。 |
| services/npepService.js transaction | 已核验数据库/外部部署代际，事务提交前再读外部门闩；可抽取共用，不能在持锁期间等 HTTP、IPC、UAC。 |
| device / withDevice | 已锁 School→Term→Workspace→Binding→Device，核验凭据及绑定；withDevice 回调只拿 tx/device。N3 start 还需 Account/AccountSession，不能在回调末尾反向加锁；应抽出按统一顺序调用的内部步骤。 |
| administrator / schoolOwnerPolicy | 管理操作需有效 session，当前角色 OWNER/ADMIN；School 锁与成员改权共用。N3 不用配对时审批人代替操作创建人。 |
| NpepDevice | statusEpoch/sessionId/lastSequence 属于 N1，credentialGeneration 当前固定为 1；N3 不假设已存在凭据原位轮换。 |
| NpepSessionReceipt | 能核验 runId→sessionId/statusEpoch，但当前记录会在凭据过期后清理。N3 任务须保存执行上下文快照，历史账本不能依赖该表永远存在。 |
| NpepMaintenanceService | 会删除过期 Device、SessionReceipt 和 90 天审计。N3 未解决账本不能跟随 Device 级联消失；清理需单独设计和回归。 |
| 通知快照/回执 | N2 与 N3 独立；通知正文不作为命令。不能把 N3 授权塞进通知 popupEnabled 或 ACK。 |
| 路由 P2002 映射 | 目前统一映射 CREDENTIAL_ID_CONFLICT。N3 的活动槽位、requestId/eventId 冲突须按实际约束映射，不能沿用该笼统错误。 |

## 3. 公共 wire 类型与身份

所有 N3 路由前缀 `/api/v2/npep`，`X-NPEP-Version: 0.3`。设备沿用 npep1 bearer；管理端沿用有效账号 JWT+session。HTTPS、禁止自动跨源重定向、Cache-Control:no-store。服务端绝不使用请求中的 origin 来选择服务器或代理转发。

GET 使用 X-Request-Id；POST body.requestId，若同时给 header 则必须一致。所有对象拒绝未知字段。UUID 为小写 UUID v4；计数为 JSON safe integer（0..9007199254740991，不接受浮点/字符串）；时间为 UTC ISO 8601，以服务器时钟为授权基准。所有文字长度按 UTF-16 code units；Schema 的 maxLength 不能独自表达此限制，样例校验命令补查。

成功 envelope：`{protocolVersion:"0.3",requestId,serverTime,data}`；错误与 N1 字段一致：`{protocolVersion,requestId,serverTime,error:{code,message,retryAfterSeconds}}`。message 为固定安全代码，不能带堆栈、路径、SQL、令牌。

### 3.1 身份快照 Identity

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| serverInstanceId / deploymentEpoch | UUID | 现有门闩与数据库实例，必须同时匹配。 |
| deviceId | UUID | 凭据对应设备，不能凭 body 指向其他设备。 |
| bindingRevision | safe integer ≥1 | 当前 NPEP 绑定代际，不是网页 credentialVersion。 |
| credentialGeneration | integer=1 | 当前 N1 仅有代际 1；未来轮换需另立兼容变更。 |

origin 只留在本地许可身份中，做规范化 origin 精确比较（scheme/host/port）；不上传也不允许 body 更改。schoolId/adminClassId/screenBindingId 由服务端从设备导出，再作为命令快照返回。

### 3.2 当前上传上下文 UploadContext

`{identity,runId,sessionId,statusEpoch,controlEpoch}`：前三个会话值验证当前 N1 会话映射；controlEpoch 是独立本地控制周期 UUID，Host 启动、暂停/恢复互联时更换。它不代表用户重新许可，也不允许服务器更换本地周期。

协调任务已确认现有恢复互联不保证更换N1会话，因此保留controlEpoch。Host先原子落盘新controlEpoch和递增policyRevision，再允许联网创建/开始；暂停先设置本地阻止标志，落盘失败维持禁用。恢复同步新周期并获服务端确认前不得执行。控制周期不是UUID大小可排序，顺序依赖下一节policyRevision；本地未执行旧任务作废但历史账本保留，开始过/未知的只核实。

## 4. 路由及逐字段定义

### 4.1 POST /device/runtime-control-policy

请求：`{requestId,context,policy:{consentId,policyRevision,enabled,supported}}`。

| policy 字段 | 类型/规则 |
| --- | --- |
| consentId | UUID；首次初始化关闭也有 ID；每次本地开/关均新生成，重传不重生成。 |
| policyRevision | ≥1，绑定身份内持久递增。开关/支持变化及controlEpoch更换均递增；相同修订只允许相同policy+controlEpoch，小于已接受修订拒绝 POLICY_STALE。 |
| enabled | Boolean，本地持久化成功后的实际值；服务器不存在 enable 管理接口。 |
| supported | Boolean，当前程序是否支持固定 N3 行为；升级/降级能力变化也推进 policyRevision。 |

响应：`{disposition:APPLIED|DUPLICATE,consentId,policyRevision,receivedAt}`。digest覆盖policy+controlEpoch，不含传输requestId；相同内容重传不续签任何开始许可。只换控制周期时consentId保持，开关改变才必须换consentId。不得使用 UUID 大小或 occurredAt 判断哪个政策更新。关闭立即本地生效；服务端接到关闭后未授权任务转 REJECTED/CONTROL_DISABLED；已授权任务保留原记录并显示取消执行后续动作的建议，等待设备证据，不伪报取消成功。

本地 policyRevision 账本丢失时默认关闭，不能通过“服务器镜像=true”恢复许可；重新现场允许前须解决修订初始化。建议读取服务端修订下界后只允许本地显式确认建立更高修订，不能静默把旧 enabled=true 提交到新代际。

### 4.2 POST /device/runtime-status

请求：`{requestId,context,sequence,sampleAgeMs,status}`。sequence≥1，仅 N3 当前上传会话+controlEpoch递增；同序号相同 digest 为 DUPLICATE，同序号异内容冲突，旧序号拒绝。状态必须匹配已接受policy的controlEpoch，旧周期不能覆盖新周期。重传不刷新服务器 receivedAt。sampleAgeMs 0..60000，保守包含排队年龄；同序号重传保持原body，新样本需新序号，不得把历史样本包装为新鲜。

| status 字段 | 类型/含义 |
| --- | --- |
| runtimeMode | UNKNOWN / OTHER / EXAM（建议）；OTHER 不声称“日常自启动”。 |
| runtimePhase | UNKNOWN / IDLE / SWITCHING / WAITING_LOCAL / EXAM_READY / RECOVERY_REQUIRED。 |
| runtimeRevision | safe integer ≥0；本地独立运行状态修订。 |
| modeRevision | safe integer ≥0 或 null；旧模式修订只用作冲突保护，不改其含义。 |
| configurationRevision | safe integer ≥0；本地相关软件配置修订，不上传实际路径/配对密钥。 |
| consentId / policyRevision | 对应已同步政策；不匹配不能作为可执行状态。 |
| remoteExamPause | Boolean，仅 N3 来源暂停；不替代调度器其他暂停。 |
| recording | IDLE / STARTING / RECORDING / PAUSED / FINALIZING / UNKNOWN；N3 可新增 STARTING，不能扩张 N1 原枚举。 |
| desktop | INTERACTIVE / LOCKED / SECURE_DESKTOP / UNKNOWN。 |
| noticeOpen | Boolean；N2 遮罩或通知窗口占用。 |
| operationId | UUID 或 null，当前本地未解决账本；不准据此隐式创建远程任务。 |
| observedAt | UTC，客户端观测时间，仅诊断，不作为租约时钟。 |

响应：`{disposition,acceptedSequence,receivedAt,nextPollSeconds}`。idle=10，活动=2（建议）。服务端 sampleAsOf=`receivedAt-sampleAgeMs`；创建要求 N3 同一当前会话/周期的新鲜样本 ≤60 秒，N1 lastSeenAt 不足以替代。正式开始仍重新验证本地读回值。

### 4.3 POST /schools/{schoolId}/devices/{deviceId}/runtime-operations

请求所有字段：`requestId,target:"EXAM",scope:"CURRENT_RUNTIME",expectedRuntimeRevision,expectedModeRevision,expectedConfigurationRevision,consentId,policyRevision,controlEpoch`。modeRevision 不可为 null。禁止未来执行时间、路径、参数、能力名、switchRunning、自启动布尔和 ExamWorkSaved。

服务端创建 UUID operationId，createdAt，expiresAt=createdAt+300s；从 JWT/session 保存创建者 accountId/sessionId/tokenVersion/tokenExpiresAt（只内部保存，不返回 JWT）。创建时要求有效设备、学校/绑定、支持/许可、新鲜状态、所需修订一致且无未解决操作。记录创建者 displayName 快照（≤120），仅显示、永不反推权限。

201 返回 OperationView；同 requestId 同内容且同创建者返回原对象 200，同 ID 异内容或异创建者返回 409 IDEMPOTENCY_CONFLICT。幂等键设备+requestId；再次响应不重置 expiresAt。必须先核验当前读权限，再返回历史幂等结果。

### 4.4 GET 管理列表/详情与设备列表

管理列表路径与创建相同；详情追加 `/{operationId}`。新增建议 `GET /schools/{schoolId}/devices/{deviceId}/runtime-status`，返回 `{policy,status,receivedAt,sampleAsOf,connectivity,unresolvedOperationId}`；不向 N1 严格设备列表强塞 N3 字段。policy/status 未收到时为 null，connectivity=UNKNOWN；旧客户端不可操作。

历史列表默认 20、最大 50；limit+cursor 外无参数。响应 `{items:[OperationView],nextCursor}`。游标≤512字节，服务端签名/校验并绑定 schoolId/deviceId/query，上界首轮 createdAt，排序 `(createdAt,id)` 降序；后续不混入更新插入，非法/跨设备游标 400。详情独立读最新进展，列表不承诺多页状态内容的强快照。

`GET /device/runtime-operations` 无查询参数，返回 `{items:[],pollAfterSeconds}`，最多一个未解决操作。身份核验后只返回本设备，GET 不消费任务、不创建 grant。对于已关闭许可或已授权旧任务，允许返回历史/未解决记录供核实，不代表允许执行。结果为空不能让本地删除未上传账本。

OperationView 精确字段：

| 字段 | 类型/说明 |
| --- | --- |
| operationId / deviceId / requestId | UUID；requestId 为创建幂等标识。 |
| identity | 创建时 Identity，和设备凭据身份精确对应。 |
| schoolId / administrativeClassId / screenBindingId | Opaque ID 1..191，服务端确定。 |
| target / scope | 固定 EXAM / CURRENT_RUNTIME。 |
| consentId / policyRevision / controlEpoch | 创建时许可和本地控制周期。 |
| expectedRuntimeRevision / expectedModeRevision / expectedConfigurationRevision | ≥0。 |
| initiator | `{displayName}`，≤120 UTF-16；不公开 accountSession/tokenVersion。 |
| createdAt / expiresAt | UTC；expiresAt 仅最晚开始，不是执行终止时刻。 |
| state / step / reasonCode | 见状态机；step/reasonCode 可 null。 |
| lastEventSequence | ≥0；设备账本已接受序号。 |
| progressReceivedAt | UTC 或 null，不用客户端 observedAt伪造在线。 |
| grant | StartGrant 或 null；历史 grant 不是可续期指令。 |
| evidence | Evidence 或 null，客户端观察，不是服务端自行推断。 |
| resolvedAt / resolutionId | UTC/UUID 或 null；与执行 state 独立。 |
| localEndedAt | UTC或null，现场结束N3暂停的上报时间；不等于任务resolvedAt。 |
| freshness | CURRENT / STALE / UNKNOWN；60秒失联只改变呈现，不改写已知结果。 |

### 4.5 POST /.../{operationId}/cancel

管理端请求 `{requestId}`，当前任何本校 OWNER/ADMIN 可以取消尚未授权操作。与 start 在同一操作锁下仲裁；已授权返回 409 START_ALREADY_AUTHORIZED；不把取消请求传成远程关闭软件。未授权但已过期返回原 EXPIRED。响应 OperationView；已取消重试返回原结果，不改取消人和时刻。

### 4.6 POST /device/runtime-operations/{operationId}/start

请求：`{requestId,context,consentId,policyRevision,expectedRuntimeRevision,expectedModeRevision,expectedConfigurationRevision}`。context.controlEpoch 必须是创建时周期；设备先持久接收、原子拿到本地空闲保留权并完成只读核验，再调用本接口。请求不包含任意“允许哪些程序”的参数。

服务端锁下复核当前有效凭据/绑定、旧会话未替换、本地镜像、全部修订、未取消/未过期、创建者当前 session/角色/tokenVersion，以及原创建 JWT 未过期。创建者刷新令牌不能由设备暗中替换创建时 session/token。失败无许可，设备释放临时保留权，不执行副作用。

StartGrant 所有字段：`{grantId,operationId,identity,consentId,policyRevision,runId,sessionId,statusEpoch,controlEpoch,expectedRuntimeRevision,expectedModeRevision,expectedConfigurationRevision,authorizedAt,startNotAfter}`。

grantId UUID 不作为独立 bearer；只能在当前已认证设备+对应上下文使用。startNotAfter=`min(operation.expiresAt,authorizedAt+30s)`，存入数据库后固定不变。重复 start 返回原 grant；不同 requestId 也不能创建第二个 grant。任何后续权限/会话核验失败都不能再返回一个被描述为“可执行”的许可。

响应 `{grant,serverTime}`；serverTime 每次响应新生成，grant.authorizedAt 不变。客户端用收到响应时单调时钟计算保守剩余时间：`max(0,startNotAfter-serverTime-本次完整RTT)`，首次副作用前再次检查。不得用缓存响应的旧 serverTime延长截止。Host重启、控制周期改变后即使还有剩余时间也禁止复用。

每次派发本地后续软件操作前复核本地取消标志/开关、实际配置、身份与保留权；UAC返回后同样复核。已观察到撤销则停止未派发步骤，保留真实 PARTIAL。无法在线得知的撤销不能瞬间撤回已发 grant，也不能逆转已完成动作。

### 4.7 POST /device/runtime-operation-events

请求 `{requestId,context,events}`，events 1..20，总 UTF-8 body ≤64KiB。context 是**当前上传会话**；每个事件另有原执行上下文。

事件逐字段：

| 字段 | 类型/说明 |
| --- | --- |
| eventId / operationId | UUID，持久一次生成。 |
| sequence | ≥1，操作级连续递增，重启不归零。 |
| state | RECEIVED / CHECKING / RUNNING / WAITING_LOCAL / SUCCEEDED / REJECTED / FAILED / PARTIAL / UNKNOWN；不能由设备直接产生 START_AUTHORIZED/CANCELLED/EXPIRED。 |
| step | PAUSE_RECORDING / PREPARE_EXAM / CLOSE_CLASSISLAND / VERIFY 或 null。 |
| reasonCode | 有限枚举或 null。 |
| occurredAt | 设备 UTC，诊断；服务端另记 receivedAt。 |
| execution | `{runId,sessionId,statusEpoch,controlEpoch,grantId}` 或 null；未授权前为 null，有执行证据时必须与原 grant匹配。 |
| evidence | 见下表，可为 null（仅未开始早期阶段）。 |

Evidence 全字段：`{examAware:READY|NOT_READY|UNKNOWN,classIsland:EXITED|RUNNING|UNKNOWN,remoteExamPause:boolean,startup:NOT_REQUESTED,sideEffects:NONE|POSSIBLE|APPLIED,alreadySatisfied:boolean,observedAt,configurationRevision}`。只能陈述观察和本任务副作用，不能上传路径/任意异常；alreadySatisfied 不能掩盖实际上新写入的暂停。

响应 `{results:[{eventId,status:ACCEPTED|DUPLICATE|REJECTED,code:null|Reason,acceptedSequence}]}`。每事件原子落库并更新 projection；批次允许部分成功，按输入顺序处理，不允许跳过缺口推进。相同eventId+原始完整payload重复接受；同eventId异内容或同sequence异内容冲突；未来sequence缺口返回 SEQUENCE_GAP 和 acceptedSequence，先补前项。老事件不能覆盖新状态。

重启后使用新上传 context 补报旧 execution 只用于核实同一任务；原 runId/grant 不变，事件序号接续。服务器只允许 UNKNOWN→有依据结果，或重复/在丢失前序列补齐期间保存原记录；不能把新会话的 RUNNING 当作继续执行旧任务。撤销凭据后一律拒绝，新凭据不能接管旧设备执行许可。

### 4.8 新增建议：POST /device/runtime-operations/{operationId}/resolve

这是**现场结束/核实的结果上报**，不是远程恢复接口；没有对应学校管理 POST。请求 `{requestId,context,resolutionId,expectedLastEventSequence,kind:"LOCAL_END",noPendingActions:true,evidence,occurredAt}`。noPendingActions来自本地协调器确认，没有它不能释放未知槽位；只是受信Host声明，不是服务器能远程证明Windows没有动作。本地已完成核实、账本保存和现场结束后再发送；重复只返回原 resolution，expectedLastEventSequence 冲突不能覆盖新进展。

服务端只对同设备未解决 UNKNOWN/PARTIAL/FAILED 及成功后的现场结束记录resolutionId/localEndedAt/evidence，保留原state与原执行evidence；现场证据存Resolution表。未解决任务据有效现场核实填写resolvedAt，成功任务已存在的resolvedAt不得覆盖。禁止在 RUNNING/WAITING_LOCAL 直接 resolve。UNKNOWN需本地证据说明无正在派发/待返回动作；若无法确认则不释放槽位。Evidence.remoteExamPause=false、startup=NOT_REQUESTED，现场结束仍不代表其他录课暂停已解除。

响应 OperationView。离线现场结束先落本地记录，服务器未收前仍保守占槽；之后只补报事实，不重做软件动作。服务端无法用设备凭据区分真实人类点击与被篡改客户端，此接口依赖受信 Host 本地交互边界，不能宣称是硬件证明。

## 5. 状态机及幂等仲裁

| 当前状态 | 可去往 | 判定来源与槽位 |
| --- | --- | --- |
| QUEUED | RECEIVED、REJECTED、CANCELLED、EXPIRED | 服务端创建；无 grant 时可以取消/过期，终态释放。 |
| RECEIVED | CHECKING、REJECTED、CANCELLED、EXPIRED | 持久接收不等于执行。 |
| CHECKING | START_AUTHORIZED、REJECTED、CANCELLED、EXPIRED | 授权仅由 start事务；只读拒绝无副作用。 |
| START_AUTHORIZED | RUNNING、WAITING_LOCAL、SUCCEEDED、REJECTED、FAILED、PARTIAL、UNKNOWN | REJECTED仅设备可证明尚无副作用；授权后静默不能由服务端猜未执行。 |
| RUNNING / WAITING_LOCAL | RUNNING、WAITING_LOCAL、SUCCEEDED、FAILED、PARTIAL、UNKNOWN | 分项证据核验，步骤不得倒序，WAITING_LOCAL不反复弹UAC。 |
| UNKNOWN | UNKNOWN、SUCCEEDED、FAILED、PARTIAL、REJECTED | 仅同任务后续核实，禁止转回RUNNING/重放；无充分证据保留未知。 |
| SUCCEEDED / REJECTED / FAILED / PARTIAL / CANCELLED / EXPIRED | 本state的重复事件 | 不回退、不把现场修复改写成功。现场resolve独立记录。 |

授权是单独持久事实；state为UNKNOWN或PARTIAL也保留grant。成功要求 examAware=READY、classIsland=EXITED、remoteExamPause=true、startup=NOT_REQUESTED、配置修订正确。HTTP成功、开始许可、进程启动请求均不满足此条件。

FAILED仅能确认本任务无变更（sideEffects=NONE）；已写暂停即属于APPLIED，后续软件失败是PARTIAL。任何POSSIBLE副作用均保留未解决槽位。FAILED是否需现场核实由evidence/本地账本决定，不用state字符串单独决定resolvedAt。

无grant且到期可原子EXPIRED；有grant但未见首次动作时，只能标结果待确认或UNKNOWN，不能以30秒/5分钟时限释放。60秒失联只改变freshness；不要将N1在线心跳当作运行操作进展。UNKNOWN可保持未解决直到明确结果或现场resolve。

竞态线性化：cancel先提交→start拒绝；start先提交→cancel冲突。撤权先提交→start拒绝；start先提交→无法逆转历史授权，本地在下一次观察到撤权时停止后续派发。服务端与本地独立检查共同保证，而不是承诺网络分区下即时撤回。

## 6. 数据模型建议（无迁移）

| 新表 | 字段及约束 |
| --- | --- |
| NpepRuntimePolicy | deviceId PK，身份快照、consentId UUID、policyRevision BIGINT、enabled/supported Boolean、policyDigest CHAR64、currentControlEpoch UUID、uploadSessionId/statusEpoch、receivedAt。政策修订持久，不随着新会话归零。 |
| NpepRuntimeStatus | deviceId PK，runId/sessionId/statusEpoch/controlEpoch、sequence BIGINT、digest、status JSONB、receivedAt/sampleAsOf。新会话N3状态清空/标UNKNOWN，绝不继承旧状态新鲜度。 |
| NpepRuntimeOperation | id UUID PK；deviceId/schoolId/binding等身份快照；requestId/createDigest；initiatorAccountId/sessionId/tokenVersion/tokenExpiresAt/name；目标/修订/许可周期；createdAt/expiresAt；state/step/reason/evidence；lastEventSequence；progressReceivedAt；resolvedAt/resolutionId。唯一(deviceId,requestId)。 |
| NpepRuntimeStartGrant | operationId PK；grantId UNIQUE；固定全部StartGrant字段、startRequestId/digest；authorizedAt/startNotAfter。只插入一次，重复读不能UPDATE截止。 |
| NpepRuntimeOperationEvent | eventId UUID PK；operationId+sequence UNIQUE；payloadDigest；原始有限字段JSONB；execution快照；receivedAt。与projection同事务。 |
| NpepRuntimeResolution | resolutionId UUID PK；operationId UNIQUE；device/上传身份快照、kind、evidence、occurredAt/receivedAt、digest。不能覆盖原终态。 |
| NpepRuntimeRequestTombstone | deviceId+requestId PK、createDigest、operationId、creatorId、已结束结果摘要；供归档后幂等，不把旧请求当新任务。 |

N3计数数据库用BIGINT或精确数值并CHECK 0..MAX_SAFE_INTEGER；Prisma BigInt不可直接JSON.stringify，wire显式验证再转number。现N1 Float列保持不动，不借本轮大范围改类型。

使用部分唯一索引 `UNIQUE(deviceId) WHERE resolvedAt IS NULL` 强制一台设备一个未解决操作。QUEUED起即占槽；确定无副作用的终态以及成功结果原子填写resolvedAt；PARTIAL/UNKNOWN保留null；不要只按state NOT IN终态列表建唯一索引。成功后N3暂停仍然持久存在，resolvedAt表示本任务不再阻塞队列，不是解除暂停。

索引建议：Operation(schoolId,deviceId,createdAt DESC,id DESC)、Operation(expiresAt) WHERE grant不存在（实现可用startAuthorizedAt冗余列并一致约束）、Event(operationId,sequence)、所有可清理表receivedAt。JSON只存固定受限对象，不存任意命令/程序路径。

历史账本保留独立UUID与身份快照，不依赖对Device的ON DELETE CASCADE；未解决任务必须阻止相应账本清理。N1清理过期设备仍可进行，但需要确保N3历史独立保留且被呈现为旧设备任务，不授予新设备历史执行权。若Device外键选RESTRICT，必须同步改清理过滤，否则一条未解决记录使整批维护事务失败。建议历史表不作删除级联，policy/status只对活设备级联。

保留期建议：详细已解决事件180天；任务/许可/结果摘要365天；未解决任务及事件不自动过期；请求墓碑至少保留至对应设备永久失效后90天。禁止在有效设备期间删除墓碑后重新执行旧requestId。超容量明确拒绝新增，不静默移除未解决记录。具体期限属于待冻结运营参数。

## 7. 锁顺序与事务核验

建议统一：School→相关Account（ID排序）→AccountSession（ID排序）→AcademicTerm→Workspace→Binding→Device→Policy/Status→Operation→Grant/Event/Resolution。详情、历史可以只读；创建/开始/取消/现场resolve需对应锁。先无锁读取候选ID仅作定位，锁后重读并验证全部关联，不能沿用锁前布尔结果。

start需要操作创建者Account/Session；cancel需要当前管理者，若同时读取创建者则按统一排序。学校角色变更以School作为共同串行点；账号停用/全会话撤销与Account/Session锁相容。正式实现必须与绑定停用、班级/学期停用和N1 revoke路径做真PG竞争测试，不能因本稿给了顺序就宣称已无死锁。

数据库事务只管验证与记录；不得持锁等设备、UAC或远程HTTP。批量事件每项有限短事务；死锁/序列化冲突可有限重试纯数据库动作，不能自动重派设备动作。路由在事务前做一次鉴权用于限流时，事务内仍必须再核验。

策略关闭/变代、设备撤销、会话替换处理未授权任务时，与start共享同一Operation/Device仲裁。不以异步清理作唯一保护；start必须比较当前值。N3清理与N1备份恢复测试需包含全部新表，尤其引用Device的新表不能被部分pg_dump遗漏。

## 8. 限制、错误与审计建议

POST一般16KiB，事件64KiB/20项；设备任务最多1项。活动轮询2秒，idle10秒；建议设备poll60/min、status60/min、policy12/min、start12/min、events60/min，管理create10/min/账号及cancel30/min。429遵循Retry-After+jitter，不能阻断本地账本或UAC等待进展。

| HTTP | code |
| --- | --- |
| 400 | INVALID_REQUEST / UNSUPPORTED_TARGET / UNSUPPORTED_SCOPE |
| 401 | AUTH_INVALID / AUTH_REVOKED / CREDENTIAL_EXPIRED |
| 403 | SCHOOL_ADMIN_REQUIRED / INITIATOR_NO_LONGER_AUTHORIZED |
| 404 | NOT_FOUND（跨学校/非所属任务不泄漏存在） |
| 409 | CONTROL_DISABLED / POLICY_CHANGED / POLICY_STALE / CLIENT_UNSUPPORTED / DEVICE_OFFLINE / DESKTOP_UNAVAILABLE / NOTICE_OPEN / RECORDING_BUSY / STATE_CHANGED / OPERATION_BUSY / RECOVERY_REQUIRED / CONFIGURATION_DRIFT / SESSION_SUPERSEDED / START_ALREADY_AUTHORIZED / IDEMPOTENCY_CONFLICT / SEQUENCE_CONFLICT / SEQUENCE_GAP / INVALID_TRANSITION |
| 410 | EXPIRED（仅无grant的开始过期；不得据此抹去本地执行账本） |
| 413 / 426 / 429 / 503 | PAYLOAD_TOO_LARGE / PROTOCOL_UNSUPPORTED / RATE_LIMITED / TEMPORARILY_UNAVAILABLE |

设备业务结果reason另允许EXAMAWARE_NOT_READY、CLASSISLAND_EXIT_UNAVAILABLE、UAC_CANCELLED、STORAGE_UNAVAILABLE、AUTH_REVOKED、UNKNOWN_RESULT。结果错误放在事件reason而非借HTTP500表示正常业务失败。审计记录创建、开始许可、取消、政策变更、结果和现场resolve；不记录token、路径、考试内容。文字仅显示为纯文本。

## 9. 设计样例验证与后续验收

设计 Schema：`docs/npep-n3/runtime-control.schema.json`；正反例：`examples.json`。在KV目录执行：

```powershell
node docs/npep-n3/validate-examples.mjs
```

验证命令只加载docs内Schema/样例，复用已安装Ajv，不启动服务器、不连数据库、不修改产品代码。Schema通过只证明结构与UTF16边界，不能证明权限、互斥、状态机或本地副作用正确。semanticCases只列后续必须实现的数据库/设备用例，不把它们计为已运行。

本次迁移后的node_modules junction仍指旧WebstormProjects，普通命令首次因缺Ajv失败。因此仅在临时目录安装Ajv 8.20.0和ajv-formats 3.0.1，未修改项目依赖或链接；设置 `NPEP_SCHEMA_VALIDATION_ROOT=$env:TEMP\npep-n3-schema-validation-20260925` 后实际运行通过 **29/29结构及UTF-16正反例，36项定义编译成功**。10项语义场景明确未执行。`generate-examples.mjs`仅为docs内Schema/样例生成器，重生成后须再次校验。

N3.2至少覆盖：旧N1/N2契约不变；双管理员创建唯一槽位；cancel/start先后顺序；grant丢响应不续签；policy关闭/重开乱序；暂停/恢复旧任务；创建者降权/注销与start并发；60秒无进展不误释放；Host重启新会话补旧结果但不续跑；相同事件重传/同序异内容/缺口；PARTIAL现场resolve保留结果；维护清理和备份恢复保留未解决账本；事务外网络/UAC；零自启动写入、零任务创建删除。

真机验收还需单台Windows实际UAC、已配置ExamAware2/ClassIsland和录制竞态；本稿没有这些证据。

## 10. 待双方冻结清单

1. 独立controlEpoch已采纳；其更换与policyRevision原子递增、同步确认前禁止开始、旧周期补报只读核实等逐字段规则待双端冻结。
2. runtimeMode/phase、configurationRevision的本地确切来源及类型；STARTING在N3独立出现。
3. resolve的具体本地入口与“没有挂起动作”证据；不能用网络API伪造人类现场证明。
4. 原凭据撤销/重新配对后，旧UNKNOWN/PARTIAL如何现场归档并关联新身份：本稿默认**不能用新凭据清旧任务/再执行**，需另定有限恢复路径；不能临时加网页强制成功按钮。
5. 创建JWT过期但会话仍有效时是否一律拒绝start：建议保守拒绝，管理员刷新后新建；不默默迁移创建者会话。
6. 上述路由字段、错误、限流/容量/保存期限以及权限执行模型（整体管理员Host或受限辅助组件）；本轮未冻结、未写迁移。
