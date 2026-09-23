# 托管运行时：把单轮内核变成可持续推进的委托

单轮 API（`propose / execute / reconcile`）保持不变，任何宿主可以只用它。`IntentRuntime` 是可选的一层：宿主交付一个 Run，运行时在每次 `step()` 里推进一步，需要慢思考时停下来，得到回应后继续，进程重启后从存储里知道做到哪里。它**不在后台循环**，也不拥有调度：`due()` 告诉宿主哪些 Run 现在该推进，事件到达时宿主调用 `deliver()` 或直接 `step()`。

```ts
import { IntentRuntime, HumanInbox } from '@cognitive-hub/core';

const runtime = new IntentRuntime({
  plugins, state, policy, decision: plugins.resolve('decision.v1'), deliberation: new HumanInbox(),
  goal: yourGoalEvaluator,   // 必选：完成必须有宿主查询到的证据
  owner: 'worker-1',         // 所有权租约的稳定身份
});
const run = await runtime.start({ intent, approval: 'automatic',
  budget: { maxDecisions: 50, maxActions: 20, maxNoProgress: 3, deadlineAt: null } });
for (const id of await runtime.due()) await runtime.step(id);
```

运行时自己构造内部的 `CognitiveHub`（`runtime.hub` 可直接使用），并把 `hub.propose()` 里产生的慢思考请求打上 `runId`，宿主据此调用 `respond()`。配置 `decisions` 后，每轮决策记录也带 `tags.runId`，`timeline({ decisions, journal, runs }, { runId })` 能按 Run 读回"考虑了什么、排除了什么、选了什么、执行结果如何"。

## 1. 对象

| 对象 | 内容 |
| --- | --- |
| `RunSpec` | `intent`、`budget`、`approval`（必填：`automatic`、`each-action` 或 `advisory`，见 §5.5）、可选 `guidance`、`waitMs`、`idle`（空候选时 `deliberate` 请示或 `wait` 等待，默认 `deliberate`）、`onDecisionError`（决策阶段失败时 `deliberate` 请示或 `wait` 定时重试，默认 `deliberate`） |
| `Run` | 意图快照、guidance、预算、状态、`operations`（派发过的 journal 记录 id）、`settled`（已确认终态的前缀长度，见 §3）、`wait`、当前 `request`、`approved`、`answers`、`counters`、`progress`、`outcome`、`lease`、CAS 用的 `revision` |
| `Budget` | `maxDecisions`、`maxActions`、`maxNoProgress`、`deadlineAt` |
| `Guidance` | 带版本的人类判断标准：`criteria`、`escalate`、`author`。只作为数据进入 `DecisionRequest.guidance`，Jev 适配器放进 `state.guidance`。**它不是 `Policy`**：不能放宽授权，也不能替代它 |
| `GoalEvaluator` | `evaluate({ intent, observation, records, operations })` → `satisfied / unsatisfied / unreachable` + 证据。`records` 是此前成功验收尚未见过其终态的操作（通常只有最近一条），每个操作进入终态后至少出现一次；`operations` 是全部记录 id，需要历史的验收器自己读 journal。无默认实现；决策器的输出永远不会进入这个端口 |

Run 只持久化可恢复的状态。observing、deciding、executing 只是 `step()` 内部的阶段，不写进 `status`：执行日志已经是“派发了什么”的唯一真相，Run 不保存第二份。

## 2. 状态机

```text
active ──→ waiting        模型 wait，或派发后记录未终态
active ──→ deliberating   无候选 / 模型 ask / 预算耗尽 / 无进展 / 恢复受阻 / 需要批准
active ──→ completed      GoalEvaluator satisfied 且没有在途操作
active ──→ failed         GoalEvaluator unreachable 且没有在途操作
waiting ──→ active        任一等待条件成立（step 自查，或 deliver 唤醒）
deliberating ──→ active   有效回应被应用；terminate 回应 → stopping / stopped
{active, waiting, deliberating} ──→ paused ──→ active / deliberating
任意非终态 ──→ stopping ──→ stopped     宿主 stop()；在途操作核对到终态后才 stopped
```

`completed / failed / stopped` 是终态。终态后的事件只记 `run.event.ignored`，回应返回 `run-terminal`。

