# Plan-Execute Loop

A non-ReAct example written against `GenericLoopPorts` only (it is typed as `GenericLoopFactory`). It reads no continuation and calls no `model.respond`, `tools.drain`, `turn.checkpoint` or `wait.poll`, so it shows what a replaceable Loop needs from Core. Install it with `agh package add ./examples/loops/plan-execute-loop`, trust and enable `ext:example-plan-execute`, and select `example.plan-execute@1.0.0`.

State machine, checkpointed with codec 1: `input → planning → approving → executing → (tool-parked | awaiting-child) → done`.

- **Plan.** One `model.complete` request replies with a JSON array of at most 8 steps `{ tool, args, awaitChild? }`. Tools must be in the turn's catalog. An invalid plan ends the turn as `PLAN_INVALID`; nothing runs.
- **One human decision.** The plan goes to `ctx.decisions.request` under the stable key `plan:<turn>` with options `approve` / `reject`, and the loop parks. The answer is consumed once, with the checkpoint that acts on it. Rejection or an expired/withdrawn request ends the turn `blocked`. A decision never grants tool permission.
- **Execute.** Steps run one at a time through `tools.execute` with stable ids `plan:<turn>:step:<i>`. A durable `responded` receipt is reused; `may-have-sent` ends the turn as `PLAN_UNKNOWN_OUTCOME` and is never retried; a tool error ends it as `PLAN_STEP_FAILED`; an approval-bound call parks and resumes only that call through `input.resumeParked` + `tools.resume`.
- **Structured system input.** A step marked `awaitChild` waits with `wait.park`, then claims the next input. A Host-authenticated `agnes/child` `child-completed` notice (`input.system`) continues the plan when `completed`; `failed`, `cancelled` or `budget_stopped` ends it `blocked`. Only the child key and status are kept; the notice body is untrusted data and never reaches a prompt.
- **Finish honestly.** Cancellation ends `aborted`; budget admission errors keep Core's reason; the final assistant message is published with the completed checkpoint in one transaction.

`plan-execute-loop.test.ts` is the conformance test: it drives the factory through `driveLoop` and `scriptedDecisions` from `@agnes/plugin-runtime/testkit` (whose convenience ports throw if touched) and checks the source imports only `@agnes/extension-api` and uses no convenience edge.

Verify it outside the workspace from the repository root:

```sh
pnpm release:external-examples --author-only --keep --example examples/loops/plan-execute-loop
```

The command installs the built author tarballs into an isolated copy, checks the JavaScript syntax with `npm run build`, and runs the same conformance tests with `npm test`.

## 中文

仅基于 `GenericLoopPorts` 编写的非 ReAct 示例（类型为 `GenericLoopFactory`）：不读取 continuation，也不调用 `model.respond`、`tools.drain`、`turn.checkpoint`、`wait.poll`，展示可替换 Loop 对 Core 的真实需求。用 `agh package add ./examples/loops/plan-execute-loop` 安装，信任并启用 `ext:example-plan-execute`，选择 `example.plan-execute@1.0.0`。

状态机（codec 1 检查点）：`input → planning → approving → executing →（tool-parked | awaiting-child）→ done`。

- **规划。** 一次 `model.complete` 返回至多 8 步的 JSON 数组 `{ tool, args, awaitChild? }`，工具必须在本回合目录内。计划无效则以 `PLAN_INVALID` 结束，不执行任何工具。
- **一次真人决策。** 计划通过 `ctx.decisions.request`（稳定 key `plan:<turn>`，选项 `approve` / `reject`）提交并停驻；答复与对应检查点一并消费一次。拒绝或请求过期/撤回则以 `blocked` 结束。决策不授予工具权限。
- **执行。** 逐步调用 `tools.execute`，稳定 id 为 `plan:<turn>:step:<i>`。已持久的 `responded` 回执直接复用；`may-have-sent` 以 `PLAN_UNKNOWN_OUTCOME` 结束且不重试；工具报错以 `PLAN_STEP_FAILED` 结束；需审批的调用停驻，并仅通过 `input.resumeParked` + `tools.resume` 恢复原调用。
- **结构化系统输入。** 标记 `awaitChild` 的步骤用 `wait.park` 等待，再领取下一条输入。Host 认证的 `agnes/child` `child-completed` 通知（`input.system`）在 `completed` 时继续；`failed`、`cancelled`、`budget_stopped` 则以 `blocked` 结束。只保留子代理 key 与状态，通知正文属不可信数据，不进入提示词。
- **如实结束。** 取消为 `aborted`；预算准入错误沿用 Core 的原因；最终助手消息与完成检查点在同一事务发布。

`plan-execute-loop.test.ts` 是一致性测试：通过 `@agnes/plugin-runtime/testkit` 的 `driveLoop` 与 `scriptedDecisions` 驱动工厂（测试夹具中的便捷端口一经调用即抛错），并检查源码仅导入 `@agnes/extension-api`、不使用任何便捷边。

在仓库根目录运行上面的 `pnpm release:external-examples` 命令，可以完成仓外验证：向隔离副本安装已构建的作者 SDK tarballs，通过 `npm run build` 检查 JavaScript 语法，再通过 `npm test` 运行同一组一致性测试。
