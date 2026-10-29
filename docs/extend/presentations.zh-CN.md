# 构建呈现插件

[English](presentations.md) | 简体中文

呈现是声明一个或多个标准 `presentationRoles` 的普通插件浏览器客户端。安装、信任、启用和
[界面实现选择](applications.zh-CN.md)仍是独立操作。执行、授权、会话 pin 和恢复由宿主负责。

## 公开 renderer 出口

从 `@agnes/web-client` 使用 `ClientContext` 和 `ctx.presentationRoles.register`。provider 的 `mount`
收到作用域客户端 context，并同步返回清理函数。通过 `ctx.presentation` 端口读取投影、请求宿主操作；
角色退位时注销订阅、销毁视图。可以用 `@agnes/web-ui` 自行实现，也可以组合下列可选公开 helper：

| 出口 | 边界 |
| --- | --- |
| `@agnes/web/presentation-renderers` | `mountSidebarRegion`、`bindNavigationHistory`、`mountConversationRegion`、`mountTranscriptRegion`、`mountComposerRegion` 及其 mount 类型；DOM renderer 消费公开呈现端口 |
| `@agnes/web-conversation/goal-renderers` | `GoalCard`、`GoalPanel`、`workbenchLocaleCatalog`；通过 `readGoal` 读取并渲染目标投影 |
| `@agnes/web-conversation/interaction-renderer` | `mountIntelligentUi`；渲染已准入表面，通过作用域客户端服务请求动作 |
| `@agnes/web-units/shell` | 共享侧栏、对话、输入框组件及其 props/handle |
| `@agnes/web-foundation/locale-catalog` | `webLocaleCatalog`；向作用域 locale 服务注册翻译 |
| `@agnes/sdk/browser`（也可用 `@agnes/sdk`）和 `@agnes/protocol` | 浏览器 SDK 和公开客户端合同；浏览器控制面限制仍然生效 |

这些精确模块由宿主 import map 提供。它们提供渲染工具，不授予安装插件、改变执行配置或绕过服务准入的权限。
此明确公开表面之外的宿主实现路径仍属私有。角色登记合同不依赖官方包 ID。

例如，导航 provider 可以复用共享 renderer：

```ts
import type { ClientContext } from '@agnes/web-client'
import { bindNavigationHistory, mountSidebarRegion } from '@agnes/web/presentation-renderers'

export function apply(ctx: ClientContext) {
  return ctx.presentationRoles.register({
    role: 'navigation',
    priority: 100,
    mount(scope) {
      const port = scope.presentation.navigation
      if (!port) return () => {}
      const stopHistory = bindNavigationHistory(port.history)
      const view = mountSidebarRegion(scope.slots, port.container, port.initial, scope.locale)
      const detach = port.attach(view)
      return () => {
        detach()
        view.dispose()
        stopHistory()
      }
    },
  })
}
```

客户端 descriptor 声明稳定 ID、`lifetime: "profile"`、`presentationRoles: ["navigation"]`、
`slotCatalogVersion: "dsh-client-slots/v1"` 和 `slots: ["ui:sidebar", "sidebar"]`。
其他 renderer 需要相应 slot 声明，参照 `packages/package-manager/bundled-plugins/` 中的官方 descriptor。
使用公开包出口并声明 peer，不能相对导入另一个包的源码。

## 构建并交付字节

打包前将源码编译为浏览器 ESM entry。将精确的
[`CLIENT_PLATFORM_IMPORTS`](../../packages/protocol/src/client-platform-imports.ts) 标为 external；
实际使用的其他已映射 UI 子路径也保留为 external。不要假定任意包子路径都能解析。
`agh plugin pack` 构建客户端资产时使用公开平台列表。发行构建对照实际 import map 校验输出导入，
保留共享 React 树。其他依赖自行打包，并交付所需许可证/NOTICE。资产须遵循宿主 CSP；导入模块不放宽 CSP。

五个官方呈现客户端的源码归各自插件包所有。生成的 `src/client.js`、`NOTICE` 和 `client-build.json`
由 Git 忽略。源码 checkout 使用已有构建入口：

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
```

Web 开发和 Vitest 也会按需构建缺失或陈旧的客户端。每个构建入口都先独立编译源码，再接受缓存字节；
local、SEA 和 release 打包也在复制前完成此检查。输入内容、lockfile、构建工具、包 manifest 和 import map
用于识别源码变化。输入不变的缓存必须与独立编译的记录和输出哈希匹配；同时修改客户端及记录中的哈希也会
被拒绝。匹配的输出文件保持不动。开发监听插件自有 entry 以及共享 Web 源码。

`client-build.json` 记录格式版本 1、输入 SHA-256、esbuild 版本、源码输入路径、字节数及客户端/NOTICE 的
SHA-256。local、release 和 SEA payload 将记录与实际字节一起交付。打包验证输出哈希；`gen:check`
独立重建并比较记录和输出哈希。全新 checkout 会先创建缺失记录。此记录是构建来源证据，不是新的信任来源：
正常包完整性和快照摘要覆盖记录及生成文件，信任与撤销检查保持原样。

已有 home 保留历史快照字节与 pin。发行版自有默认包仍遵循现有受控刷新策略：仅保留的发行来源、
符合运行条件的已安装包且能力授权不变时，才能自动刷新；能力改变须重新审阅。普通包更新沿用显式审阅/信任流程。
更新已安装 payload 不会静默重 pin 已保存会话。旧 pin 保留自己的不可变字节，并继续接受信任验证。
新渲染 helper 是增量公开出口，旧客户端的 React/UI 导入仍能解析。