## 3. 一次 step 做什么

每次 `step(runId)` 持有该 Run 的所有权租约，按固定顺序推进，**至多派发一个动作**：

1. 从 `settled` 游标之后的操作开始，对每条未终态记录调用 `hub.reconcile()`。只查询，绝不重发。终态记录永不改写，游标之前的操作不再读取，所以一步的读写次数与历史长度无关。找不到兼容能力（`unavailable-capability` / `plugin-version-mismatch`）→ `deliberating`，请求 kind 为 `recovery`。journal 里不存在的记录说明进程死在“写入 Run 之后、claim 之前”，什么都没发生，直接从 `operations` 移除。
2. `stopping` 的 Run 只做第 1 步；全部终态后变为 `stopped`。
3. 观察一次状态；安静检查（§4）刚观测过则复用。`hub.propose()` 复用这次观测，`hub.execute()` 仍然重新观测并比对版本。
4. `waiting` 的 Run 检查等待条件：没有任何条件成立就直接返回 `waiting`，**不调用决策器**。只被时间条件唤醒且状态版本没变，`noProgress + 1`。
5. 调用 `GoalEvaluator`。第一步就检查，所以“目标本来就已满足”不会产生任何动作。验收成功后游标才越过已终态的操作，并和 `progress` 一起随本步最后一次写入保存。satisfied / unreachable 但有在途操作 → 继续等待，不带着未知结果进入终态；全部核对后根据当前证据进入 completed / failed。
6. 有在途操作 → `waiting`。一次只有一个动作。
7. 预算检查：截止时间、决策次数、动作次数、无进展次数，任一耗尽 → `deliberating`（kind `budget` / `no-progress`）。
8. `hub.propose()`。wait → 登记 `state` + `time` 条件；deliberation → `deliberating`（kind `decision`）。`idle: 'wait'` 的 Run 在没有任何授权候选时也走 wait 路径，不调用决策器、不产生请示。`onDecisionError: 'wait'` 的 Run 在决策阶段失败时（决策器抛错或超时、返回非法结构、思考期间状态过期）也走 wait 路径，`StepResult.code` 与决策记录带失败码；观测、候选准备、策略阶段的失败仍然请示，因为等待不会修好它们。
9. `each-action` 模式下核对批准（见 §5）。
10. 先把 operationId 与 `actions + 1` 写入 Run，再 `hub.execute(..., { live: true })`。派发被拒绝（撤权、状态变化、资源占用）→ 从 `operations` 移除，`noProgress + 1`，返回 `rejected`。记录未终态 → `waiting`；已终态 → `executed`。运行时在 finally 中释放自己创建的提案，包括被拒绝、请求批准和异常路径；执行恢复依靠 journal，不依赖提案继续驻留。所有权租约的释放并入本步最后一次写入；只有“已派发且已终态”的路径保留单独的释放写入，因为 operationId 在派发前写入，提前释放会让别的 worker 把尚未 claim 的 id 当成幽灵删除。

`StepResult.outcome` 取值：`idle`（终态或 paused）、`lease-held`、`waiting`、`executed`、`rejected`、`deliberating`、`completed`、`failed`、`stopped`，以及旁路 Run 的 `advised`。

`StepResult` 还说明这一步做了什么，宿主不必比对前后的 `operations`：`decisionId` 是本步 propose 的决策轮次（配置了 `decisions` 时可用 `DecisionStore.get()` 取回记录），`recordId` 是本步派发的执行记录或恢复受阻的那条记录，`code` 是失败或被拒绝时的机器可读原因（派发拒绝码、恢复受阻码、决策失败码）。没有发生的事就没有对应字段。

## 4. 等待与唤醒

```ts
type WaitCondition =
  | { kind: 'execution'; recordId }    // 该记录进入终态
  | { kind: 'deliberation'; requestId } // 该请求被有效回应（只能由 respond() 满足）
  | { kind: 'state'; version }          // 观测版本不再等于 version
  | { kind: 'time'; at };               // 到时
```

