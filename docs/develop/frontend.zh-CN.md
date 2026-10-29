# 前端插件：为工作台增加一个界面

[English](frontend.md) | 简体中文


[文档导航](../README.zh-CN.md) · [插件生命周期](../guide/packages.zh-CN.md)

做完本教程，你会在工作台里看到自己的面板，完成一次版本更新，并确认停用后新会话使用内置界面、旧会话保留原版本。先理解生命周期，再把版本文字替换成岗位需要的内容。

复用 [client-panel/v1](../../examples/packages/client-panel/v1/package.json)。它在已有的工作台视图位置 `workbench.panel` 追加版本文字，不替换侧栏，v2 用于验证页面更新。它是浏览器贡献路径，不是普通 Host `ctx.slots` 的 slot 注册。

## 声明和代码

该包用 `agnes.plugins` 声明后端 Cordis 行，再用 `agnes.clientDescriptors` 将浏览器描述文件绑定到同一个 row ID。浏览器描述文件中的 `client` 部分为：

```json
{
  "client": {
    "entry": "./client/index.js",
    "lifetime": "profile",
    "styles": ["./client/index.css"],
    "slots": ["workbench.panel"],
    "publicConfig": { "label": "Agnes client module demo · v1" },
    "services": [],
    "projections": []
  }
}
```

若客户端使用 `streams`，须在绑定后端行的 `capabilities.streams` 中逐一声明。检查与打包依据该行的能力进行校验；同包其他行的声明不能授权此客户端。stream 的 scope 变更需要重新作出信任决定。

包声明见[package.json](../../examples/packages/client-panel/v1/package.json)，完整客户端描述见[agnes.client.json](../../examples/packages/client-panel/v1/extensions/main/agnes.client.json)。客户端 entry 相对于描述文件定位，是浏览器可执行的原生 ESM：

```js
export function apply(ctx, config) {
  ctx.slots.register(
    'workbench.panel',
    () => config.publicConfig.label,
  )
}
```

该视图位置追加工作台内容，不接管导航。撤销时同步移除；需要替换整组呈现时使用公开接管角色，不能依赖宿主私有 DOM/CSS。

如果视图位置由另一区域在挂载时声明，用 `ctx.slots.inject(name, () => ctx.slots.register(...))` 包裹注册并保留其清理函数。工厂返回注册项的清理函数；父区域移除时撤销注册，重建时只注册当前 owner。目录支持某个名称，不代表它的出口此刻存在。独立面板和数据订阅放在工厂外，角色被替换时注销 injection。会话模块只能等待其已声明、且目录版本已审阅的公开会话视图位置；卸载时同时撤销待挂载的 injection 和已登记的注册项。未知或未授权的槽位仍然拒绝。

浏览器失败诊断保留安全错误码、包、接管角色和失败阶段，不包含插件异常原文。显示失败不代表已保存的交付物不存在；重新加载会重试当前已授权的呈现，不授予新信任，也不选择其他插件。

`publicConfig` 来自随包内容，是公开展示元数据，不是后端 runtime config。客户端 entry/styles 必须是经过校验的包内路径；不能逃出快照、任意 import 本机模块或获取连接凭据。React 与共享 Agnes 包使用宿主的平台 externals，仅将其它依赖打入浏览器产物。

浏览器共享单例白名单由 [`CLIENT_PLATFORM_IMPORTS`](../../packages/protocol/src/client-platform-imports.ts) 维护，包括 React、客户端/UI API、浏览器 SDK/协议和可选公开呈现 renderer。精确出口与构建方法见[构建呈现插件](../extend/presentations.zh-CN.md)。这些精确说明符由 HTML import map 解析；将包名 external 不代表任意子路径都有映射。发行打包拒绝无法解析的输出 external。

## 安装与观察

从仓库根和独立实例运行：

```sh
node agnes.mjs package inspect file:./examples/packages/client-panel/v1
node agnes.mjs install file:./examples/packages/client-panel/v1
```

使用预览摘要完成 trust、enable，然后打开同一实例 Web 并新建会话，应看到 v1 字样。通过 Web 管理或 TUI 更新到 `file:./examples/packages/client-panel/v2`，完成其信任与启用后再新建会话检查 v2；返回第一个会话核对 profile 贡献也跟随当前激活显示 v2。最后 disable，确认新增视图立即撤销，管理导航保持可用。

包 desired=enabled、后端 web row ready 和本页面成功加载是不同阶段。浏览器未打开、脚本/CSS 读取失败、槽位越权或 apply 抛错都可能导致前端失败；查看逐行实际状态，不仅看包级 enabled。

## 验证

```sh
pnpm exec vitest run tools/public-docs/examples.test.ts packages/web/test/client-modules.reconcile.test.ts packages/web/test/client-modules.hot-reload.test.ts --maxWorkers=1
```

这些测试验证实际示例 ESM、Cordis 绑定、槽位与清理，以及更新失败处理；没有浏览器参与时不称为真实渲染验收。浏览器验收边界与源码候选结果见[验证记录](../maintainers/verification.zh-CN.md)。

下一步：[为面板接入后端服务](fullstack.zh-CN.md)。需要公开配置的字段和可调用服务要分别声明；密钥留在后端。

实现依据：[加载协调](../../packages/web/src/client-modules/reconcile.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)、[资源检查](../../packages/package-manager/src/client-assets.ts)、[槽位](../../packages/web-client/src/slots.ts)。

## 一致的界面

遵循[UI 作者短指南](ui-author-guide.zh-CN.md)：使用共享组件与 `.agh-btn*` 契约，按需工作台标签、设置分组和 Intelligent UI 摘要。设置分为通用、模型、权限、应用四类日常设置，以及可选的扩展和高级。运行配置位于模型；作业和运行诊断位于高级。公共注册表只管理呈现，后台事实与授权仍走原服务。


客户端样式表通过原生 CSS 导入加载进 `app` 级联层。直接编写普通 CSS；相对导入和资产 URL 继续以包内样式表为基准。共享 `@agnes/web-ui` CSS 使用 `@agnes/web-ui/layers.css` 中的统一层序。层级与皮肤优先级见[皮肤指南](skins.zh-CN.md)。
