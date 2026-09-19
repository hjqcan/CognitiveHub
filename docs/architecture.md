# 架构：小内核、明确的控制权

本文描述实际代码，不把远期蓝图当作已交付功能。

## 1. 模块

| 模块 | 职责 |
| --- | --- |
| `contracts.ts` | JSON 数据、Intent、能力、动作、端口、回执与执行日志契约 |
| `plugins.ts` | 显式模块安装、服务依赖、生命周期、可撤销贡献、能力作用域 |
| `hub.ts` | 单轮提案、预检、显式执行、未知结果核对 |
| `run.ts` | Run、预算、等待条件、慢思考回应、目标验收与 Run 存储契约 |
| `runtime.ts` | 可选的托管运行时：按 `step()` 串行推进、唤醒、批准、预算、恢复；见 `docs/runtime.md` |
| `jev.ts` | TypeSafe `/v1/systemone` Choice 协议适配，不模拟聊天工具调用 |
| `memory.ts` | 单进程日志（可导出、可从记录重建）、资源预留、人工收件箱、事件缓冲 |
| `primitives.ts` | 不可变快照、JSON 校验、确定性序列化、截止时间、记录/回执形状校验、动作身份 |

公共契约不导入 Jev SDK、ROS、RMS、数据库或交易库。能力插件可以调用任何经过宿主批准的服务；真实参数、执行上下文和副作用不进入模型控制。

## 2. 三种独立生命周期

**插件**：`installed → starting → active → draining → stopped`，激活或清理失败进入 `failed`。`start()` 只激活 installed/stopped 的模块，不会自动重试 failed；`uninstall()` 移除任何未激活的挂载，之后可以重新 install 同名或替换实现。依赖通过版本化服务名声明；不做动态 semver 求解，也不兼容 Cordis/dsh ABI。

一个启动批次在所有 setup 成功后统一对外可见；批次内部可以访问已完成 setup 的依赖。回滚不会暴露可被 Hub 获取的新能力。draining 持续到租约排空且所有 disposer 完成，在此期间拒绝新的依赖消费者和重新激活。

**提案**：有短期有效期，是宿主内存中的不透明 ID。动作绑定插件激活代次、能力契约、参数、作用域、状态版本、策略版本和意图版本。首次真实提交绑定一个 operationId；不能用同一提案执行多个不同操作。预览不消耗它。过期提案会在新提案创建时清理，也可显式 `discard()`。

**执行**：

```text
submitted ──→ pending ──→ verified
    │            └─────→ failed
    └──────→ unknown ──→ pending / verified / failed
```

`accepted` 仅表示远端受理，首次提交后停在 pending；`completed` 立即调用 verifier，核验无法完成时仍只是 pending。`reconcile()` 先调用可选的能力 reconcile 找回回执，再对任何未终结的结果调用 verifier：accepted、completed、unknown，以及回执从未记录成功的 submitted（按 unknown 处理）。证据不足时状态保持不变，unknown 仍是 unknown；未知结果不自动重放。没有学到新信息就不写新修订，结果里的 `unchanged: true` 表示本次没有写入。terminal 表示这个动作的观察结果已确定，不表示用户的整体目标已经完成。

**恢复**：记录由另一个进程留下、本进程没有它的租约和上下文时，`reconcile()` 先按 `(pluginId, pluginVersion 精确相等, capabilityId, 记录的 intent.scope)` 向 PluginHost 重新绑定当前 active 的激活代次，只用于 reconcile/verify，绝不用于 execute。绑定失败返回 `rejected`：`unavailable-capability`（插件未安装、未激活、正在排空或作用域不可见）或 `plugin-version-mismatch`；记录和资源预留原样保留，这就是显式的阻塞状态。查询钩子抛错、超时或返回非法结构返回 `reconcile-failed`，记录不变，租约保留。恢复只校验记录形状，不校验旧观测是否过期：查询不需要新鲜状态，但能力在 verify/reconcile 中拿到的 observation 是旧快照，只能当标识符用。

## 3. 决策与权限