运行时总会加一个 `time` 上界（`waitMs`），所以没有开放式等待。模型的 `wait` 决定被翻译成 `[state: 当前版本, time: now + waitMs]`；Choice 协议不需要表达结构化条件，等待需求来自模型，唤醒条件由运行时登记。

决策器暂时不可用也不一定需要人。默认下决策器的任何失败都进入 `deliberating`，宿主必须回应才能继续；决策器会因限流、过载、网络抖动短暂失败的宿主（三个游戏都手动解冻过）用 `onDecisionError: 'wait'` 启动，失败被翻译成同样的 `[state, time]` 等待。它按 §6 计入无进展，决策器一直不可用时照样会以 `no-progress` 请求交给宿主。注意决策的实际期限是 `decisionTimeoutMs` 与观测有效期中较短的一个：观测在思考期间过期会以 `stale-state` 失败，所以 `decisionTimeoutMs` 应不大于观测有效期。

没有候选不一定是阻塞。默认下空候选进入 `deliberating`（缺插件、被撤权时宿主应当知道）；长期存在、只在世界出现事情时才行动的 Run（审核队列为空的审核员、开盘前的做市商）用 `idle: 'wait'` 启动，空候选被翻译成同样的 `[state, time]` 等待：不调用决策器，不产生请示，但仍写一条 `outcome: 'wait'`、`decision: null` 的决策记录并计入 `decisions`；状态版本不变的定时唤醒照常累计 `noProgress`。直接使用 Hub 时对应 `propose(intent, { onEmpty: 'wait' })`。

**安静检查。** 处于 `waiting`、没有停止要求、没有租约、游标之后没有操作、等待条件只有 `state` 与 `time` 且时间界未到的 Run，`step()` 先只读地观测一次：条件都不成立就直接返回 `waiting`，不取租约、不读 journal、不写存储；有条件成立才走完整路径并复用这次观测。等待执行结果的 Run 仍然每步核对。

`deliver(runId, event)` 按 `event.key` 去重；`state-changed`、`execution-updated`（`data.recordId`）、`timer` 分别匹配对应条件，`host` 无条件唤醒。唤醒只把 `waiting` 改成 `active`，从不执行 step。宿主没有事件源时，定期对 `due()` 返回的 Run 调用 `step()` 也能工作，因为 step 自己会重新检查条件。

## 5. 慢思考往返

请求里带 `runId`、`kind` 和 `subject`：

| kind | 何时 | subject |
| --- | --- | --- |
| `decision` | 没有候选、模型选择 ask、或内核决策失败 | `DecisionSubject`：`cause`（`no-candidates` / `decider-asked` / `failed`）、`code`、`phase`（`observe` / `prepare` / `policy` / `decide` / `commit`，本轮结束的位置）、`decisionId`、`considered`（策略前的草案数）、`candidates`（策略允许的动作 id）、`excluded`（被策略排除的动作与原因）。v0.3 之前停下的 Run 为 `null` |
| `approval` | `each-action` 模式下派发前 | 动作 digest、状态版本、能力、参数、资源 |
| `budget` / `no-progress` | 预算耗尽 / 重复无进展 | 计数 |
| `recovery` | 重启后找不到兼容的能力实现 | 记录 id 与原因码 |

回应只有四类，不能混用：

| kind | 效果 |
| --- | --- |
| `fact` | 只表示“宿主状态已更新，重新观察”。事实进入 Observation 的唯一途径是 StateProvider；`note` 仅供审计 |
| `guidance` | 版本必须等于当前 + 1；替换 `Run.guidance`，下一步以新标准重新 propose。不能改变 Policy |
| `approve` | 只回答 `approval` 请求；`digest` 与 `stateVersion` 必须与请求一致。批准存入 `Run.approved`，**下一步重新 propose**：只有新提案的动作 digest 相同、状态版本相同且未过期才派发，否则丢弃批准并重新请求。旧提案永远不会被直接执行 |
| `terminate` | 终止；有在途操作先 `stopping`，核对到终态后 `stopped` |

共同门控：`requestId` 必须等于当前开放请求，`intentRevision` 必须等于 Run 的意图修订，否则 `stale-response` 且 Run 不变。回应者的身份和权限由宿主在调用 `respond()` 之前认证；运行时看不到凭据。

## 5.5 旁路模式

