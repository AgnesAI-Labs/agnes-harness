# 测试你的插件

[English](testing.md) | 简体中文

[作者工具包](README.zh-CN.md) · [快速上手](quickstart.zh-CN.md)

业务 Agent 可以作为插件交付，并通过可重复的离线测试验证。作者统一从 **`@agnes/host/author-testkit`** 导入 helper。当前 SDK 为源码预览版，先按[快速上手](quickstart.zh-CN.md)链接匹配的依赖；脚本模型和回放测试不需要模型账号或 API key。

## 运行插件已有测试

```sh
npm run build                       # 分发模板先构建；源码模板可跳过
agh plugin test .
agh plugin test ./my-plugin -- --test-name-pattern approval
```

`agh plugin test [folder] [-- <测试运行器参数>]` 薄封装插件已有的 `scripts.test`，使用已安装的 Node/npm 和测试依赖，透传退出码和输出。它使用临时 home，去掉继承的凭据和 Node 注入选项，禁止 npm 下载及 pre/post test 生命周期脚本；不安装依赖、不启动后台。`--` 后的参数交给插件测试运行器。[模板](../../templates/)使用 Node test runner，[知识问答](../../examples/fde/knowledge-qa/)和[运维手册](../../examples/fde/ops-runbook/)使用 Vitest。

## 挂载并调用工具

```js
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { main } from './dist/index.js'

const fixture = await createPluginTestHost(main)
try {
  console.log((await fixture.invoke('plugin_hello_tool', { message: 'hello' })).structured)
} finally {
  await fixture.dispose()
}
```

轻量 fixture 挂载经过验证的第三方 row，通过生产 Host 注册桥注册工具，验证参数，并在 dispose 时释放注册和插件 effect。未提供的 I/O 默认拒绝；可通过 `context` 注入明确的工具端口，或用 `services` 注入业务 Loop 的公共服务替身。`invoke(name, args, signal)` 支持协作式取消；重复注册和挂载失败会拒绝创建。

轻量 fixture 直接执行工具，不生成会话审批或 ledger。需要持久化策略、审批和效果事实时使用下面的完整会话工具。

## 真实会话、审批、ledger 与热升级

```js
import assert from 'node:assert/strict'
import { createAuthorTestkit } from '@agnes/host/author-testkit'
import { main as v1 } from './v1.js'
import { main as v2 } from './v2.js'

const kit = await createAuthorTestkit({
  plugin: v1, version: '1.0.0', approval: async () => 'rejected',
})
try {
  const old = await kit.openSession()
  const pin = old.generation
  await old.invoke('business_write', { value: 'synthetic' })
  await old.assertApproval('rejected')
  await old.assertRefused('business_write')
  console.log(await old.facts(), await old.effects())

  const head = await kit.reload({ plugin: v2, version: '2.0.0' })
  old.assertPinned(pin)
  const fresh = await kit.openSession()
  fresh.assertPinned(head)
  assert.notEqual(head, pin)
} finally {
  await kit.dispose()
}
```

完整 fixture 装配真实 Host/Core，使用隔离 SQLite ledger 和正常 runtime generation。默认 `author.invoke` Loop 通过 Core 策略、审批与 effect 路径调用工具。审批默认 `rejected`；需要允许时明确返回 `allowed-once`、`allowed-session` 等支持的 verdict。`assertApproval` 读取持久审批事实。`assertRefused` 检查最后一次匹配调用的错误结果及执行 intent 缺失；先执行再返回错误不能冒充拒绝。

验证插件注册的业务 Loop 时，调用 `kit.openSession({ loop: { id: 'acme.business', version: '1.0.0' } })`，再 `session.enqueue('合成请求')` 和 `session.drive(5)`。最多推进五条公共 Loop edge，遇到 idle、parked 或 turn-end 停止；可继续 `drive(N)` 并查看 `facts()`/`effects()`。传 AbortSignal 可取消。直接 `invoke` 使用另开的默认会话。

`reload` 要求新版本，通过生产 Host 发布新 generation。已有会话保留代码和 Loop pin，新会话采用新 generation。返回值是 testkit 默认 preset 与 Loop 实际选择的 pin；`reload` 创建并关闭一个临时会话，不推进 Loop step，随后释放该会话的 pin。单次 `openSession` 显式选择其他 Loop 时，可能进入另一 composition。除 pin 外还应断言可观察的工具结果，覆盖工具执行途中升级及候选失败后旧 generation 仍可用。fixture 通过受控 importer 注入已导入的作者模块，并生成带 hash 的合成 snapshot 文件及 generation 归档。它验证注册与 pin；源码 Loader 转译、打包和安装另行验证。sandbox/network 使用测试 seam，不能为任意插件代码提供操作系统隔离。

## 录制一次，离线回放

```js
import { recordModelFixture, replayModelFixture, ScriptedProvider, fakeRequest } from '@agnes/host/author-testkit'

const recorder = await recordModelFixture(new ScriptedProvider({ scripts: [[
  { type: 'text_delta', delta: '已检查合成账户。' },
  { type: 'done', reason: 'stop' },
]] }), './model.fixture.json', { secrets: ['synthetic-private-value'] })
try {
  for await (const event of recorder.provider.infer(fakeRequest(), {
    signal: new AbortController().signal, toolNames: [],
  })) console.log(event.type)
} finally {
  await recorder.close()
}
const replay = await replayModelFixture('./model.fixture.json')
for await (const event of replay.provider.infer(fakeRequest(), {
  signal: new AbortController().signal, toolNames: [],
})) console.log(event.type)
replay.assertConsumed()
```

