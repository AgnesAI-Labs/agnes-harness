# 插件开发：把你的能力接入 AGH

[English](plugins.md) | 简体中文

[文档导航](../README.zh-CN.md) · [后端工具教程](backend.zh-CN.md)

把业务函数变成 Agent 工具，把任务方法整理为 Skill，或为工作台加上自己的界面。AGH 为这些能力提供扩展入口与包生命周期，帮助你从一个插件逐步组合出应用。本文先帮你选入口，再解释依赖与运行方式。

## 在会话中创建第一个插件

默认启用的 `@agnes/plugin-helper` 可以帮助你把需求变成 AGH 工具、Skill 或皮肤插件。例如：

> 帮我写一个 AGH 插件，统计文本字数，并安装到当前 AGH。

助手先读取随版本分发的开发指南与模板，再把源码保存在当前工作区的 `.plugin-helper/<随机目录>` 中，并返回包身份、能力和内容摘要。确认安装后，AGH 通过同一套包管理流程安装、信任并启用这份代码；你可以在“设置 → 插件管理 → 已安装”查看实际状态。新能力在轮次边界生效，下一轮可查询状态并调用新工具验证结果。

创建源码本身不会安装插件。检查验证包结构与声明，安装确认针对该摘要的具体代码；启用插件会以本机进程权限执行 JavaScript。安装前可以审阅生成的源码。

当前会话助手支持自包含、无外部依赖的文本 ESM 工具/Skill 插件，以及纯 CSS/token 皮肤，不覆盖已有同名包，也不自动发布。皮肤可在设置的外观选项中选择，支持浅色/深色，停用插件后恢复默认。创建皮肤时助手会读取 `kind: skin` 模板，无需定位源码示例。需要交互式前端界面、服务、依赖构建或版本更新时，继续使用下方对应教程与标准包管理流程。禁用或卸载助手不影响已安装的其他插件。

为工作台定制纯 CSS 与 token 外观，阅读[皮肤开发](skins.zh-CN.md)。

## 选择扩展方式

| 你准备增加什么 | 适合的起点 | 完成后可以验证什么 |
| --- | --- | --- |
| 一项可被 Agent 调用的能力 | [后端工具插件](backend.zh-CN.md) | 参数、工具记录与结构化结果 |
| 一套任务方法和背景知识 | [工作区 Skill](../guide/skills.zh-CN.md) | 来源、信任和会话中的使用 |
| 已有的外部工具服务 | [MCP 接入](../guide/mcp.zh-CN.md) | 连接、目录和授权后的工具调用 |
| 工作台中的一块界面 | [前端面板](frontend.zh-CN.md) | 挂载、版本更新和卸载恢复 |
| 能读取后端业务结果的界面 | [前后端联动](fullstack.zh-CN.md) | 当前会话下的受限服务查询 |

选择最贴近需求的一条路径。包的安装和信任过程统一见[插件管理](../guide/packages.zh-CN.md)，无需为每种界面重新实现后台。

物理设备接入的方向介绍见[MHS 与设备接入](../guide/mhs.zh-CN.md)，相关接入文档与示例即将开放；上表列出的是当前已有的软件扩展入口。

## Cordis 在其中做什么

AGH 使用仓内 `@agnes/cordis` 的 Context、服务依赖和 fiber 生命周期组织可替换组件；Host 再施加安装、信任、快照和能力约束。上游 Cordis/DeepSeek 文档可解释框架思想，不能直接替代 AGH 的加载声明或接口。

## 一个插件包的形状