`approval: 'advisory'` 的 Run 用来旁听一个仍由人或原平台做决定的宿主（路线图阶段 A）。它照常核对、观测、验收、检查预算、propose，然后只做一次 `hub.execute(..., { live: false })` 预检：重新观测、execute 阶段的策略、validate、能力的无副作用 check。它从不 claim、不占资源、不调用 execute，`operations` 保持为空，所以同一资源可以同时被真正行动的 Run 使用。

- 每次建议的步进返回 `advised`，带 `decisionId`；预检被拒绝时 `code` 是拒绝码（例如 `policy-rejected`），这正是“宿主会不会拒绝这个动作”的证据。事件 `run.advised`。
- 建议后登记 `[state, time]` 等待。只因时间界到期、状态版本没变时，重新挂起等待，不调用决策器、不计无进展：宿主安静时旁听不花预算。截止时间仍然有效。
- 宿主记录自己在每个决策时刻实际做了什么（能力 + 候选 key，或什么都没做），`compareAdvice(records, labels)` 给出一致率、候选召回率（实际动作是否在候选里）、不同、弃权、越权次数和召回失败的决策。召回衡量能力适配器，一致率衡量决策器，两者都不说明动作执行后会成功。`node scripts/replay.mjs <dir> --labels <file>` 对导出的记录做同样的比较，示例见 `examples/shadow-advisor.mjs`。

## 6. 预算与无进展

`counters.signature` 记录上一次“状态版本 + 所选动作”（模型 wait 记为 `wait`）。签名相同 → `noProgress + 1`，不同 → 归零。时间唤醒但版本未变、派发被拒绝、决策失败后的等待也各计一次。决策失败不看状态是否变化（实时宿主每帧都变），也不改签名，所以穿插的失败掩盖不了重复同一动作的循环；成功的决策照常按签名归零。宿主取消（`aborted`）不算失败。任一预算耗尽进入 `deliberating`；提高预算走宿主 `revise(runId, { budget })`，它会自动解除 `budget` 请求，其他请求仍需回应。

## 7. 暂停、停止、修订

- `pause()`：不再推进，`step()` 返回 `idle`。`resume()` 回到 active 重新观察；若有开放请求则回到 deliberating。paused 期间仍可 `respond()`。
- `stop()`：不再 propose、不再派发。在途操作继续核对直到终态；**不撤销任何已发生的外部效果**。取消需要能力契约提供显式 cancel 端口，v0.2 没有。
- `revise(runId, { intent | budget | guidance })`：意图修订必须保持 id 与作用域且 revision 递增；它使开放请求和批准失效，`noProgress` 归零，Run 回到 active。

## 8. 持久化与恢复

`RunStore` 有五个必选方法：`create`（同一意图只允许一个未终态 Run）、`get`、`replace`（CAS，版本不符抛 `run-conflict`）、`markEvent`（旧的独立事件去重接口，运行时改用 `Run.processedEvents`）、`unsettled`；以及可选的 `due(now, limit?)`，按 `runWakeAt` 返回到期的 Run，最早的在前。存储没有实现它时，`runtime.due()` 用 `unsettled()` 加同一个排序规则 `dueRuns` 回退。`MemoryRunStore` 的 `entries()/events()` 导出普通 JSON，构造函数重建；宿主决定落盘方式，`tests/runtime-worker.mjs` 演示了每次写入后落盘的文件存储。生产环境用 `@cognitive-hub/core/pg` 的 `PgRunStore` 与 `PgJournal`：CAS、一意图一未终态 Run 的唯一索引、事件去重都由 PostgreSQL 约束保证，`wake_at` 列记录 Run 最晚该被查看的时间，`PgRunStore.due()` 通过它的部分索引查询，不再把所有未终态 Run 整体读出。

崩溃窗口与恢复策略：

| 中断位置 | 重启后 |
| --- | --- |
| Run 写入 operationId 之前 | 什么都没发生，重新观察再决定 |
| Run 写入之后、journal claim 之前 | journal 无此记录，从 `operations` 移除，不重发 |
| claim 之后、回执落盘之前 | 记录 `submitted` 且 receipt 为 null，按 unknown 通过能力的 reconcile/verify 按幂等键查询 |
| 回执之后、验证之前 | 继续 verify，不重新执行 |
| 外部任务仍在运行 | 恢复跟踪，等待 |
| 游标前移尚未写入 | 游标只增不减、可重算：下一步多读几条终态记录，行为不变 |

