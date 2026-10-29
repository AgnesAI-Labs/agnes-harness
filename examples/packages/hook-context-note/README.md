# hook-context-note（第三方插件新增改写类钩子，不替换任何内置扩展）

通过 `ctx.hooks.register` 注册 `context` 改写钩子，为任务添加说明。观察类事件的返回值被丢弃；改写类事件的返回内容才会生效。

## 写法

跟 `hot-tool-plugin` 一样用 `agnes.plugins` 声明入口，`inject: ['hooks']`，
区别是注册的是改写类事件：`ctx.hooks.register('context', handler)`：

```js
ctx.hooks.register('context', () => ({
  sections: [{ id: 'hook-context-note/reminder', order: 250, content: '...' }],
}))
```

## 会发生什么

- 这个插件**不替换任何内置扩展**——它的行 id 是自己起的（`ext:agnes-examples/hook-context-note`），
  不是某个内置扩展的 id，所以没有位次（`hookRank`），排在内置层之后。
- 内置的 `agnes/skills`（也在 `context` 上贡献内容）永远先跑；这个插件的 section 在它之后追加，
  跟内置贡献的 section 按 `id` 各自独立、不会互相覆盖（核心 `applyContextResults` 的合并语义）。
- 返回值真正生效：这个 section 会出现在模型看到的系统提示词里，不像 `agnes.on` 那样"调用了但返回值被丢弃"。

## 验证

`packages/host/test/assemble/plugin-extension-hook-examples.test.ts`：装上这个包、跑一轮真实会话（脚本化
假供应商），确认这个插件贡献的 section 内容出现在实际发给模型的请求里。