需要明确录制真实模型交互时，用同一方式包装已配置的真实 `Provider`。录制器不获取或保存 key；fixture 文件独占创建、不覆盖已有文件，权限 `0600`。请求/响应头、敏感字段、常见凭据文本和二进制 payload 会移除或脱敏，会话/工具/请求 ID 转为确定性别名。自由文本中的私有值用 `secrets` 或 `redactText` 处理，分享前检查 fixture；回放输入包含这些私有值时使用相同脱敏选项。

回放严格匹配规范化输入，保留事件顺序和失败前缀，为实际请求重新生成 `sent` stamp。请求变化、脚本耗尽、额外会话、非法 schema 和未完整录制会拒绝。每个新会话在首次模型调用时绑定下一个已录制会话脚本；`assertConsumed()` 检查所有脚本及调用。它不发起模型网络请求。将 `replay.provider` 传入 `createAuthorTestkit({ plugin, version, provider: replay.provider })`，即可驱动真实业务 Loop。

完整 fixture 使用传入 Provider 的模型目录，默认选择第一个模型；空目录会被拒绝。

## 编程 HTTP/SSE 故障

```js
import { startModelFaultServer } from '@agnes/host/author-testkit'
const server = await startModelFaultServer([
  { kind: 'http', status: 429, retryAfterMs: 1000 },
  { kind: 'http', status: 503, latencyMs: 20 },
  { kind: 'truncated', chunks: [{ choices: [{ delta: { content: 'partial' } }] }] },
  { kind: 'malformed', raw: 'data: {broken-json\n\n' },
  { kind: 'sse', chunks: [{ choices: [{ delta: { content: 'recovered' } }] }], chunkDelayMs: 5 },
])
try {
  // adapter 指向 server.baseUrl + '/v1'；每次 HTTP 尝试消耗一个条目。
  // 驱动 adapter 并断言错误/恢复后：
  server.assertConsumed()
} finally {
  await server.close()
}
```

服务器只在 `127.0.0.1` 的临时端口监听。`latencyMs` 延迟响应头，`chunkDelayMs` 控制 SSE 间隔。成功 SSE 以 `[DONE]` 结尾，截断不发送它（`reset: true` 销毁连接），畸形 SSE 发送 raw 文本。HTTP 状态、body 和 Retry-After 均可编程；不保留请求头或正文。脚本耗尽返回 HTTP 500/`FIXTURE_EXHAUSTED`，消费断言识别多余或遗漏请求。`close()` 中止延迟、关闭连接，可重复调用。

## 小型 Loop 和 adapter 合同

同一入口保留 `driveLoop`、`scriptedModel` 和 `runModelAdapter`。`driveLoop(factory, { inputs, replies, checkpoint, maxSteps })` 创建/恢复实际 driver，记录请求、事件和 checkpoint，并在完成/失败时 dispose；超过 `maxSteps` 会失败。缺失受控 ledger 端口会拒绝访问，持久审批、恢复和 effect 使用完整会话 fixture。`scriptedModel` 暴露 `requests` 和 `remaining`。

`runModelAdapter` 创建真实 adapter 实例，记录目录/事件并在 finally 中 dispose。[adapter 模板测试](../../templates/model-adapter/test/adapter.test.mjs)使用该合同。替换确定性回复时补上提供方 fixture 与故障脚本。浏览器挂载、MCP 连接、真实提供方和平台 sandbox 使用各自的集成验证。

## 经 Host 验证提供器

`@agnes/extension-api/testkit` 与 `@agnes/plugin-runtime/testkit` 导出 `loopConformance`、`modelAdapterConformance`、`compactionConformance`、`toolRuntimeConformance`、`toolPolicyConformance`、`persistenceConformance`、`sandboxConformance`、`childAgentConformance`，共用 `runProviderConformance(kind, options)`。

在隔离的普通 Host 插件中捕获 `ctx.providers`，传入该端口、所有者包名、全新提供器与 `open(provider)`。Probe 走 Host 的公共服务/会话路径，返回 `start(signal)`、`close()`；loop/persistence 还需 `coldResume()`。每次操作返回 `{ ready, result }`：到达提供器时 ready 完成，排空后 result 完成。原生 API 返回取消结果而非抛出 AbortError 时，用 `isCancelledResult(result)` 校验；操作未结束就完成卸载会失败。

[Host conformance](../../packages/host/test/assemble/provider-conformance.test.ts)覆盖模型、压缩、工具运行时和策略；[所属资源 probe](../../packages/host/test/assemble/provider-owned-conformance.test.ts)覆盖循环、持久化、沙箱、子代理，包括新 Host 冷恢复。

持久化操作没有 `AbortSignal`，probe 可声明 `cancellation: 'unsupported'`，报告 `cancel-unsupported`，仍须在卸载时排空。用 `unloadStarted()` 在注销开始后释放受控调用，确认结束前 store 未关闭。其他类型必须通过取消检查。循环 probe 可通过 `Session.step()` 观察驱动调用，通过冷恢复的 `Session.run()` 检查回合及持久 checkpoint。生命周期 suite 不替代提供器专项可观察断言或 generation 升级测试。

可选的 Vitest 持久化合约测试从 `@agnes/extension-api/testkit/persistence-contract` 单独导出。通用 testkit 可在 Node 测试运行器中导入，无需 Vitest。
