# hot-tool-plugin（第三方插件给模型加工具，新插件机制）

`hot-tool` 的新写法：不再用 `agnes.extensions`（第三方旧式扩展包在运行时不生效），而是一个普通的
Cordis 插件，通过 `ctx.tools.register()` 注册工具，通过 `ctx.hooks` 注册钩子。

## 写法

`package.json` 用 `agnes.plugins` 声明入口，并声明 `inject: ["tools", "hooks", "self"]`：

```json
"agnes": { "plugins": [{ "export": "textStatsTool", "apiRange": "^5.0.0", "id": "ext:agnes-examples/hot-tool-plugin", "inject": ["tools", "hooks", "self"] }] }
```

`index.mjs` 导出一个对象插件：`inject: ['tools', 'hooks', 'self']`，`apply(ctx)` 里
`ctx.tools.register(...)`、`ctx.hooks.register('session_start', ...)`。没有任何 import，所以安装后的快照不需要解析依赖（工具参数是打了 TypeBox 标记的 JSON Schema，见文件里的注释；
未打标记的普通 JSON Schema 会在模型调用时被判为参数不合法）。

## 工具与观察类钩子

- `ctx.tools.register(def)`：平台将清理绑定到插件生命周期；工具由 Host 盖章来源（`plugin/<哈希>`）与包身份，插件不能自报；工具名不能占用内置扩展的名字。
- `ctx.hooks.register(event, handler)`：16 类事件都可注册；观察类事件（`session_start`、`request_error`、`compact`、`subagent_start`、
  `subagent_end`、`format_deviation`、`shutdown`）的返回值被丢弃。
- `ctx.eventLog.append(name, data)`：写账本事件 `x/plugin/<哈希>/<name>`。
- `ctx.self`：插件的身份、日志和信号。

## 验证

`packages/host/test/assemble/plugin-extension-example.test.ts`：装上这个包，模型调用 `demo_text_stats` 得到结果；
行被移除后工具消失。
