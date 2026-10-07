# 压缩引擎

[English](compaction-engines.md) | 简体中文

[作者工具包](README.zh-CN.md) · [测试](testing.zh-CN.md) · [插件管理](../guide/packages.zh-CN.md)

引擎决定何时压缩，以及怎样替换较早的对话上下文。默认引擎保留 AGH 原有的摘要计划、热缓存延迟、溢出恢复、摘要重试、费用记录与省略回退。固定系统段始终位于替换范围之外。

## 注册引擎

通过公开包出口实现 [CompactionEngine](../../packages/extension-api/src/compaction-engine.ts)。`create()` 返回实例，提供 `shouldCompact(budget)` 与异步的 `compact(input, { signal, model })`。在注入 `compactionEngines` 的普通 Cordis 插件中注册：

```ts
import type { CompactionEnginePluginContext } from '@agnes/extension-api'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'

export const main = defineAgnesPlugin({
  inject: ['compactionEngines'],
  apply(ctx: Context & CompactionEnginePluginContext) {
    ctx.compactionEngines.register(engine)
  },
})
```

这里的 `engine` 是你的实现。在 `package.json` 的 `agnes.plugins` 中声明 `main` 和相同注入。注册项属于插件 fiber；重复 id 会被拒绝，卸载会移除目录项并取消进行中的引擎操作。其他资源绑定插件 effect。`catalog()` 提供 id、版本与来源包；Host 也提供 `Assembled.compactionEngineCatalog()`。

`input.conversation` 包含可见节点、轮次、pin 标记、token 估计与事件 payload，不包含已被遮蔽的账本行。`input.system` 是不可替换的固定系统文本。budget 包含当前预留与近期保留 token 目标。`input.beforeCompact` 保留已有计划器词汇，包括触发原因和手动指令。

没有安全缩减方案时返回 `null`。直接替换返回 `{ kind: 'replacement', range: [startSeq, endSeq], text, mode: 'summary' | 'elision' }`；使用 Core 原有摘要执行器则返回 `{ kind: 'plan', plan }`。单次尝试的 `before_compact` hook 仍优先于引擎。

Core 拒绝跨越 pin、拆开工具调用与结果、删除整个对话或替换文本不比原片段更小的结果。替换和压缩事件在同一事务提交，原始账本行与 fork 投影行为保留。异步操作传递取消信号，并在返回前检查取消。

自定义摘要策略可调用 `model.summarize({ range, system, instruction, maxTokens }, optionalSignal)`。Core 安全派生请求，使用会话的 compaction 模型槽，校验窗口、预留树预算、对 reasoning 截断重试一次，并记录实际费用，即使引擎随后拒绝替换。错误与取消进入压缩失败路径。返回 plan 则还使用默认执行器的分类失败、退避和省略回退策略。

## 选择引擎

按[插件管理](../guide/packages.zh-CN.md)安装并启用引擎包，再在运行时 profile 中选择已注册的 id：

```json
{ "compaction": { "engine": "sliding-window" } }
```

省略字段时选择 `default`。显式指定不存在的 id 会使 Host 启动失败，错误为 `compaction engine is not registered: <id>`。选择发生于 Host 组装时；修改后重新组装。已有 preset 控制项，包括 `compaction.enabled`、预留量与 agent 可调用设置，继续生效。

自定义循环在已接受输入的 step 边界调用 `await ctx.compaction?.run(signal)`，使用相同选定引擎。只有存在可运行引擎时该端口才出现；自定义循环自行决定调用时机。

## 试用 sliding-window

独立的 [sliding-window 示例](../../examples/compaction/sliding-window/)保留最近 N 轮、固定系统上下文，不调用模型。默认保留四轮；将插件行 config 设为 `{ "keepTurns": 2 }` 可调整。遇到对话 pin 和工具配对边界时保守地多保留上下文。被省略的事实仍在账本中，但不再进入后续模型请求。

该包提供独立构建与测试脚本，没有 workspace 导入。源码预览阶段先构建 SDK 声明，将示例复制到工作区外，再按[本地连接流程](quickstart.zh-CN.md)构建和测试。小测试提供一个被调用就抛错的模型端口。
