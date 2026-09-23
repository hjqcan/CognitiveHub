# ADR 0008 — 决策可追溯、决策失败的等待策略、自由文本上限

状态：已采用。日期：2026-09-22。

## 背景

三个游戏（飞船、弹幕、浇给）接入 v0.2 后暴露了同一组摩擦：

- **看不到一步做了什么。** `StepResult` 只有 run 与 outcome，宿主比对前后的 `operations`、按标签扫描决策记录。
- **看不到为什么请示。** 内核决策产生的请求 `subject` 为 null，宿主要自己重算候选来猜。
- **看不到谁做的决定。** 飞船的决策路由器让每条记录都写着路由器的名字；浇给跳过模型、自己合成的等待被记成 Jev。
- **决策器暂时失败就停下等人。** 超时、429、529、格式错误、思考中观测过期都进入 `deliberating`。三个游戏都靠 fact 回应或修订意图手动解冻，弹幕的实际决策期限是 2.5 秒的观测有效期，而不是它配置的 10 秒。

## 决策

1. **每轮都有 `decisionId`。** 无论是否配置决策存储都生成，结果、慢思考请求的 subject、决策记录都带着它。`DecisionStore.get(id)` 为可选方法。
2. **`Decision.provider`。** 包装或路由其他决策器的实现写明真正的决定者，记录优先使用它；Jev 适配器写上模型名。
3. **轮次阶段。** `observe → prepare → policy → decide → commit`，只在 `throwIfAborted()` 之后同步推进；失败时对 trace 做快照，超时后仍在运行的回调改不了记录。
4. **结构化的 `DecisionSubject`。** 内容为 `cause`（`no-candidates` / `decider-asked` / `failed`）、`code`、`phase`、`considered`、允许的候选与策略排除项。类型别名而非接口，以便赋给 Json。
5. **`StepResult` 的 `decisionId`、`recordId`、`code`。** 只在发生时出现。
6. **稳定错误码。** 只信任 HubError 与字符串 code。DOMException 的数字旧码（超时 23、不可克隆 25）对宿主没有意义：超时记为 `timeout`，其余记为 `decision-unavailable`。
7. **`onDecisionError: 'deliberate' | 'wait'`。** 默认 `deliberate`，与 v0.2 相同。`wait` 只作用于决策阶段的失败：决策器抛错或超时、输出非法、provider/理由非法、思考期间状态过期、选了不存在的候选。它把失败变成带码的 wait，运行时登记普通的 `[state, time]` 等待。观测、候选准备、策略阶段的失败仍请示：等待修不好适配器错误或授权服务故障。
8. **失败按次计入无进展。** 不看状态是否变化，也不改签名：弹幕每帧状态都变，按“同一状态”计数永远不会触顶；不改签名则穿插的失败掩盖不了重复同一动作的循环。决策器一直不可用时，Run 仍在 `maxNoProgress` 处以 `no-progress` 请求交给宿主。宿主取消（`aborted`）不算失败。
9. **不用观测有效期截断决策。** 运行时的 `now` 可能是可暂停的游戏时钟，而 `bounded()` 用真实计时器，两者混用会制造虚假的过期。改为在文档中要求 `decisionTimeoutMs` 不大于观测有效期。

## 代价

- 统计失败的宿主不能只看 `outcome === 'deliberation'`：wait 模式下的失败是 `outcome: 'wait'` 且 `code` 非空。
- v0.3 之前停下的 Run 的 `request.subject` 仍为 null；回应不受影响。
- 不支持降级：旧版本读不懂新字段，但会忽略它们。
