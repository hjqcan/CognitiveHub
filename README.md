# CognitiveHub

**可嵌入、插件优先的认知中间件。** 人类或慢思考系统定义目标与边界，快速决策后端在已安装能力中选择下一步，宿主系统负责真实执行与最终授权。

不是交易机器人，不是机械臂控制器，也不是要求你重写现有平台的全能 Agent 应用。

```text
人类 / 慢思考 / 专业规划器
           │ 目标、策略、约束
           ▼
  CognitiveHub.propose()
  状态 → 插件能力 → 有界候选 → Jev / 其他决策器
           │ 不可变、短期有效的 Proposal
           ▼
  CognitiveHub.execute()          默认 dry-run
  最新授权 + 状态版本 + 前置条件 + 资源预留
           │ 显式 live: true
           ▼
  能力插件 → 宿主 RMS / RBS / 技能 / 软件服务
           │ accepted ≠ completed ≠ verified
           ▼
  CognitiveHub.reconcile() → 核对外部事实与验证结果
```

## 当前状态

这是 **v0.1 foundation**：可以编译、测试、运行模拟闭环的底层实现，不是生产机器人控制系统。

已实现：类型化契约；依赖驱动的插件激活与回滚；作用域能力注册；能力停用与在途排空；有限候选构造；直接 Jev HTTP 适配；状态/策略过期拒绝；默认预览；单次提案消费；进程内幂等与资源预留；未知结果核对；人工请求收件箱；内存事件记录；journal 导出/导入与进程重启后对未终态记录的查询核对；不含进程内激活代次的稳定动作身份；机器可读的拒绝码；可选的托管运行时（Run 生命周期、`step()` 串行推进、目标验收端口、结构化等待与唤醒、四类慢思考回应、每步批准模式、预算与无进展检测、Run 所有权租约、Run 存储导出/导入）。

已实现（存储）：PostgreSQL 适配器 `@cognitive-hub/core/pg`，注入式 SQL 客户端、每个操作一条语句、与内存实现共用一套一致性测试。

已实现（可观测）：决策记录（每轮 propose 考虑了什么、被策略排除了什么、决策器看到了什么、选了什么、对应哪条执行记录）与只读回放（时间线、用另一个决策器重评）。

尚未实现：outbox、内置后台循环（宿主调度 `due()` / `step()`）、分布式资源锁、网络认证服务、签名执行许可、插件沙箱/市场、MCP、C# SDK、真实机器人适配器、任意目标规划、取消/补偿端口。详见 [实现边界](docs/architecture.md) 和 [路线图](docs/roadmap.md)。

原始 [v0.1 蓝图](docs/cognitive-hub-v0.1-blueprint.md) 保留不改；其中的 Issue 应用和大平台规划不是当前实现。本仓库以嵌入式插件内核为基线。

## 快速开始

需要 Node.js 22+。TypeScript 严格模式，**零运行时依赖**；开发依赖只有 TypeScript 5.8.3 和用于离线验证 SQL 适配器的 PGlite 0.5.8。

```bash
npm install --ignore-scripts
npm run check
npm run demo
node examples/digital-workspace.mjs
```

默认示例不需要密钥、不联网、不操作设备。预期输出包括：

```text
Decision: proposal
Default: dry-run
Submitted: pending
Verified: verified
Retry unchanged: true
```

重启恢复示例分两次运行：第一次派发后直接退出（模拟崩溃），第二次从导出的 journal 重建并只做查询核对：

```bash
d=$(mktemp -d)
node examples/restart-recovery.mjs "$d" submit
node examples/restart-recovery.mjs "$d" recover
```

```text
Submitted: pending
Recovered: verified
Submissions: 1
```

Jev 联网调用必须显式启用，会将示例状态发送到 TypeSafe，并可能产生 API 费用：

```bash
export TYPESAFE_AI_API_KEY='your-key'
export JEV_MODEL='jev-1.13.0'
node examples/robot-platform.mjs --jev
```

