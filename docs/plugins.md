# 插件开发协议 v1

## 安装的是模块，注册的是能力

一个 Plugin 包含 manifest 和 setup。包由项目维护者用正常的包管理/代码审核流程安装，再显式 import 并 `plugins.install(plugin, scope)`。当前没有网络下载器、插件市场、任意目录扫描或自动运行 npm install。

```ts
import type { Plugin } from '@cognitive-hub/core';

export const recoveryPlugin: Plugin = {
  manifest: {
    apiVersion: 1,
    id: 'company.recovery',
    version: '0.1.0',
    requires: ['host.tasks.v1'],
  },
  setup(ctx) {
    const tasks = ctx.service<YourHostTaskGateway>('host.tasks.v1');
    ctx.capability(makeRecoveryCapability(tasks));
    ctx.onDispose(() => releasePluginOwnedResources());
  },
};
```

这里的 YourHostTaskGateway/makeRecoveryCapability 是你自己的实现；完整可运行插件见 `examples/robot-platform.mjs`。

## 服务依赖

`requires` 声明要读取的服务；`provides` 声明会贡献的服务。先安装 consumer 再安装 provider 也可以，`start()` 按依赖激活。

重复 pluginId、重复服务、未声明服务访问、声明但没有提供的服务都会失败。缺失/循环依赖不会无限等待。一次 start 中新激活的模块失败后，会逆序撤销该批贡献；已经存在的 active 模块不受影响。

服务契约通过 `host.tasks.v1` 这样的版本化 key 固定。首版不做 semver 匹配、嵌套容器或同名服务自动覆盖。

setup 结束后贡献窗口关闭。不要保留 ctx 在后台异步注册能力。setup 已完成的注册和 `onDispose()` 都纳入逆序清理；某个 disposer 抛错不会阻止后续清理。

## 能力契约

| 成员 | 责任 |
| --- | --- |
| `id` | 带语义版本的能力 ID，如 `robot.request-recovery@1` |
| `description/effect` | 给认知层和策略层看的元数据，不是安全证明 |
| `prepare` | 只读地生成有限、已绑定的候选，不自行执行操作 |
| `validate` | 运行时校验参数，不能只依赖 TS 类型 |
| `check` | 执行前重查确定性前置条件，无副作用 |
| `execute` | 通过宿主提交动作，传递 idempotencyKey/预期版本 |
| `verify` | 查询独立效果证据，不能只把 HTTP 200 当作 verified |
| `reconcile` | 可选；查询旧请求结果，不重新执行命令 |

候选 `key` 在一个能力的一次 prepare 结果中唯一。input 必须是普通 JSON；resources 是宿主定义的规范资源 ID。写能力必须占用资源。坐标系、单位、精度、取消和完成语义应写进实际领域契约，不要仅靠“统一参数名”。

一个包可以提供多个能力；一个契约可有多个插件提供者。候选绑定具体 pluginId、版本、激活代次和 scope；不会采用“最后安装的同名实现”。

## 执行回执与验证

- accepted：已经受理，必须有 handle，继续等待。
- completed：执行端报告完成，仍须 verify。
- failed：执行端确认该操作已终止且结果为失败；不代表自动回滚。
- unknown：无法确定真实效果，必须查询或由宿主处理。

无法判断是否有副作用时返回 unknown，不要返回 failed。execute 抛错/超时/返回非法结构也按 unknown 处理。验证码、自由文本、运动规划等缺失内容应由慢思考或相应能力提供，不让 Jev 编造。

当前没有取消/补偿端口。中断网络等待不等于取消远端任务。要加入取消能力，应通过新的已授权任务/契约显式实现，不能塞进 dispose。

## 排空与版本更新

`stop(pluginId)` 先让能力不可见，再等待既有 lease。pending/unknown 期间它可能持续等待，这是保护，不是强行杀掉任务的超时。

先核对/终结任务，再停用。不要在 dispose 中发送紧急停机、自动补偿或撤销用户业务操作。

存在 active/draining 依赖者时，不能停止其服务提供者。相同版本重新激活也会增加 activation；此前提案不可继续用。首版不支持升级运行中的二进制/模块实例，也不提供卸载第三方包文件的 API。

## 信任边界

进程内插件具有所在进程的权限。作用域、manifest 和 validate 约束合作插件的行为，不是恶意代码隔离。第三方能力应放到外部 worker/service，经宿主网关提供最小权限接口。不要让模型安装代码、获取凭据或修改 Policy。
