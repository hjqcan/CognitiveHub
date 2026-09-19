# ADR 0002 — 执行记录可跨进程恢复，恢复只查询不重发

状态：已采用。日期：2026-09-19。

## 背景

v0.1 的 `reconcile()` 依赖进程内的插件租约和执行上下文；原进程不在就明确拒绝。动作身份包含 PluginHost 实例内的激活代次 `activation`，新进程从 1 重新计数，重启后同一 operationId 的重试会被判成“另一个动作”。v0.2 要让宿主交付的目标跨进程持续推进，第一步必须先让执行记录本身可恢复，再谈 Run 与运行时。

## 决策

1. **动作身份不含 activation。** `action.id` 与执行 fingerprint 只包含插件 ID、插件版本、能力 ID、候选 key、参数、资源、效果类型和作用域。activation 保留为字段，只用于把提案绑定到一次激活；“重新激活即旧提案失效”由 execute 时按 activation 取租约保证。插件版本参与身份：版本变了的重试是 `operation-mismatch`，不是重复。
2. **恢复按精确版本重新绑定，且只用于查询。** 新进程按 `(pluginId, pluginVersion 精确相等, capabilityId, 记录的 intent.scope)` 向 PluginHost 取租约，只调用 reconcile/verify，绝不 execute。找不到兼容实现返回 `unavailable-capability` 或 `plugin-version-mismatch`，记录与资源预留原样保留。不做 semver 兼容匹配。
3. **恢复复用进程内的租约与终态释放逻辑。** 采纳的记录进入同一张 pending 表，插件 stop 会等待它，终态后释放；迟到回调不会覆盖已记录状态。
4. **journal 的最小扩展。** `unsettled()` 必填；`MemoryJournal` 从导出的记录数组重建并重新占用资源；记录带 `createdAt/updatedAt`。落盘方式由宿主决定，核心不引入数据库依赖。
5. **无变化不写修订。** 查询没有学到新信息时不写新修订，`unchanged: true` 严格表示“本次没有写入”；查询失败返回 `reconcile-failed` 而不是伪装成无变化。
6. **一份 journal 同一时刻只由一个 Hub 实例驱动。** 并发推进时 CAS 保证单一赢家，输家得到 `journal-conflict` 并在下次核对收敛；这是保护，不是多写者支持。

## 代价

- 契约破坏性变更：`ExecutionResult.rejected` 增加必填 `code`，`ExecutionRecord` 增加时间戳，`ExecutionJournal` 增加 `unsettled()`。包尚未发布，无外部实现。
- 精确版本匹配意味着升级插件前必须先把它的未终态记录核对到终态，或者保留旧版本插件直到核对完成。
- 没有自动恢复循环、跨进程所有权租约、PostgreSQL 存储。这些属于 v0.2 的后续 PR。
- verify/reconcile 拿到的 observation 是旧快照，能力作者必须只把它当标识符用。
