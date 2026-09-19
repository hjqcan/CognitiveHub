# 开发与验证

## 环境

参考验证环境：Node.js 22.16.0、TypeScript 5.8.3。核心只用标准 ECMAScript/Web API，不依赖 Bun 专属 API。Bun 可以作为后续运行时验证目标；本次没有执行 Bun 兼容性测试，不把“理论可移植”写成“已认证兼容”。

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run demo
node examples/digital-workspace.mjs
```

TypeScript 配置开启 strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess、noUnusedLocals 和 noUnusedParameters。测试用 Node 原生 test runner，不需要 Jest/Vitest 或真实网络。

## 测试组织

| 文件 | 验证内容 |
| --- | --- |
| plugins.test.mjs | 依赖顺序、启动批次隔离、失败回滚、LIFO 清理、服务声明、作用域、drain、异步清理与重新激活 |
| hub.test.mjs | 默认预览、授权、claim 后过期、单飞、幂等、资源锁、未知结果、accepted 核验、迟到回调租约、不可变快照、故障 |
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

离线测试证明本实现针对列出的输入和失败场景遵守相应契约，不证明现实机器人安全、在线模型正确率、硬实时性、进程重启恢复或跨机器 exactly-once。

自动化工作流只运行类型检查、离线单元测试和模拟示例，不接触 API 密钥或实际设备。
