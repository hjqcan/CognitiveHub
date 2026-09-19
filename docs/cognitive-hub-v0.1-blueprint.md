# Cognitive Hub：意图驱动的执行运行时

版本：设计草案 v0.1  
资料核对日期：2026-09-19  
定位：以 Jev 为首个快速判断后端，连接人类／慢思考系统与数字、物理执行端的通用中间件。

> 本文是架构提案，不是已实现的软件或经过 Jev 实测的性能报告。所有示例接口、阈值策略、模块与验收门槛均为建议设计。Jev 的已知能力来自文末官方资料。未调用付费 API，未操作用户的任何外部系统。

## 1. 核心决策

不把产品做成一个“Jev SDK 包装层”，也不先做无所不能的 Agent 平台。核心产品是一个可持久化的委托运行时：接收目标、边界和验收标准；在允许的能力中选择下一步；执行并检查事实；必要时请求新的慢思考。

慢思考来源可以是人、生成式模型、领域规划器或组织审批流程。生成内容与重新规划是两个独立需求：填写一个自由文本字段未必需要重新规划，重新规划也未必需要生成长文本。

Jev-first，但公共协议不绑定 Jev。首版实现 JevDecisionProvider；ReplayDecisionProvider 用于无联网测试；以后可增加其他判断后端，不能不经评测沿用原阈值。

北向原语：Intent、GoalGraph、DeliberationRequest、IntentPatch。南向原语：Observation、Capability、BoundAction、ExecutionReceipt、VerificationEvidence。

## 2. 范围与非目标

v0.1 面向有限动作空间、有可检查结果、能够限制副作用的软件任务。首个域为仓库 Issue 分类与内部草稿整理；第二个域为测试目录内的文档归类，验证核心复用。

不承诺任意自然语言自动形成正确程序、不做任意 shell 执行、不默认自动安装未知工具、不提供直接伺服控制、不把模型概率视为业务成功率或安全保证。

对于开放目标，Hub 明确请求人或规划器补充里程碑，而不是伪造一个完整计划。对于确定性规则，优先直接执行规则，不强行调用模型。

## 3. 三种输入模式

### 3.1 有界自然语言委托

人输入“将这个仓库的新 Issue 分为 bug、feature、question，信息不足的进入人工复核；不要关闭 Issue，也不要公开发评论”。

Hub 根据已安装域包形成委托草案：已知标签映射、作用范围、允许操作、补充信息模板与完成条件。模型可以选择模板和已有资源引用；最终授权来自已认证用户及策略系统，而不是模型生成的字段。

### 3.2 结构化委托

用户、现有系统或慢思考模型直接提交符合协议的 IntentContract。自然语言不是必须步骤。

### 3.3 开放目标

例如“把产品增长做好”不具备足够明确的可执行边界。Hub 产生持久化的 DeliberationRequest，要求提供目标拆分、资源范围、预算及可检查里程碑。人类不需要写代码，但不能省掉真正不存在的业务判断。

## 4. 合同与授权分离

IntentContract 描述“希望完成什么”。AuthorizationGrant 描述“确实允许做什么”。二者不能合并为模型可以自行填写的一个对象。

IntentContract 的最小信息：

| 字段 | 语义 |
|---|---|
| id / revision | 委托标识与修订版本 |
| objective | 人类可阅读的目标 |
| mode | 一次性达成，或有期限的持续维持 |
| scope | 资源引用和边界，不接受无范围的全局操作 |
| milestones | 里程碑、依赖、绑定的验收器 |
| allowedCapabilities | 请求使用的能力；仍受实际授权二次约束 |
| constraints | 业务禁区与先后条件 |
| budgets | 决策调用、动作数量、时间等硬预算 |
| reviewPolicy | 何时请求确认、澄清或新规划 |
| policyRef | 服务端绑定的已批准策略版本 |

“不得关闭 Issue”不能仅保留在提示词中。执行许可系统必须拒绝 issue.close，即使模型建议关闭。

持续性委托必须有过期、暂停和撤销机制。改变目标会生成新 revision，并使旧版本的待执行决策失效。已发生的外部效果不会因为修改委托而自动消失。

## 5. 能力不是裸工具名称

