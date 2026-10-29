# Decision Loop

A plain community plugin uses only `@agnes/extension-api`: `request/get/wait` hold a human phase confirmation, and the existing Loop checkpoint holds its stage and handle. Install the package and select `providers.loop: { provider: "example.decision", version: "1.0.0" }` in your profile. Enqueue any input, query the session's pending decisions, and answer the offered `continue` or `reject` through the authenticated client command. The plugin cannot answer its own request.

Close and reopen the Host while parked: the same request ID, full subject and original expiry remain. The `request` checkpoint is saved before asking, so recovery from the gap before the waiting checkpoint reuses the original operation/key. A human answer is consumed once in the same commit as the next pure checkpoint. This synthetic phase has no effect intent and issues no tool grant. Local waiter cancellation leaves the request pending; session stop revokes its execution scope.

普通社区插件仅使用 `@agnes/extension-api`，通过 `request/get/wait` 提出阶段确认，通过已有 Loop checkpoint 保存阶段和 handle。安装后选择 `example.decision@1.0.0`，提交输入，用已认证客户端回答实际提供的 `continue` 或 `reject`。插件不能自行答复。等待时关闭并重新打开 Host，仍恢复原 ID、完整内容与原期限；批准和下一纯阶段 checkpoint 同批消费，不产生工具授权或外部效果。
