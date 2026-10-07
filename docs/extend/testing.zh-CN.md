# 不用付费模型测试插件

[English](testing.md) | 简体中文

[作者工具包](README.zh-CN.md) · [入门](quickstart.zh-CN.md)

生成包使用 Node 测试运行器：先执行 `npm run build`，再执行 `npm test`。以下 helper 从 `@agnes/plugin-runtime/testkit` 导出；工具注册测试还需要匹配版本的 `@agnes/host`。

## 经真实注册层测试工具

```js
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { main } from './dist/index.js'

const host = await createPluginTestHost(main)
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

`driveLoop` 创建或恢复真实驱动，记录模型请求与事件，并在完成或失败后释放。传入 `checkpoint` 验证恢复和不支持的 codec 版本。遇到结束原因或 `events.finish` 时停止；未完成循环超过 `maxSteps`（默认 20）则拒绝。脚本回复耗尽会报错。

通过插件测试 Host 的 `invoke` 实现 `tools.execute`/`tools.batch`，验证工具调用。[循环测试](../../packages/plugin-runtime/testkit/loop.test.ts)展示脚本回复如何到达真实 Host 注册工具。缺少工具端口会拒绝执行。停车也明确拒绝：驱动验证有限调度，不模拟后台等待或完整会话恢复。

单独测试自己的调度器时可使用 `scriptedModel(replies)`，通过 `requests` 与 `remaining` 检查缺失或多余的模型交互。

## 适配器实例

`runModelAdapter(adapter, { config, route, request, signal })` 创建真实实例，收集 stream 事件与路由/模型目录，并在 `finally` 释放。`mode: 'complete'` 使用可选 complete 方法，未提供则拒绝。注册级 `cleanup` 仍由注册服务管理，不在每次请求后运行。

[适配器模板测试](../../templates/model-adapter/test/adapter.test.mjs)使用 `@agnes/ai/testkit` 的 `fakeModel`/`fakeRequest`，不执行网络 I/O。替换确定性回复时增加提供方请求/响应 fixture，并检查取消、错误和释放。

## 验证范围

行为变化时优先扩展最近的测试。按需覆盖正常输入、schema 错误、业务拒绝、取消、清理与恢复。面板测试检查描述文件、插槽和渲染行为；浏览器挂载需另验。MCP 包测试检查资产与 Skill 注册；真实服务器连通性需另验。

作者测试通过只证明确定性依赖下的合同，不证明真实提供方、浏览器、MCP 服务器或操作系统隔离兼容。

可选的 Vitest 持久化合约测试从 `@agnes/extension-api/testkit/persistence-contract` 单独导出。通用 testkit 可在 Node 测试运行器中导入，无需 Vitest。
