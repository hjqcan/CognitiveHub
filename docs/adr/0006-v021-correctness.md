# ADR 0006 — v0.2.1：停止、派发期限与持久化边界

状态：采用。基线：772401018ff01bdbed400d0e81bfd9f2ef6ff57f。日期：2026-09-20。

本次修复六类审阅问题，不扩展业务场景，不改变 Core + 可选 IntentRuntime 的分层。

## 停止要求是独立事实

`Run.stopRequested` 是只会被宿主 stop/terminate 设置的持久标志，不能因为恢复受阻进入 deliberating 而丢失。
事实、guidance 和意图/预算修订不会撤销停止要求。恢复后回到 stopping，核对存量动作后 stopped，不再派发新动作。
新 Run 初始化该字段；旧 stopping 快照由状态兼容识别。已被旧版本错误恢复为 active 且丢失停止历史的快照不能自动推断授权，升级前应人工核对。

## 插件代次不属于可卸载的挂载对象

激活代次由 PluginHost 单调分配，uninstall/reinstall 不复用。同版本重装也使旧提案失效。
Core acquire 同时检查预期插件版本；持久恢复仍使用明确的 rebind，只查询旧任务，不执行旧提案。

## 派发期限传到底层

`hub.execute(..., { deadlineAt })` 接收最晚允许派发时间（epoch ms，排他上界）。
Runtime 将 Run deadline 与逐动作批准 expiry 取最早值，Core 再与提案、观察有效期取最早值。
预检之后、journal claim / 审计之后、执行回调入口均检查；context.dispatchDeadlineAt 继续传给能力的宿主网关。
网关若还要排队或做异步工作，也必须在实际副作用发生前校验该期限。Hub 不声称跨远程系统获得原子授权检查。
期限约束的是新的派发，不是强行取消已经受理的外部工作；恢复查询不受过期的派发期限阻挡。

## 事件消费与唤醒是一次 Run CAS

`processedEvents` 与目标状态一起写入同一个 Run 快照。写入失败则两者都不生效；提交成功但回执丢失时，重送只会看到已消费且已唤醒的状态。
Runtime 不再组合 `markEvent()` 与 `replace()` 两次独立写入。原 markEvent 保留为旧独立 API，不用于新的托管事件交付。
此设计复用所有 RunStore 的原子 CAS 契约，不要求驱动暴露池连接事务。

## 人工请求使用内嵌事务 outbox

单个 Run 同时最多等待一个问题，因此将完整消息和投递状态放在 `Run.outbox`，与 request/status 在一次 replace 中原子保存。
Core 在托管 propose 中生成的请求先由 Runtime 接收，而不是直接外发；所有托管请求都走同一条落盘再投递路径。
投递失败或投递成功但确认保存失败时，保留原 message.id。`step()` 重试同一消息；`due()` 在 retryAt 到达时列出待投递 Run。
这是 at-least-once，不是 exactly-once。DeliberationProvider 必须按 request.id 去重。HumanInbox 的 Map 已满足此契约。
有效回应、停止或意图修订会清除旧 outbox，不能再投递过时的问题。
直接调用单轮 Core 的人工请求仍由宿主承担持久化，不假称 Core 自动获得托管 Run 的 outbox。

## PostgreSQL schema v3 与升级

Run 唯一性统一为完整 `intent.scope + intent.id`。先建立完整 scope 的新唯一索引，再删除旧 `(tenant, intent_id)` 索引。
重复 migrate 不会重新创建旧索引。旧事件表中的去重键迁入还没有 processedEvents 字段的 Run；内存导出/导入同样兼容旧事件键。

升级流程：停止旧 worker，备份数据库，调用 `migrate(client)`，确认 schema version 3，再启动新代码。
不要让新旧 worker 混用一份存储：旧 worker 不理解内嵌 inbox/outbox 和 sticky stop。迁移的 DDL 按步骤执行，可重入；不是在线零停机迁移承诺。
旧 deliberating Run 未保存完整通知，无法凭空恢复已丢失正文；宿主应核对并处理这些遗留请求。v0.2.1 新请求包含完整消息。

## 边界与验收

Run 中保存完整事件去重键，不能在 Run 未结束时随意裁剪，否则会恢复重复交付风险。大量事件/长期 Run 未来可将 inbox/outbox 抽到独立表，但必须保留相同事务边界。

新增测试覆盖：stop→恢复受阻→人工回应；同/异版本重装；推理/预检/claim 期间过期；事件 CAS 失败与确认丢失；通知落盘失败、发送失败、确认丢失及重启；跨 scope 唯一性；旧 schema 和事件迁移反复运行。
`tests/v021-regressions.test.mjs` 使用真实 Core/Runtime 和模拟宿主；`tests/v021-pg.test.mjs` 在 PGlite 上运行实际 SQL。
这些测试不等于真实设备测试、在线 Jev 测试或分布式调度认证。
