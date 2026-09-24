# 前端插件：为工作台增加一个界面

[English](frontend.md) | 简体中文

[文档导航](../README.zh-CN.md) · [插件生命周期](../guide/packages.zh-CN.md)

做完本教程，你会在工作台里看到自己的面板，完成一次版本更新，并确认停用后内置界面恢复。先理解生命周期，再把版本文字替换成岗位需要的内容。

复用 [client-panel/v1](../../examples/packages/client-panel/v1/package.json)。它在已支持的 `ui:sidebar` 槽展示版本文字，v2 用于验证页面更新。它是浏览器贡献路径，不是普通 Host `ctx.extension()` 的 slot 注册。

## 声明和代码

该包用 `agnes.plugins` 声明后端 Cordis 行，再用 `agnes.clientDescriptors` 将浏览器描述文件绑定到同一个 row ID。浏览器描述文件中的 `client` 部分为：

```json
{
  "client": {
    "entry": "./client/index.js",
    "styles": ["./client/index.css"],
    "slots": ["ui:sidebar"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

包声明见[package.json](../../examples/packages/client-panel/v1/package.json)，完整客户端描述见[agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json)。客户端 entry 相对于描述文件定位，是浏览器可执行的原生 ESM：

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'ui:sidebar',
    () => config.publicConfig.label,
    { priority: -1 },
  )
}
```

该单实例槽的较小 priority 优先，示例替换内置侧栏。停用后应恢复内置侧栏。正式插件选择合适槽位，不能指望覆盖未迁移区域，也不要依赖宿主私有 DOM/CSS 结构。

`publicConfig` 来自随包内容，是公开展示元数据，不是后端 runtime config。客户端 entry/styles 必须是经过校验的包内路径；不能逃出快照、任意 import 本机模块或获取连接凭据。需要 React/第三方库时应生成可独立加载的浏览器产物。

## 安装与观察

从仓库根和独立实例运行：

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/client-panel/v1
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/client-panel/v1
```

使用预览摘要完成 trust、enable，然后打开同一实例 Web。应看到 v1 字样。通过 Web 管理或 TUI 更新到 `file:./examples/packages/client-panel/v2`，检查 v2；最后 disable，确认内置侧栏恢复。示例可能替换管理导航，必要时保留终端使用 shell disable。

包 desired=enabled、后端 web row ready 和本页面成功加载是不同阶段。浏览器未打开、脚本/CSS 读取失败、槽位越权或 apply 抛错都可能导致前端失败；查看逐行实际状态，不仅看包级 enabled。

## 验证

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

这些测试验证实际示例 ESM、Cordis 绑定、槽位与清理，以及更新失败处理；没有浏览器参与时不称为真实渲染验收。浏览器验收边界与源码候选结果见[验证记录](../maintainers/verification.zh-CN.md)。

下一步：[为面板接入后端服务](fullstack.zh-CN.md)。需要公开配置的字段和可调用服务要分别声明；密钥留在后端。

实现依据：[加载协调](../../packages/web/src/client-modules/reconcile.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)、[资源检查](../../packages/package-manager/src/client-assets.ts)、[槽位](../../packages/web-client/src/slots.ts)。
