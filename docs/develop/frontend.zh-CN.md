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

## 通过 Workbench 扩展执行视图

可选的 `ctx.workbench` 接口提供由客户端 fiber 拥有的执行视图 provider。公开契约见 [WorkbenchClient、WorkbenchProvider 和 WorkbenchSnapshot](../../packages/web-client/src/workbench.ts)。provider 注册执行模式，解析自己的 URL 字段，打开已保存目标并处理提交。每次首次提交由宿主冻结所选工作区、模型与权限快照；`subscribe` 接收宿主状态，`observe` 接收当前会话的事件。provider 注册与订阅随调用模块的 fiber 撤销。

`workbench.surfaces` 明确提供 `root`、`chat`、`aside`、`divider`、`footer`、`toolbar` 和 `overlay`。插件只添加自己拥有的节点并在销毁时移除，不查询宿主私有 ID、不搬动原有 shell 节点。通用 renderer 和 controller 复用 [@agnes/web-session-ui 的公共导出](../../packages/web-session-ui/package.json)。连接、主输入框、会话选择及授权仍由宿主负责。

[JevLoop 浏览器包](../../packages/jev-web/README.md) 通过这个接口提供决策图和双线工作区。`ext:jev-web/main` 后端行拥有客户端描述文件，不注册后端 runtime。构建后的描述文件位于 `client/agnes.client.json`，浏览器 ESM 与样式分别独立加载；平台共享实例使用已有 import map，其余浏览器依赖打包进产物。停用或卸载使包退出名册，撤销 fiber 并移除样式。已绑定到不可用 provider 的目标保持不可用，提交必须拒绝，不能改发 Native；销毁界面不取消后台已经接纳的任务。

首次默认初始化通过普通 install/trust/enable 流程安装 Jev 浏览器包；已完成旧版默认初始化的 profile 不自动加入，可由用户显式安装。后续启动保留停用和卸载选择。后端 runtime 仍由 Host 静态装配，不属于本次前端插件改动。浏览器包安装、后端 runtime 可用与当前页面激活是三个独立条件。

<a id="验证"></a>

## 验证

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

这些测试验证实际示例 ESM、Cordis 绑定、槽位与清理，以及更新失败处理；没有浏览器参与时不称为真实渲染验收。浏览器验收边界与源码候选结果见[验证记录](../maintainers/verification.zh-CN.md)。

下一步：[为面板接入后端服务](fullstack.zh-CN.md)。需要公开配置的字段和可调用服务要分别声明；密钥留在后端。

实现依据：[加载协调](../../packages/web/src/client-modules/reconcile.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)、[资源检查](../../packages/package-manager/src/client-assets.ts)、[槽位](../../packages/web-client/src/slots.ts)。