CapabilityManifest 包含输入／输出 schema、资源类型、前置条件、预期效果、效果级别、所需权限、验证器、重试语义、取消语义及可选补偿操作。

MCP 或 OpenAPI 导入只能提供部分结构信息。工具描述中的“只读”“可回滚”等声明需要信任审查；不能把未知服务器的自述作为强制授权依据。

建议效果分类：read、local_draft、reversible_write、external_commit、physical、unknown。分类只是策略输入，不是安全证明。读取也受数据边界与外发策略约束；unknown 默认不能无人批准执行。

能力示例：issue.add_labels。参数包括一个实际存在的 Issue 引用与标签引用。执行前检查仓库范围、标签存在性、当前策略和资源状态；执行后重新读取标签确认。不能通过覆盖整个标签集合来误删用户已有标签。

## 6. 参数绑定：保证决策可以落地的关键

| 参数类型 | 来源 |
|---|---|
| enum / bool | Jev 选择；重要缺失值必须有 not_stated / unknown |
| 动态实体 | 当前观测、搜索或资源目录产生候选，返回候选 ID |
| 原文片段 | 程序提取带 sourceId 与 offset 的候选片段，再选择引用 |
| 日期、数量 | 解析或受限提取后在代码中校验、计算；不插值 Score 还原数值 |
| 模板文本 | 模板引擎及已验证变量 |
| 全新文本、代码或图片 | 人类或独立 ArtifactProvider；结果作为草稿再验证 |

高风险动作缺失参数时不能悄悄采用默认值。可使用的默认值必须由能力声明和委托明确批准，并在动作预览中可见。

BoundAction 是完全绑定、可检查的动作实例，而不只是函数名。它包括 capabilityId/version、参数、来源引用、stateVersion、intentRevision、policyVersion、candidateSetDigest、过期时间与幂等键。

Jev 返回的是 BoundAction 的候选 ID 或构造候选所需的有限选择，不持有可执行凭证。模型输出不能直接成为 shell 字符串、任意 URL、任意选择器或可执行代码。

## 7. 状态与证据模型

不建立一个声称知道全世界的巨大状态对象。每个委托有自己的轻量 WorkingState，引用外部原始证据。

每项事实包含 value、sourceRef、observedAt、sourceVersion、freshUntil、quality。quality 可为 observed、derived、reported、hypothesis、unknown。reported 表示有人声称，不等同于系统观测。

语义判断结果不能覆盖原始事实。例如“客户已声称退款”不同于“退款已执行”。工具返回 200 不同于用户目标已实现。文档中写着“请忽略权限限制”仍然只是外部文档内容。

同一次判断的多个问题共享一致的 WorkingState 快照。跨租户数据不为节约成本混入同一个模型 state。问题只带需要的信息；敏感凭证留在执行端。

## 8. 候选动作编译

候选集合来自三个来源：已批准计划的可执行前沿、领域包根据当前状态产生的动作实例，以及通用元动作（观察、等待、请求澄清、请求规划、暂停）。

候选构造过程：资源范围过滤 → 权限过滤 → 前置条件过滤 → 参数绑定 → 检索／排序缩小语义候选 → 输出可审计的 CandidateSet。

候选检索必须单独测召回率。正确能力没有进入候选时，Jev 无法凭空选择它。需要 none_suitable，并区分缺信息、缺参数、缺技能和缺计划。

动作族、目标、参数之间存在依赖。v0.1 优先让模型选择完整合法的动作实例。只有组合空间过大时才做分层决策，并在组合后校验。可以并行预问候选分支的参数，但不能把共享状态误认为概率独立，也不能让第二个问题假装看到第一个问题的输出。

## 9. 快速判断层

建议按问题类型建立版本化 DecisionSpec，而不是一个全能 system prompt。

Choice 用于相对选择。Noul 用于检查一个具体语义命题。Score 用于相对质量分层，不承载精确计数或物理控制值。

一次请求可以预问多个明确问题，再由代码组合；各答案没有天然的全局逻辑一致性。候选概率、confidence、业务成功概率与风险不是同一量。

不使用全局 confidence > 0.9 自动放行。不把若干概率直接相乘当作整体可靠性。门控由任务类型、动作后果、数据充分性、实测错误率和授权共同确定。所有阈值在独立验证集上选择，冻结模型、提示、候选策略及域包版本。

