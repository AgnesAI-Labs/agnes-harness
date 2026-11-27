# 前端插件：为工作台增加一个界面

[English](frontend.md) | 简体中文


[文档导航](../README.zh-CN.md) · [插件生命周期](../guide/packages.zh-CN.md)

使用 [client-panel/v1](../../examples/packages/client-panel/v1/package.json) 示例学习声明和实现浏览器贡献。测试载入示例后，它会在 `workbench.panel` 位置显示版本文字。这与在 Host 中通过 `ctx.slots` 注册槽位是两条不同的路径。

官方工作台只会载入两类原生 JavaScript 和 CSS：当前 AGH 版本随包发布并验证过的客户端，以及通过[应用采用或呈现角色选择](../extend/applications.zh-CN.md)单独批准的确切客户端。随包发布的导航、对话及输入框、目标、交互和交付物客户端无需另行批准。安装、信任并启用第三方插件不会批准其原生界面。工具、后端服务、配置和可读的会话历史仍遵循各自原有的权限。Intelligent UI 渲染器继续在隔离的 iframe 中运行。

## 声明由宿主渲染的插件入口

已安装、受信任且启用的插件可以在 `package.json` 的 `agnes.plugins` 条目上声明 `uiEntries`。用它展示简短的功能说明，或打开该条目的配置。AGH 渲染入口和内容，不加载插件的浏览器模块或样式表。

```json
{
  "export": "archive",
  "uiEntries": [
    {
      "id": "archive-settings",
      "placement": "settings",
      "title": { "en": "Session archive", "zh-CN": "会话归档" },
      "markdown": { "en": "Choose **Configure** to set archive options." },
      "configure": true
    }
  ]
}
```

示例只列出与入口相关的字段。`settings` 对应「设置 → 扩展」；`sidebar` 对应左侧扩展菜单；`workbench.right` 和 `workbench.bottom` 分别对应工作台右侧和底部停靠区。由宿主决定排序和折叠。`icon` 可以省略，或使用共享图标名。提供 `title.en`；其他语言没有译文时使用英文。至少提供 `markdown` 或 `configure: true`。入口 Markdown 显示链接标签和图片替代文本，不打开链接或加载图片。「配置」只打开声明所在的插件条目，仍遵循原有配置权限。

每条插件声明最多包含 8 个入口，每包最多 32 个。入口 ID 在同一插件条目内唯一，以小写字母开头，最多 64 字符，只接受小写字母、数字、点和短横线。每种语言的标题最多 80 字符，Markdown 最多 2,048 字符。旧插件不必修改，其原生入口不会自动迁移或获准执行。要展示实时会话内容或提供会话操作，请使用 [Intelligent UI](intelligent-ui-web.zh-CN.md)。

调试声明式入口时，请先把插件装成受管包。可编辑的 `workspace:` 和 `local:` 插件保持原有行为，不发布这类入口。

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

使用预览显示的摘要信任并启用示例。在官方工作台打开插件详情，确认原生界面显示为未获准，工作台不会显示示例的版本文字。插件的后端状态仍按实际操作显示。

要体验单独批准，安装 [Deliverables Gallery](../../examples/community/deliverables-gallery/README.md)。在**设置 → 应用**中审阅并采用该应用，或选择它提供的交付物角色。打开有交付物的会话即可看到已获准的界面。批准只覆盖所审阅的客户端和版本，不覆盖插件的其他客户端。如果变更使批准失效，请重新审阅。已在当前标签页运行过旧界面时，请重新加载该标签页以清除旧代码。

如果无法通过已采用的界面打开设置，请在工作台地址上打开 `/?admin`，或运行 `agh app clear`。恢复官方界面不会修改会话固定版本或删除会话数据。

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
