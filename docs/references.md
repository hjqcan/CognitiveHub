# 参考实现与取舍

资料核对：2026-09-19。以下是独立实现的设计参考，不是复制交易代码、Fork 整个 dsh，亦不宣称兼容它们的插件 ABI。

## jev-trader

源码：[src/model.ts](https://github.com/jarrodwatts/jev-trader/blob/main/src/model.ts)、[src/trader.ts](https://github.com/jarrodwatts/jev-trader/blob/main/src/trader.ts)。核对的文件 blob 分别为 `8d3cd3ef264a5d00fe831f6bfbd148a5ad368edd`、`f63ba293112087a3e4f2d7517dde1084c81e5783`。

借鉴：Model 接口与 mock/real 实现分离；紧凑结构化状态；有限选择；单次在途决策；发送与后续回执分开记录。

不照搬：市场数据、账户、交易签名、高频区块循环；在约束阻挡一侧时改为另一侧的领域逻辑；fire-and-forget 后自动继续向共享资源派发。

Hub 采用通用能力候选、严格选择验证和默认预览；动作不合适就拒绝/等待/请求慢思考，而不是静默换动作。pending/unknown 占用资源，先核对后推进。

## DeepSeek Harness / Cordis

参考：[Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)、[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。核对的 primer blob 为 `2e5a48745cf96068bec9e31b0c6f1bf9d84b0e34`。

借鉴：插件贡献服务与能力；声明式服务依赖；可逆注册与生命周期归属；不同产品通过模块组合复用内核。

首版刻意缩小：没有 YAML 表达式、动态任意包加载、Profile/Patch 引擎、Chat UI、Cordis 事件系统或兼容层。install 是显式受信任模块挂载，start 解析服务依赖。能力作用域不等于进程安全隔离。

## TypeSafe / Jev

依据 [HTTP API](https://docs.typesafe.ai/api) 实现真实请求结构 `model + state + questions`，读取 `answers.next` 的 Choice 与概率分布。使用直接 HTTP，避免绑定 experimental SDK 的变动。

[Confidence](https://docs.typesafe.ai/confidence) 说明该字段与分布有关；本实现仅记录，不使用万能阈值放行。校验包含候选集合精确匹配、有限合法概率、归一性和最高概率选项一致性。

[模型边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13) 提醒数值处理、对抗性内容等限制。精确计算、权限、资源锁、参数和最终效果都留在宿主/代码，不交给模型。

开发时仅进行了 mock HTTP 合同测试，没有提供密钥调用真实 Jev，也没有在机器人闭环上做性能或可靠性评测。