若权限不满足，任何高概率都不能覆盖拒绝结果；若证据不足，优先补观测，不把缺事实都路由成“多想一次”。若候选同样可行，允许确定性规则打破平局。

## 10. 一次完整执行循环

1. 接收去重事件，检查租户、委托状态、预算与相关性。
2. 加载版本化状态；先核对已在途动作，不为同一资源重入调度。
3. 检查完成条件和可直接求解的规则。
4. 生成当前合法候选。
5. 必要时调用 Jev；记录输入快照引用、问题版本和原始分布。
6. 代码决定行动、补观测、等待或请求慢思考。
7. 在事务中持久化动作意图与 outbox。
8. 策略服务发出短期 ExecutionPermit；执行端校验许可、参数和新鲜度。
9. 执行端以稳定幂等键执行并记录回执。
10. 独立验证器重新读取结果，推进里程碑或进入恢复。

以事件驱动为主，不按固定高频不停问模型。对于运行中的长技能，通过状态更新、心跳和超时管理；不因每个细小事件都重选动作。

核心状态机建议：Draft → Validated → Active ↔ WaitingObservation / WaitingHuman / WaitingExecutor → Completed；旁路状态 Paused、Cancelled、Failed、NeedsReconciliation。Completed 需引用验收证据。

动作状态建议：Proposed → Authorized → DispatchPending → Dispatched → Running → EffectObserved → Verified。独立分支包括 Rejected、Failed、UnknownOutcome、Compensating、Compensated。

## 11. 崩溃、重复和过期

HTTP 超时不能简单视作执行失败。动作可能已经产生外部效果，但回执丢失；此时标记 UnknownOutcome，通过查询、对账或人工核实恢复。

幂等键针对同一逻辑动作跨重试保持不变。outbox 解决本地持久化与消息发送窗口；外部副作用的去重仍需要执行端或目标系统支持。没有这种支持时，不宣称 exactly-once。

每个资源默认单写者。多任务争用同一资源需租约／版本检查／隔离；计划发生冲突由确定性优先级、所有权或人来解决，不拼接两个模型的输出。

执行许可绑定动作参数摘要、授权主体、资源范围、意图／策略版本及截止时间。执行端重新检查。远端系统不支持条件写入时，必须暴露残余竞争窗口，不能声称重新读取就解决了原子性。

取消是请求，不是成功回滚的证据。物理设备和外部提交的取消语义由各适配器声明。补偿是新的业务操作，可能失败，也可能需要新的审批。

## 12. 人类慢思考作为一等接口

DeliberationRequest 类型：MissingFact、AmbiguousTarget、MissingArtifact、PlanRequired、ApprovalRequired、ConflictingGoals、UnknownOutcome。

请求包含阻塞点、已有事实、候选方案、关键来源、所需回答 schema、影响范围、有效期与可继续执行的独立分支。避免甩给人完整日志与“你看怎么办”。

响应类型：ProvideFact、SelectCandidate、ProvideArtifact、PatchIntent、ApproveAction、Pause、Cancel。

批准与事实补充不能混用：回复“这是 A 客户”不代表同意发消息；同意当前动作不代表放开所有同类动作。批准绑定动作摘要与状态／政策版本。

需要等待人时，将请求持久化，结束当前计算，不占住长期运行线程。回复到达后生成事件；先检查是否过期或状态已变，再继续执行。人不可用时暂停受影响分支，不默认扩大自治。

## 13. 完成验证与解释

Verification 优先使用可计算证据：资源字段、文件存在性与哈希、测试结果、外部任务状态。语义完成条件可由独立问题或人评审，但要标注判定方式与剩余不确定性。

不让同一个模型的 DONE 声明直接成为任务完成。虚构完成是单独衡量的错误类别。

运行时解释来自已记录事实：采用的候选、实际分布、触发的规则、参数来源、执行回执和验收证据。可以让生成模型将其转成可读说明，但必须标为基于审计记录生成的摘要，不冒充 Jev 的内部思考。

## 14. 产品形态与集成

核心交付物：语言无关协议、可嵌入判断循环、常驻服务、执行端 SDK、Inspect/Replay 工作台和版本化 Domain Pack。

