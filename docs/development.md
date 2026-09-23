# 开发与验证

## 环境

参考验证环境：Node.js 22.16.0、TypeScript 5.8.3。核心只用标准 ECMAScript/Web API，不依赖 Bun 专属 API。Bun 可以作为后续运行时验证目标；本次没有执行 Bun 兼容性测试，不把“理论可移植”写成“已认证兼容”。

`npm run bench` 打印单步开销随动作数的变化（内存 2000 步、PGlite 1000 步），不进入 `check`；计数是可移植的信号，耗时取决于机器。

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run demo
node examples/digital-workspace.mjs
d=$(mktemp -d) && node examples/restart-recovery.mjs "$d" submit && node examples/restart-recovery.mjs "$d" recover
```

TypeScript 配置开启 strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess、noUnusedLocals 和 noUnusedParameters。测试用 Node 原生 test runner，不需要 Jest/Vitest 或真实网络。

开发依赖另有 PGlite 0.5.8：编译成 WebAssembly 的 PostgreSQL，用来离线运行 SQL 适配器的一致性测试，不进入运行时依赖。设置 `COGNITIVE_HUB_PG_URL` 并自行安装 `pg` 后，同一套测试会额外对真实服务器运行。把连接串写进 `.env`（见 `.env.example`）后可直接 `npm run test:pg`，它用 Node 自带的 `--env-file` 读取，不引入依赖；`migrate()` 会在目标库建 `cognitive_hub_*` 表，请指向一个专用测试库。

## 测试组织

| 文件 | 验证内容 |
| --- | --- |
| plugins.test.mjs | 依赖顺序、启动批次隔离、失败回滚、LIFO 清理、服务声明、作用域、drain、异步清理与重新激活、卸载与重装、按精确版本 rebind |
| hub.test.mjs | 默认预览、授权、策略候选全集、claim 后过期、单飞、幂等、重新激活后的幂等重试、资源锁、未知结果、无查询钩子的证据核验、accepted 核验、迟到回调租约、不可变快照、故障、结果码、无变化不写修订 |
| recovery.test.mjs | 新进程从导出 JSON 重建 journal 后只查询核对；空回执；版本/作用域不匹配阻塞；恢复记录持有租约；外部终态释放本地租约；两个实例并发核对的冲突收敛；查询失败；过期观测；unsettled |
| restart.test.mjs | 真实两次进程：派发后退出，再启动后核对原任务，外部提交计数仍为 1 |
| runtime.test.mjs | 托管运行时：一步一动作、目标先检查、模型 wait 与时间唤醒、事件去重、预算与修订、过期回应、每步批准、guidance 版本、stop/terminate/pause、租约、撤权拒绝、版本变化阻塞、幽灵操作清理、due、意图修订 |
| runtime-chain.test.mjs | v0.2 验收链路（进程内）：第一步完成 → 第二步回执丢失 → 快照重建 → 按键核对不重复 → 缺信息等人 → 补充后完成 |
| runtime-kill.test.mjs | 真实 SIGKILL：worker 在派发中被杀，下一次 worker 按幂等键核对，外部提交计数不变，最终 completed |
| store-conformance.mjs + stores.test.mjs | ExecutionJournal、RunStore 与 DecisionStore 的行为契约：claim 原子性、CAS、终态释放预留、一意图一未终态 Run、事件去重、`due` 的到期判定与排序、畸形记录拒绝、决策去重/回填/按意图与标签查询；对内存实现和 PGlite 上的 PostgreSQL 实现各跑一遍，另测迁移幂等与锁冲突不留残余 |
| decisions.test.mjs | 决策记录：考虑/排除/请求/决策/回填执行记录；无候选与决策器失败的记录；审计存储失败不改变结果；tags 校验 |
| replay.test.mjs | 运行时决策记录带 runId；时间线顺序；用不同决策器重评的一致/不一致/失败；CLI 从导出 JSON 打印时间线且不派发任何动作 |
| runtime-scale.test.mjs | 单步开销与历史无关：内存与 PGlite 上 200 步内每步的 journal 读取、Run 写入、观测、SQL 条数恒定；接受回执路径；旧快照一次追平；验收器收到的 records/operations；游标异常值、幽灵记录、stop 只读窗口；安静检查零写入、残留租约、时间界、与 deliver 并发、双进程无冲突；propose 复用观测 |
| runtime-pg.test.mjs | 验收链路在 PostgreSQL 存储上重跑（回执丢失 + 重启），以及两个 worker 争夺同一 Run 时只有一个拿到租约 |
| jev.test.mjs | 实际 HTTP shape、候选映射、概率校验、错误脱敏、deadline、体积限制 |
| examples.test.mjs | 两个不同宿主使用相同内核，不联网即可完成模拟闭环 |

新增功能先添加能触发缺陷的测试，再修改实现。尤其要检查异步边界：在观察、判断、前置检查、claim、执行、回执保存或 verify 之间取消/撤权/停插件会发生什么。

不要在测试里使用真实硬件、交易账户、生产密钥或具有外部副作用的端点。

## 必须保持的约束

- 原 AGENTS.md 和设计蓝图保留；当前实现文档优先说明实际交付范围。
- 核心不能引用特定机器人、交易、RMS 或 UI 类。
- 能力必须是显式安装的可信模块；不要让模型自主安装代码。
- 不能通过 prompt 代替强制策略；不能把 confidence 当作成功率。
- 不确定的执行结果不能自动重试；接受不等于验证。
- 文档示例区分真实 API、模拟实现和尚未实现的规划。
- 不提交 `.env`、密钥、node_modules、dist 或生产数据。

## 本次验证的含义

离线测试证明本实现针对列出的输入和失败场景遵守相应契约，不证明现实机器人安全、在线模型正确率、硬实时性、跨进程互斥或跨机器 exactly-once。重启恢复只在“单进程、一份 journal 由一个 Hub 驱动、插件精确同版本”的前提下验证。

自动化工作流只运行类型检查、离线单元测试和模拟示例，不接触 API 密钥或实际设备。
