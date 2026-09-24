# 后端插件：给 Agent 增加一项能力

[文档导航](../README.md) · 前提：[Cordis 边界](plugins.md)

做完本教程，你会得到一个可安装的文本统计工具，并能从工具记录核对输入和结果。这是把业务函数接入 AGH 的最小起点。

复用可安装的 [hot-tool-plugin](../../examples/packages/hot-tool-plugin/package.json)。它不访问网络、文件或付费模型；工具 `demo_text_stats` 接受 text，返回字符数与空白分隔词数。字符计数采用 JavaScript `text.length`，不是 Unicode 字素数。

## 入口与工具

包通过 `agnes.plugins` 指向 `textStatsTool`，manifest 和对象都声明 `inject: ['extension']`。核心实现：

```js
export const textStatsTool = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'demo_text_stats',
      description: 'Count characters and words in text.',
      parameters,
      meta,
      async execute({ text }) {
        const structured = {
          characters: text.length,
          words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        }
        return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
      },
    })
  },
}
```

此段聚焦注册逻辑，完整可运行文件及 `parameters/meta` 在 [index.mjs](../../examples/packages/hot-tool-plugin/index.mjs)，直接使用该文件，不需要把片段另存后猜其余字段。

参数是带 TypeBox kind 标记的 Schema；示例手写 `Symbol.for('TypeBox.Kind')` 避免外部 import。普通纯 JSON Schema 对象不能随意当作所有工具定义 API 接受的 TypeBox 值。使用已安装的 TypeBox 时可用 `Type.Object` 构建，分发前应打包依赖。

元数据准确声明只读、非破坏、并发安全、封闭世界、`replay: 'safe'` 和不需审批。若改成写文件或调用外部系统，应重新定义效果、审批与重放语义，不能沿用这里的声明。

## 安装和运行

按[插件管理](../guide/packages.md)对 `file:./examples/packages/hot-tool-plugin` 执行 inspect、install、trust、enable，然后在已配置模型的新会话中请求：

> 调用 demo_text_stats 统计 hello world，返回工具结果。

预期结构为 `{"characters":11,"words":2}`。模型是否选中工具需要真实模型验证；不应把模型纯文本回答相同数值算成调用成功，应检查实际工具记录。

## 无模型验证与失败路径

```sh
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/ext-host/row-extension-host.test.ts --maxWorkers=1
```

样例测试直接加载现有后端模块，捕获注册定义并核对 Schema、参数和返回值；前端样例使用真实 Cordis Context 验证挂载与卸载。另列的 Host 专项覆盖行 API、过期租约、保留工具名及受限 API。此验证不代表恶意进程内代码被 OS 隔离，也不代表真实模型会正确选工具。

## 把示例变成你的业务能力

先保留包结构与注册方式，只替换业务逻辑；再根据实际副作用更新参数校验、权限、审批和重放声明。把连接与监听器加入 Cordis 生命周期，确保禁用后可以清理。需要展示业务结果时，继续[前端面板](frontend.md)和[联动教程](fullstack.md)。

配置服务示例见 [cordis-greeting](../../examples/packages/cordis-greeting/greeting.test.ts)；更新/失败候选/回退可使用 [hot-service](../../examples/packages/hot-service/README.md) 家族。不建议从旧 `hot-tool` 的 `agnes.extensions` 单独复制后端入口。