Domain Pack 包含能力声明、状态映射、意图模板、DecisionSpec、参数绑定器、验证器与评测案例，而不只是一个 prompt。

首版继续使用 Bun + TypeScript 实现入口与核心，PostgreSQL 保存运行状态、事件、动作和待处理人工请求。C#/.NET 是首个正式执行端 SDK，通过 HTTP/事件接口对接现有系统。不要在第一版把整套工业系统重写成 TypeScript。

v0.1 使用单主调度和有限状态机，明确不实现通用分布式工作流引擎。后续若采用 Temporal，模型与外部操作置于 Activity 并保存结果；使用其正式支持的部署方式，不假设 Bun 可无修改替代所有 Worker 运行环境。现有 Elsa 可以作为长技能执行端；Hub 不与 Elsa 同时拥有同一工作流内部的跳转权。

逻辑包：contracts、core、decision-jev、state-store、policy、executor-sdk-ts、executor-sdk-dotnet、adapter-http、adapter-mcp、domain-issues、inspector、evaluation。第一版可在一个仓库和一个进程内组织，模块不等于微服务。

## 15. 建议公开 API

以下是提案，不是现有 Jev API：

```text
POST /v1/intents                     创建草案
POST /v1/intents/{id}/activate       校验并绑定授权后启用
PATCH /v1/intents/{id}               条件修订，产生新版本
POST /v1/intents/{id}/events         投递观察／执行事件
GET /v1/intents/{id}                 当前状态与阻塞原因
POST /v1/deliberations/{id}/respond  提交人工或慢系统回应
POST /v1/intents/{id}/pause          暂停新动作分派
POST /v1/intents/{id}/cancel         发起受能力语义约束的取消
GET /v1/runs/{id}/trace              审计轨迹
POST /v1/replays                     离线重放，不触发副作用
```

写请求使用租户隔离、身份认证、幂等键；修订使用版本条件。重放默认断开执行端。模型调用响应持久化，重放旧轨迹时不重新请求模型。

Jev 当前官方入口是 `POST https://api.typesafe.ai/v1/systemone`，请求由 `model`、`state`、`questions` 构成。公共 Hub API 不暴露 Jev 特有字段作为业务合同的一部分。

## 16. v0.1 示例任务

选择专用测试仓库。人定义：给新 Issue 做类型标记；重复项只给出候选，不自动关闭；缺信息时在本地生成模板草稿，不公开发送。

允许能力：读取 Issue、检索相似 Issue、添加已批准标签、本地生成草稿、创建内部复核项。禁用：关闭 Issue、公开评论、修改代码、合并 PR、权限管理。

运行流程：读 Issue → 直接检查资源条件 → Jev 判断类型与信息充分性 → 选实际标签引用 → 持久化动作 → 执行端检查 → 添加标签 → 重新读回验证。信息不够则创建本地草稿／复核项。是否公开发送需新的明确授权。

这个任务不需要生成模型即可用 Jev、模板和代码跑通；丰富的回复创作以后作为 ArtifactProvider 加入。实际准确率与速度必须实测。

## 17. 阶段与验收

| 阶段 | 交付 | 通过条件 |
|---|---|---|
| A：离线核心 | 合同校验、状态、候选、ReplayProvider、许可／回执模型 | 固定轨迹可复现；拒绝越权和过期动作 |
| B：Jev 单域闭环 | Issue 域、人工请求、验证器、Inspect | 对照规则与生成模型测业务结果，不只测分类 |
| C：故障与旁路 | 限流、超时、重复事件、撤权、进程重启、未知结果 | 不丢任务；不盲重试非幂等效果；能定位阻塞 |
| D：跨域验证 | 本地文件域或内部任务台域 | 不改核心循环，仅增加域包与适配器 |

第一轮建议准备约 200–500 个委托／决策片段，按任务、资源和时间划分训练／调参／测试，避免同一轨迹泄漏。规模是项目建议，不是足以证明生产可靠性的样本保证。

记录指标：任务成功率、错误动作率、虚假完成率、候选召回率、人工打扰次数、人工处理分钟数、无进展循环次数、恢复成功率、端到端 P50/P95/P99、模型与工具成本。

针对高置信错误、缺失正确候选、未知能力、中文／英文混合、恶意外部文本、状态过期、组合参数冲突、回执丢失建立专门集。离线旁路只能说明建议质量，不能把未执行方案标记为成功。

