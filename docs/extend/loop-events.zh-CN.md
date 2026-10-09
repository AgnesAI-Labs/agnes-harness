# 循环事件

[English](loop-events.md) | 简体中文

普通插件注入 `loopEvents`，通过 `on(name, handler)` 注册。处理函数接收负载快照与 `{ session, signal }`，通过返回补丁转换负载；注销跟随插件生命周期。

| 事件 | 行为 |
| --- | --- |
| `before_model_request` | 沿用 `before_request`，转换采样参数、输出上限和元数据 |
| `after_model_response` | 观察模型文本、思考内容和停止原因 |
| `before_tool_call` | 沿用 `tool_call`，允许或拒绝调用 |
| `after_tool_result` | 沿用 `tool_result`，转换工具结果 |
| `turn_end` | 观察账本提交后的回合结束原因 |

```ts
import type { LoopEventsPluginContext } from '@agnes/extension-api'
export const plugin = {
  inject: ['loopEvents'],
  apply(ctx: LoopEventsPluginContext) {
    ctx.loopEvents.on('before_model_request', () => ({ patch: { maxTokens: 1024 } }))
    ctx.loopEvents.on('turn_end', ({ reason }) => { console.log(reason) })
  },
}
```

已有 hook 只运行一次，随后监听器按注册顺序执行；后面的转换器看到前面的结果。工具拒绝不可撤销。前置失败阻止执行；结果及观察事件失败保留已有值。每个监听器有两秒上限并接收取消信号。

自定义循环通过 `LoopContext.model`、`tools`、`events.finish` 获得相同处理。运行时还提供 `events.dispatch`，用于显式边界；不要在自动发出事件的操作周围重复调用。为兼容旧测试端口，该字段在类型中为可选。自定义 wire 请求只接受协议支持的采样字段和输出上限，不支持的补丁明确失败。

参见[工具运行时与策略](tool-runtime.zh-CN.md)。
