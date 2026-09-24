# hook-runner-takeover（第三方插件整行替换 `agnes/hooks-runner`）

通过与内置行相同的 `ext:agnes/hooks-runner` 标识执行整行替换，并完整注册该行所需事件。缺少必要事件时，Host 拒绝替换。

## 写法

跟 `hook-context-note` 一样是普通 Cordis 对象插件，区别是：

1. `package.json` 的 `id` 写成 `"ext:agnes/hooks-runner"`（内置扩展自己的行 id），不是自己起的 id。
2. `index.mjs` 里对 12 个事件全部调用 `agnes.registerHook(...)`——11 个原样透传（不拦截、不改写），只有
   `tool_call` 真的做一件事：拦截一次专门标记好的演示调用（`name === 'demo_text_stats'` 且
   `args.text === 'BLOCK_ME'`），证明返回值真的进了内核判断，不只是"挂上去没报错"。

## 会发生什么

- 替换成功后，这个插件继承 `agnes/hooks-runner` 原来的位次（`hookRank`）——它在 `session_start`/`shutdown`
  这类跟 `agnes/privacy` 共享的事件上，仍然排在原来 `hooks-runner` 该在的位置，不会被推到第三方层。
- 停用这个插件后，内置的 `hooks-runner` 立即回来（整行替换的既有机制，这次没变）。
- 按单个钩子替换（只接管 12 个事件里的某一个、其余仍归内置）**不支持**——本例演示的是"整行替换"，不是"按钩子替换"。

## 验证

`packages/host/test/assemble/plugin-extension-hook-examples.test.ts`：真实 Host 装配，先确认不装这个插件时
`ext:agnes/hooks-runner` 由内置供给；装上这个插件后，替换成功（内置 `hooks-runner` 的行为消失，这个插件的
行为生效）；对 `demo_text_stats` 发起两次调用，`args.text: 'BLOCK_ME'` 的那次被拦截，另一次正常返回结果。