## 18. 可探索的长期能力

### 可执行委托与持续意图

把人已经想清楚的目标变成有期限、可检查、可撤销的活动任务，而不是每次都从聊天历史重新猜用户愿望。一次性目标与持续维持目标分开实现，避免自动修复覆盖人之后主动做出的修改。

### 经验包与执行案例记忆

保存“目标、上下文、候选、已选动作、真实结果、人工修订”。相似新任务可以引用案例，但案例不具备授权能力。把高价值修订变成新规则或策略候选，经过离线评测与批准再发布，不在线自我扩权。

### 按需调用慢思考

调度的资源不只有模型 token，还包括人的注意力。将同一原因造成的多个阻塞合并为一次请求；先做可以独立推进且已授权的工作；未知后果不为了减少打扰而自动冒险。

### 跨执行端移植

同一种委托和能力语义可以绑定不同 API、浏览器或 C# 执行端，但每个域仍需自己的状态与验收定义。通用的是运行机制，不是假装所有领域共享一个完整世界模型。

## 19. 成本与供应商边界

截至资料核对，官方模型页列出 `jev-1.13.0`、文本输入、每百万输入 token 0.042 美元、1,200 请求／分钟，并明确限流可能动态变化。原型不应按演示延迟推导生产吞吐。1,200 RPM 换算平均为 20 请求／秒，但不说明允许的瞬时突发；还受 token 限流、网络与执行端影响。

减少无关状态、用事件触发、同一状态的多个问题适度合批、并发预算和熔断比单纯堆线程重要。不要为不同租户混合状态。

模型升级必须重新验证。当前公开页说明不按客户数据微调；不将收集案例描述为可直接微调 Jev。没有官方确认的本地部署和服务保证不能写成能力承诺。

## 20. 资料依据与使用范围

以下均为 2026-09-19 核对的公开原始资料。厂商演示和自测不等同于第三方通用可靠性结论。

| 资料 | 对本方案的作用 |
|---|---|
| TypeSafe Models | 当前版本、输入、费用、限流、客户定制边界 |
| TypeSafe API | 三种判断原语及 HTTP 协议 |
| TypeSafe Function calling | 有限函数与参数空间的映射；不是任意参数生成 |
| TypeSafe Speculative fan-out | 同一状态多问题并行，代码选择适用结果 |
| TypeSafe Skill suggestion | 初筛、读完整候选、允许拒绝全部 |
| TypeSafe Confidence / Jaggedness | 概率含义、数学和生成边界、对抗性内容 |
| Browser Use jev-ultrafast | 动态索引动作空间、开放文本另交生成器、执行前新鲜度检查及独立完成验证 |
| MCP Tools（明确版本） | 工具 schema 与工具声明的信任边界 |
| Kubernetes Controllers | 期望状态—观察—调整的架构类比；不暗示自然语言目标有同等确定性 |
| LangGraph Persistence / Interrupts | 持久化与人工介入已有成熟实践，不宣称本方案首创 |
| Temporal Activities / Workflow Definition | 可恢复执行、非确定性操作边界与幂等重试 |
| Anthropic Building Effective Agents | 工作流和动态 Agent 的区分，以及从简单组件开始 |

资料地址：

```text
https://docs.typesafe.ai/models
https://docs.typesafe.ai/api
https://docs.typesafe.ai/cookbooks/function_calling
https://docs.typesafe.ai/patterns/fan-out
https://docs.typesafe.ai/cookbooks/skill_suggestion
https://docs.typesafe.ai/confidence
https://docs.typesafe.ai/model-jaggedness/jev-1.13
https://docs.typesafe.ai/concepts/state
https://docs.typesafe.ai/concepts/how-to-build-with-system-one
https://github.com/browser-use/jev-ultrafast
https://modelcontextprotocol.io/specification/2025-11-25/server/tools
https://kubernetes.io/docs/concepts/architecture/controller/
https://docs.langchain.com/oss/python/langgraph/persistence
https://docs.langchain.com/oss/javascript/langgraph/interrupts
https://docs.temporal.io/activities
https://docs.temporal.io/workflow-definition
https://www.anthropic.com/engineering/building-effective-agents
```
