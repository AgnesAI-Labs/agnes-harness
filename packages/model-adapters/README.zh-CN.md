# 模型 adapter

可选 adapter 通过 `modelAdaptersPlugin` 注册（`inject: ["modelAdapters"]`）。`scripted` 与 `replay` 不需要网络或凭证。

- `scriptedAdapter.create(config)` 读取 `route.compat.file` 指定的绝对路径。文件格式：`{ "schemaVersion": 1, "replies": [[{ "type": "text_delta", "delta": "Hello" }, { "type": "usage", "tokens": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0 }, "creditSource": "estimated" }, { "type": "done", "reason": "stop" }]] }`。
- `recordModelResponses(instance, absoluteFile)` 包装任意模型 adapter 实例，以独占方式创建权限为 0600 的 v1 回复 JSONL 文件。请求含提示词，不含 adapter 凭证；请妥善保存。销毁 wrapper 会关闭文件和上游实例。
- `replayAdapter.create(config)` 读取 `route.compat.file`。默认 `match: "strict"` 比较 kind、slot、system、messages、tools、sampling，忽略路由、会话 ID 和派生 hash。显式 `match: "sequence"` 为不同 loop/compaction 提示词提供相同回复。耗尽或不完整记录直接失败，不会回退到付费模型。

每个新会话有独立回复游标。一份 transcript 只能包含一个模型路由；文件包含多个录制会话时，用 `compat.recordedSession` 指定来源。同一会话路由内的并发调用会被拒绝。回复必须以单个 `done` 或 `error` 结束；被取消的调用会消耗游标。不模拟原始耗时。保留 token 与工具调用事件。

这些 adapter 可用于 profile 的 package row 和 registry catalog，使用公开的 `defineModelAdapter`。路由和模型选择由 Host profile composition 管理。