现行普通插件入口是 `package.json` 的 `agnes.plugins`，指向包模块的命名导出：

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./index.mjs",
  "agnes": {
    "plugins": [
      { "export": "example", "id": "ext:example/plugin", "inject": ["skills"] }
    ]
  }
}
```

这是示例自己的身份，不是可从 npm 安装的地址。`index.mjs`：

```js
export const example = {
  inject: ['skills'],
  apply(ctx) {
    ctx.skills.register({
      name: 'review-notes',
      description: '只读检查说明文件',
      body: '列出说明中的矛盾并引用文件，不修改内容。',
    })
  },
}
```

依赖名称必须在静态声明与导出元数据中一致，后端加载器在不执行任意模块的阶段就需知道依赖图。`provide` 同样要两边一致。模块需包含全部必要产物；直接把本机 TypeScript 深路径或未打包依赖交给不可变快照不构成可移植分发。

## 配置、依赖与清理

`defineAgnesPlugin()` 是保留类型的辅助函数，不给插件增加权限。插件可声明 Standard Schema `Config`，由加载器验证配置。现成的[cordis-greeting](../../examples/packages/cordis-greeting/index.ts)展示配置校验、`provide` 和服务值；[hot-service](../../examples/packages/hot-service/v1/index.mjs)展示无外部 import 的可安装 ESM。

`ctx.provide('name', value)` 的值属于当前 Context 服务空间，消费者声明 `inject`。加载顺序由服务依赖决定，不以数组顺序替代。手工申请的定时器、连接和监听器应登记到 `ctx.effect(() => disposer)`。卸载时 disposer 撤下资源，不把已经完成的外部业务动作当作可自动回滚。

## 不同 API 不可混用

| 接口 | 可以做什么 | 边界 |
| --- | --- | --- |
| 普通 Cordis Context | 插件、服务、事件、effect 生命周期 | 进程内服务，不自动变成跨进程 RPC |
| `ctx.extension()` / PluginExtensionAPI | 工具、`on` 观察 hook、`registerHook` 的 transform/intercept hook、受约束事件 | 不能通过这个 API 注册 Service/Projection/Slot/Resource；结果仍受运行时权限与顺序约束 |
| `ctx.skills` | 运行时 Skill 贡献与 provider | 不能读取/枚举其他 Skill；与磁盘治理分离 |
| 行上的 `ctx.services` / `ctx.slots` / `ctx.projections` / `ctx.resources` | 在已验证行上注册对应贡献，随行 fiber 清理 | 不是无条件全局对象；服务调用仍受身份、会话和客户端 allow-list 约束 |
| 浏览器 ClientContext | 已声明槽位、前端服务/命令与受限 backend service relay | 没有 Host Context、Node 系统能力或 daemon 管理凭据 |

[联动教程](fullstack.zh-CN.md)使用同一受信 Cordis 行上的 `ctx.services.register()` 和 `agnes.clientDescriptors`。它不把 `ctx.provide()` 伪装成远程方法，也不让 `ctx.extension().registerService()` 绕过限制。

当前源码已开放 17 类 hook 的 `registerHook`，并收敛第三方后端插件到 `agnes.plugins` 行；旧 `agnes.extensions` 不能继续作为第三方普通后端入口。内置兼容清单与第三方作者入口的规则不同。具体注册和授权仍以当前源码、包预览与实际行状态为准。

## 前后端生命周期

Host 普通树与 Web 页面分别创建 Context。`web:` 是平台合成的客户端行命名空间，包作者不得在 `agnes.plugins` 中声明该前缀；这些行保留在完整 runtime target 中，但不作为 Host 普通行执行。

第三方运行来源要求受信不可变快照；不能把任意文件路径当作已安装受信行。Host 维护受限活树事务，Web 根据名册按 revision 对账；不支持的静态组件替换、孤立依赖、失效租约和越权操作应拒绝。

下一步：[后端工具](backend.zh-CN.md) · [前端面板](frontend.zh-CN.md) · [联动](fullstack.zh-CN.md) · [安装与更新](../guide/packages.zh-CN.md)。

事实源：[作者类型](../../packages/plugin-runtime/src/author.ts)、[manifest 解析](../../packages/package-manager/src/plugin-manifest.ts)、[PluginExtensionAPI](../../packages/extension-api/src/plugin-extension.ts)、[行 API](../../packages/host/src/ext-host/row-extension-api.ts)、[ClientContext](../../packages/web-client/src/client-module.ts)。
