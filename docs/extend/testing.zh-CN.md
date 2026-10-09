# 不用付费模型测试插件

[English](testing.md) | 简体中文

[作者工具包](README.zh-CN.md) · [入门](quickstart.zh-CN.md)

生成包使用 Node 测试运行器：先执行 `npm run build`，再执行 `npm test`。以下 helper 从 `@agnes/plugin-runtime/testkit` 导出；工具注册测试还需要匹配版本的 `@agnes/host`。

## 经真实注册层测试工具

```js
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { createPluginTestRegistration } from '@agnes/host/testkit'
import { main } from './dist/index.js'

const host = await createPluginTestHost(main, { registration: createPluginTestRegistration() })
try {
  console.log((await host.invoke('plugin_hello_tool', { message: 'hello' })).structured)
} finally {
  await host.dispose()
}
```

这会挂载已验证的第三方行，使用生产 Host 的 `ctx.extension()` 注册桥，校验参数并调用真实注册工具。卸载释放行、注册项和插件 effect。重复注册或加载失败会使创建失败。

I/O 默认拒绝。按需通过 `context` 提供明确的假文件系统/网络端口。`invoke(name, args, signal)` 支持取消；释放会中止活动调用信号，工具必须配合处理。这些 helper 不实现会话审批、重放、账本持久化或 OS 隔离。可检查 hook 注册，但不模拟分派。

## 脚本模型回复驱动循环

```js
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { loop } from './dist/index.js'

const result = await driveLoop(loop, {
  inputs: [{ content: [{ type: 'text', text: 'hello' }] }],
  replies: [[
    { type: 'text_delta', delta: 'Hello!' },
    { type: 'done', reason: 'stop' },
  ]],
})
console.log(result.events, result.checkpoint)
```

`driveLoop` 创建或恢复真实驱动，记录模型请求与事件，并在完成或失败后释放。传入 `checkpoint` 验证恢复和不支持的 codec 版本。它使用生产 `loopShouldStop` outcome 规则与 `until`（默认 `turn-end`）；`phase`、单独 reason 或单独 `events.finish` 不会停止驱动。未完成循环超过 `maxSteps`（默认 20）或脚本回复耗尽会报错。

通过插件测试 Host 的 `invoke` 实现 `tools.execute`，验证工具调用；默认 fake batch 委托逐个执行。[循环测试](../../packages/plugin-runtime/testkit/loop.test.ts)展示脚本回复如何到达真实 Host 注册工具。缺少工具端口会拒绝执行。`parked` outcome 停止调度；fake wait 在有队列输入或取消时返回，wake 不执行操作。耐久等待、审批、ledger 操作与恢复应传入真实 Core `context`，参见 [v0.1 合同清单](../develop/contracts-v0.1.zh-CN.md)。

单独测试自己的调度器时可使用 `scriptedModel(replies)`，通过 `requests` 与 `remaining` 检查缺失或多余的模型交互。

## 适配器实例

`runModelAdapter(adapter, { config, route, request, signal })` 创建真实实例，收集 stream 事件与路由/模型目录，并在 `finally` 释放。`mode: 'complete'` 使用可选 complete 方法，未提供则拒绝。注册级 `cleanup` 仍由注册服务管理，不在每次请求后运行。

[适配器模板测试](../../templates/model-adapter/test/adapter.test.mjs)使用 `@agnes/ai/testkit` 的 `fakeModel`/`fakeRequest`，不执行网络 I/O。替换确定性回复时增加提供方请求/响应 fixture，并检查取消、错误和释放。

## 验证范围

行为变化时优先扩展最近的测试。按需覆盖正常输入、schema 错误、业务拒绝、取消、清理与恢复。面板测试检查描述文件、插槽和渲染行为；浏览器挂载需另验。MCP 包测试检查资产与 Skill 注册；真实服务器连通性需另验。

作者测试通过只证明确定性依赖下的合同，不证明真实提供方、浏览器、MCP 服务器或操作系统隔离兼容。

## 经 Host 验证提供器

`@agnes/extension-api/testkit` 与 `@agnes/plugin-runtime/testkit` 导出 `loopConformance`、`modelAdapterConformance`、`compactionConformance`、`toolRuntimeConformance`、`toolPolicyConformance`、`persistenceConformance`、`sandboxConformance`、`childAgentConformance`，共用 `runProviderConformance(kind, options)`。

在隔离的普通 Host 插件中捕获 `ctx.providers`，传入该端口、所有者包名、全新提供器与 `open(provider)`。Probe 走 Host 的公共服务/会话路径，返回 `start(signal)`、`close()`；loop/persistence 还需 `coldResume()`。每次操作返回 `{ ready, result }`：到达提供器时 ready 完成，排空后 result 完成。原生 API 返回取消结果而非抛出 AbortError 时，用 `isCancelledResult(result)` 校验；操作未结束就完成卸载会失败。

[Host conformance](../../packages/host/test/assemble/provider-conformance.test.ts)覆盖模型、压缩、工具运行时和策略；[所属资源 probe](../../packages/host/test/assemble/provider-owned-conformance.test.ts)覆盖循环、持久化、沙箱、子代理，包括新 Host 冷恢复。

持久化操作没有 `AbortSignal`，probe 可声明 `cancellation: 'unsupported'`，报告 `cancel-unsupported`，仍须在卸载时排空。用 `unloadStarted()` 在注销开始后释放受控调用，确认结束前 store 未关闭。其他类型必须通过取消检查。循环 probe 可通过 `Session.step()` 观察驱动调用，通过冷恢复的 `Session.run()` 检查回合及持久 checkpoint。生命周期 suite 不替代提供器专项可观察断言或 generation 升级测试。

可选的 Vitest 持久化合约测试从 `@agnes/extension-api/testkit/persistence-contract` 单独导出。通用 testkit 可在 Node 测试运行器中导入，无需 Vitest。