`Intent.capabilities` 是请求使用的能力，不是授予的权限。`Policy` 是必选宿主端口，无默认 allow-all。它需要检查当前用户、意图修订、授权、资源所有权及业务限制。

候选经过意图能力白名单、插件作用域和宿主策略过滤。所有能力先完成绑定与校验，`maxCandidates` 限制的是这一步的总量；随后策略逐个裁决，每次都能看到本轮完整的候选集合。模型只能选择实际候选、等待或请求慢思考。Hub 不会把被拒绝的动作偷偷转换成另一动作。

执行前重新观察状态、检查策略版本、校验参数和前置条件；异步前置检查之后再核对授权。等待 journal claim 后、实际派发前，同时检查提案和本次新观测的有效期；过期则记录未派发失败并释放资源。模型、候选、提案和记录采用不可变快照，不能靠修改公开返回对象改变提交参数。

这些检查仍存在远程 TOCTOU 窗口：最终宿主接口必须支持资源版本条件、授权检查和原子提交。只在调用前重新读取一次，不提供端到端原子性保证。

动作身份 `action.id` 与执行 fingerprint 只包含插件 ID、插件版本、能力 ID、候选 key、参数、资源、效果类型和作用域，不包含进程局部的 activation，也不包含给模型看的描述文字。重启后用同一 operationId 重试同一逻辑动作会拿回已有记录（`unchanged: true`），而不是被判成另一个动作；插件版本变了则是 `operation-mismatch`。“重新激活即旧提案失效”仍由 execute 时按 activation 取租约保证，与身份无关。

## 4. 作用域与资源

作用域采用字符串段数组，例如 `['tenant-a', 'R01', 'task-42']`。挂载 `['tenant-a', 'R01']` 的能力对子任务可见，对 R010 不可见。空作用域代表管理员显式挂载的全局能力，但不豁免策略检查。

当前服务注册表是单 PluginHost 范围的全局注册表；能力注册有作用域。这不是多租户安全沙箱。不要把不互信租户的插件代码放在同一宿主进程。

写/物理能力必须声明至少一个资源。资源锁键是 `(tenant, resourceId)`，不同任务或机器人 Hub 在同一进程中应共享同一个 journal，并采用一致资源命名，如 `robot:R01`。资源列表由可信适配器生成，不能依赖模型枚举完整冲突集合。

MemoryJournal 的 claim 原子预留操作 ID 和资源；replace 是版本比较更新，版本不符必须抛 `journal-conflict`。submitted、pending、unknown 持有资源，verified/failed 释放。日志不会自动删除，否则幂等历史会丢失；生产实现需要 retention 和迁移策略。

`entries()` 导出普通 JSON；`new MemoryJournal(records)` 逐条校验形状后重建，非终态记录重新占用资源，两条未终态记录占同一资源视为数据损坏直接抛错。终态记录是幂等历史，必须一起导入。`unsettled()` 列出非终态记录，供宿主启动后逐条 `reconcile()`。宿主自己决定把 JSON 落到哪里；这不是数据库，也没有 outbox。

## 5. 并发与截止时间

每个意图只有一个正在运行的 propose；重入返回 wait，不排队处理过期事件。宿主选择是否合并最新事件或重新触发，不照搬交易项目的高频轮询。

一次提案/操作不能并发提交两次。决策、预检、提交和验证有明确时间上限。超时只结束等待，不证明外部操作被取消。忽略 AbortSignal 的代码可能仍在运行；决策和预检的插件租约保留到实际回调结束，迟到的模型结果不会提交执行。

插件开始 draining 后，新候选不可见；尚未派发的动作会被拒绝。在途执行继续保留 capability lease，使用既有 verifier/reconcile。执行记录终态和本地回调退出分别跟踪：记录终态后资源预留释放，但插件要等所有 execute/verify/reconcile 回调实际结束才可清理。迟到回调的结果不会覆盖已经记录的状态。

服务端口（decision/state/policy/deliberation）由应用保持存活。当前内核不会自动对 `plugins.resolve()` 返回的任意服务建立生命周期租约；应用应先停止调用/清空在途认知工作，再停止服务提供插件。不要声称所有服务都支持无感热替换。