适配器依据 [TypeSafe HTTP API](https://docs.typesafe.ai/api) 实现。模型版本由调用者明确指定；仓库离线测试不证明线上模型可用性、准确率或机器人安全性。

## 最小接入

下例是装配方式；完整可运行代码见 [机器人平台示例](examples/robot-platform.mjs)。

```ts
import { CognitiveHub, PluginHost, HumanInbox } from '@cognitive-hub/core';
import { jevPlugin } from '@cognitive-hub/core/jev';

const plugins = new PluginHost();
plugins.install(yourCapabilitiesPlugin, ['tenant-a', 'robot-01']);
plugins.install(jevPlugin({ apiKey, model: 'jev-1.13.0' }));
await plugins.start();

const hub = new CognitiveHub({
  plugins,
  state: yourStateProvider,
  policy: yourHostPolicy,
  decision: plugins.resolve('decision.v1'),
  deliberation: new HumanInbox(),
});

const proposal = await hub.propose(intent);
if (proposal.kind === 'proposal') {
  const preview = await hub.execute(proposal.id, 'logical-operation-42');
  // 宿主批准后才调度；同一逻辑动作重试必须复用同一个 operationId。
  const execution = await hub.execute(proposal.id, 'logical-operation-42', { live: true });
}
```

包尚未发布到 npm（`private: true`）。克隆仓库后可构建，或在本地项目中用 `file:` 依赖。上述示例中的宿主端口需要由你的系统提供，不是仓库自带的机器人实现。

## 托管运行时（可选）

宿主也可以交付一个完整目标，让运行时持续推进。它不在后台循环：宿主在事件到达或 `due()` 到期时调用 `step()`，每次至多派发一个动作；目标完成必须由 `GoalEvaluator` 用宿主证据确认。只在世界出现事情时才需要行动的 Run 可以用 `idle: 'wait'` 启动：没有候选时等待状态变化，而不是请示。完整说明见 [托管运行时](docs/runtime.md)。

```ts
import { IntentRuntime, HumanInbox } from '@cognitive-hub/core';

const runtime = new IntentRuntime({
  plugins, state: yourStateProvider, policy: yourHostPolicy, decision: plugins.resolve('decision.v1'),
  deliberation: new HumanInbox(), goal: yourGoalEvaluator, owner: 'worker-1',
});
const run = await runtime.start({ intent, approval: 'automatic',
  budget: { maxDecisions: 50, maxActions: 20, maxNoProgress: 3, deadlineAt: null } });
for (const id of await runtime.due()) await runtime.step(id);
// 慢思考回应经宿主认证后交给 respond()：fact / guidance / approve / terminate 四类，旧提案永远不会被直接执行。
```

## PostgreSQL 存储（可选）

journal 与 run store 各有一个 PostgreSQL 适配器。它们不引入驱动，只依赖注入客户端的 `query(text, values) → { rows }`，node-postgres 的 Pool 可以直接传入；每个操作是一条 SQL 语句，原子性由 PostgreSQL 保证。

```ts
import { Pool } from 'pg';
import { migrate, PgJournal, PgRunStore } from '@cognitive-hub/core/pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);   // 幂等建表，表名前缀 cognitive_hub_
const runtime = new IntentRuntime({ ...ports, journal: new PgJournal(pool), runs: new PgRunStore(pool) });
```

离线测试用 PGlite（编译成 WebAssembly 的真 PostgreSQL）运行同一套一致性测试和验收链路。设置 `COGNITIVE_HUB_PG_URL` 并自行安装 `pg` 后，同一套测试会额外对真实服务器运行，连接串写进 `.env` 后也可用 `npm run test:pg`；CI 未接入真实服务器。

## 决策记录与只读回放（可选）

配置 `decisions` 后，每轮 `propose()` 写一条 `DecisionRecord`：观测版本、未被请求的能力、每个能力产生的候选数、被策略排除的动作与原因、决策器看到的完整请求、决策、结果、错误码，执行 claim 后回填 journal 记录 ID。它回答"为什么这次没选那个能力"，写入失败只计数，不改变执行结果。

```ts
const decisions = new MemoryDecisionStore();            // 或 new PgDecisionStore(pool)
const runtime = new IntentRuntime({ ...ports, decisions });
const entries = await timeline({ decisions, journal: runtime.hub.journal, runs: runtime.runs }, { runId });
const check = await reevaluate(await decisions.list({ tag: { key: 'runId', value: runId } }), anotherDecider);
```

`node scripts/replay.mjs <dir> --run <id>` 从导出的 JSON 打印时间线；`--reevaluate jev` 会把记录的状态发送给 TypeSafe 重新判断并统计一致率，需要显式设置密钥。回放绝不构造 Hub，绝不派发动作。

## 插件带来的是什么？

插件通过 `setup(ctx)` 注册能力和服务，通过 `manifest.requires/provides` 声明依赖。一个能力包含 `prepare → validate → check → execute → verify`，必要时提供只查询、不重放的 `reconcile`。

“装卸机器人”和“人形机器人”改变的是状态、技能与宿主适配器，不是认知内核。数字工作区示例使用完全相同的内核，证明代码没有写死机器人领域。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与边界](docs/architecture.md) | 对象、控制权、状态机、并发、失败语义 |
| [插件开发](docs/plugins.md) | 服务依赖、能力契约、作用域、排空、信任边界 |
| [宿主接入](docs/integration.md) | RMS/RBS、人形机器人、C# 接入方向 |
| [测试与开发](docs/development.md) | 验证命令、测试覆盖、贡献约束 |
| [参考实现分析](docs/references.md) | 从 jev-trader / dsh 借鉴什么、明确不照搬什么 |
| [架构决策 0001](docs/adr/0001-foundation.md) | 技术栈与首版取舍 |
| [架构决策 0002](docs/adr/0002-durable-recovery.md) | 动作身份、跨进程恢复只查询不重发、单实例驱动约定 |
| [托管运行时](docs/runtime.md) | Run 生命周期、step 顺序、等待与唤醒、慢思考往返、预算、恢复 |
| [架构决策 0003](docs/adr/0003-managed-runtime.md) | 为什么是显式 step 而不是后台循环，Guidance 与 Policy 的分离 |
| [架构决策 0004](docs/adr/0004-postgres-adapters.md) | 注入 SQL 客户端、每操作一条语句、用 PGlite 离线验证 |
| [架构决策 0005](docs/adr/0005-decision-records.md) | 决策记录只来自已计算的内容、写入失败不致命、回放不执行 |
| [架构决策 0006](docs/adr/0006-v021-correctness.md) | 停止要求、派发期限、事件消费与通知 outbox 的持久化边界 |
| [架构决策 0007](docs/adr/0007-step-cost.md) | 单步开销与 Run 历史无关：终态游标、到期查询、安静检查、观测复用 |
| [架构决策 0008](docs/adr/0008-decisions-and-text.md) | 决策失败的等待策略、单步可追溯、自由文本上限、Jev 内置选项 |
| [安全说明](SECURITY.md) | 为什么进程内插件不是沙箱 |
| [路线图](docs/roadmap.md) | 从基础内核到真实宿主的验收条件 |

## 重要边界

Hub 的模型概率不是动作成功率；插件描述不是授权；`live: true` 只是调用开关，不代替宿主授权。独立安全系统、资源所有权和最终原子性检查始终由宿主负责。

执行超时属于“结果未知”，不等于“没有发生”。本实现不会自动重试执行动作。未知操作会持续持有本进程资源预留，直到 `reconcile()` 通过能力的独立证据确认结果。

进程重启后，新进程可以从导出的 journal 重建记录，按插件 ID、精确插件版本和能力 ID 重新绑定当前实现，然后只查询核对，不重发。找不到兼容实现时记录保持阻塞并返回稳定的拒绝码。一份 journal 同一时刻只应由一个 Hub 实例驱动。托管运行时的 Run 有所有权租约：同一 worker 重启后接管自己的租约，其他 worker 要等它过期；这是单工作进程的崩溃恢复，不是分布式调度。
