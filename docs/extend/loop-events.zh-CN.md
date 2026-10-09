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

## 人工控制

`LoopFactory` 可声明 `controls: { steer: true, interrupt: true, pause: true }`。未声明的控制由 Core 拒绝，返回 `E_UNSUPPORTED` 和 `detail.reason = "LOOP_CONTROL_UNSUPPORTED"`。包括 generation 发布期间，Core 始终依据会话绑定的 factory。取消仍属于 driver 生命周期。

在调度边完成后通过 `ctx.input.claim("next-step")` 接收 steer；不要在工具批次运行中接收。暂停阻止下一条边，保留同一 turn 和 checkpoint，浏览器重载与冷恢复均保持暂停。立即打断合作取消当前执行，收集可用回执，再接受选中的排队输入。已提交效果仍有记录，缺少回执的效果仍属未知。排队、交付、修改、撤回及控制结果均由 Core 记为带操作者和时间的 ledger 事实。