## 6. 日志与错误

执行意图先 claim，再调用执行器。claim 失败不会调用执行器。回执持久化失败向调用者抛出错误，保留插件租约；不能伪装为安全拒绝，也不能在用户重试时重复提交。

内存事件 sink 仅用于观察，不是强制审计日志。观察器异常不会改变执行结果，通过 `observerErrors` 计数。需要持久审计时应实现有正确事务语义的执行存储，而不是只订阅事件。

`execution.dispatch.rejected` 记录派发前拒绝原因；`execution.callback.started/settled/unavailable` 记录操作 ID、阶段、在途回调数、超时或通用错误码；`execution.lease.released` 标记插件租约释放；`execution.recovered` 记录新进程采纳了一条旧记录，`execution.recovery.blocked` 记录采纳失败的原因码。可用这些事件定位“动作已终态但插件仍在排空”的原因，不记录原始异常正文或凭据。

`rejected` 结果带稳定的 `code`，`reason` 只给人看：

| code | 含义 |
| --- | --- |
| `unknown-proposal` / `proposal-consumed` / `busy` | 提案不存在、已绑定其他操作、或同一提案/操作正在处理 |
| `operation-mismatch` | operationId 已属于不同的 intent 或动作 |
| `claim-conflict` | journal 拒绝预留：资源被未终态操作占用 |
| `stale-proposal` / `stale-state` / `policy-rejected` / `precondition` / `capability-draining` / `timeout` / `aborted` | 预检失败，透传 HubError 码 |
| `preflight-failed` | 预检中的非 HubError 异常 |
| `unknown-operation` | reconcile 的 id 不在 journal 中 |
| `unavailable-capability` / `plugin-version-mismatch` | 恢复时找不到兼容的能力实现 |
| `reconcile-failed` | 查询钩子失败，记录不变 |
| `journal-conflict` | 另一个 Hub 实例先一步推进了这条记录，重新 reconcile 即可收敛 |

所有来源为普通 JSON，拒绝循环、非有限数值和隐式 undefined。事件默认只含 ID、类型和状态，不自动记录完整原始输入；journal/inbox 仍含业务数据，宿主需治理。

## 7. 人类慢思考

HumanInbox 存储缺少计划、信息或授权等请求。`acknowledge()` 只表示该请求已处理/收到，不是动作批准。宿主认证用户回应、更新意图或状态、维护权威授权，然后重新 propose。

没有“把旧提案挂起一天后直接继续执行”的捷径。没有候选也不代表目标完成：可能是没有权限、没有能力或缺少信息。

## 8. 当前可靠性上限

默认 journal、proposal、inbox、lease 全部在内存。提案和租约随进程消失；journal 可以由宿主导出为 JSON 并在新进程重建，未终态记录按插件 ID、精确版本和能力 ID 重新绑定后只做查询核对，不重发。托管运行时（`docs/runtime.md`）为 Run 提供所有权租约和 `due()` / `step()`，宿主自己调度。仍未实现：内置后台循环、PostgreSQL 存储、outbox、人工请求持久化。

约定：一份 journal 同一时刻只由一个 Hub 实例驱动。两个实例同时推进同一记录时，CAS 保证只有一个写入成功，输家得到 `journal-conflict` 并在下次 reconcile 收敛到赢家的结果，不会双重执行；但这只是保护，不是多写者支持。

本版本适合开发、模拟、旁路决策和受限的可信进程内集成。真实设备/不可逆操作接入前，必须先完成路线图中的可靠性阶段。

## 9. 托管运行时

单轮内核之上有一层可选的 `IntentRuntime`：宿主交付 Run，运行时在每次 `step()` 里按“核对在途 → 观察 → 目标验收 → 预算 → 提案 → 批准 → 派发”的固定顺序推进，至多派发一个动作。Run 只持久化可恢复状态，派发真相仍在执行日志。慢思考请求带 `runId` 与 `kind`，回应分 fact / guidance / approve / terminate 四类并按请求 id 与意图修订门控。`Guidance` 是给决策器的数据，与授权端口 `Policy` 严格分开。细节见 `docs/runtime.md`。