`settled` 是运行时自己的缓存。缺失（v0.3 之前的快照）、非整数或超出 `operations` 长度都读作 0，只多花一次追平的读取。宿主若改写 `operations` 必须删除它；journal 与 run store 必须从同一时间点一致恢复，否则游标可能覆盖一条又变回未终态的记录。

所有权租约：`step()` 开始时写入 `{ owner, expiresAt }`，结束时释放。其他 owner 持有且未过期 → `lease-held`；过期可接管；**同一 owner 重启后直接接管自己的租约**，这就是单工作进程的崩溃恢复。这不是分布式调度，也不做公平性。

**保留与清理。** Run、执行记录、决策记录都只增不减，直到宿主调用 `runtime.prune({ before })`：它删除截止时间前创建的决策记录、截止时间前结束的 Run（含事件回执）、截止时间前进入终态的执行记录，但保留所有未终态 Run 的 `operations` 引用的记录，所以进行中的 Run 不会丢失目标证据，也不会把已派发的操作误判为幽灵记录。仍保留下来的已结束 Run，其早于截止时间的执行记录会被清掉；截止时间应早于还想复盘的一切。存储没有实现 `prune` 时对应项返回 null。决策记录里的观测事实占了大部分体积，`recordFacts: false` 只存 `facts: null`，代价是之后无法用原事实重评。

## 8.5 托管多个 Run

一个宿主往往同时推进许多 Run（浇给每局 8 个角色）。三件事以前每个游戏各写一遍，现在由内核提供，但调度权仍在宿主：

- **`runtime.stepDue({ concurrency, limit?, signal? })`**：取当前到期的 Run（最早的在前），最多 `concurrency` 个同时 `step()`，推进一遍就返回，不循环也不休眠。每项是 `{ runId, result }` 或 `{ runId, error }`，一个 Run 抛错不影响其他 Run。signal 中止后不再启动新的步进，并传给正在运行的步进。`limit` 截断时按唤醒时间排序，刚推进过的 Run 自然排到后面，不会饿死。
- **`limitDecider(inner, { concurrency, maxCalls?, name? })`**：多个 Run 共用一个决策器时的并发上限与调用预算，见 `docs/architecture.md` §5。
- **`plugins.stopAll({ signal })`**：按依赖顺序停掉所有插件，见 `docs/plugins.md`。

关停配方：

```ts
for (const run of await runtime.runs.unsettled()) await runtime.stop(run.id);
await runtime.stepDue({ concurrency: 4 });                      // 核对在途操作，能结束的 Run 结束
const { failed, skipped } = await plugins.stopAll({ signal: AbortSignal.timeout(1000) });
// failed/skipped 非空：仍有在途回调或未终态操作持有插件，稍后再调用一次 stopAll
```

## 9. 事件

`run.started`、`run.stepped`（带 `decisionId`、`recordId`、`code`）、`run.waiting`、`run.woken`、`run.deliberating`、`run.dispatch.rejected`、`run.response.applied / rejected`、`run.paused`、`run.resumed`、`run.revised`、`run.stopping`、`run.completed / failed / stopped`、`run.event.duplicate / ignored`。只含 id、状态与原因码，不含业务数据。

## 10. 边界

- 没有后台循环、没有节拍器：宿主调度。
- 一次只处理一个动作；并行分支需要多个 Run。多个 Run 用 `stepDue()` 按并发上限推进，共用的决策器用 `limitDecider()` 限流。
- 一个 Run 同一时刻只由一个 worker 推进；跨进程互斥依赖租约与 CAS，不是队列。
- 终止不等于回滚；没有 cancel 端口。
- 内存存储不持久；持久化用 `./pg` 适配器，它同样不提供队列或公平调度。

## 消费端验证

两个独立游戏的 v0.2 接入、发现的核心问题、验证边界和使用评价见 [游戏接入报告](game-integration-v0.2.md)。
