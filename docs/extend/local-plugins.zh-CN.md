# 零构建本地插件

[English](local-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [让 Agent 创建插件](agent-built-plugins.zh-CN.md)

Daemon 在启动时扫描 `<AGH_HOME>/plugins/<name>/` 和 `<workspace>/.agh/plugins/<name>/`，并监听变更。这里的 home 是实际配置的运行目录（CLI 使用 `AGH_HOME`）；workspace 是 daemon 的启动工作区。目录名使用小写字母、数字、点、下划线和连字符。

全新 home 应先用 `agh daemon start` 在目录为空时初始化，再创建其中的 `plugins/`。home 根插件通过发现及既有重新扫描／重载控件管理。`agh dev FOLDER` 目前要求目录位于 daemon 启动工作区内；使用该命令请按[工作区教程](quickstart.zh-CN.md)操作，指向工作区外的 home 插件会被拒绝。

目录可以包含正常包的 `package.json`，声明 `agnes.plugins` 与源码入口：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts",
  "agnes": {
    "plugins": [{ "apiRange": "^5.0.0", "export": "main", "id": "ext:my-plugin/main", "inject": ["extension"] }]
  }
}
```

也可以仅含 `plugin.ts` 或 `plugin.js`，默认导出（或 `main`）一个工具或插件：

```ts
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'

export default defineTool({
  name: 'local_hello',
  description: 'Say hello.',
  parameters: Type.Object({ name: Type.String() }),
  meta: {
    isReadOnly: true, isDestructive: false, isConcurrencySafe: true,
    isOpenWorld: false, replay: 'safe', requiresApproval: 'never',
  },
  async execute({ name }, ctx) {
    ctx.signal.throwIfAborted()
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] }
  },
})
```

工具参数必须具有 object 根节点。`Type.Module(...).Import(...)` 的根引用能解析到自身 `$defs` 中的 object 时可注册；pi 模型适配器会在发送给提供方前内联根定义。其他根类型、缺失定义和根引用循环会在注册时明确指出所属插件与工具，避免导致提供方整次请求失败。

使用已有的 jiti 即时转译 TypeScript，无需编译。不会自动猜测缺失的 dist 入口，也不会安装依赖；外部依赖必须能由运行时解析。作者 API 和 TypeBox 使用 Host 的模块。快照不包含 `node_modules`、`.git`，拒绝插件中的符号链接。

主动放入运行 home 的插件目录代表授权可信执行。仓库 `.agh/plugins` 只采集清单，不导入入口，初次发现时禁用且未信任。在 设置 → 运行详情 → 本地插件 中查看仓库插件数量，审核后确认“信任”；SDK/API 使用 `packages.trustWorkspace` 和服务端提供的仓库路径。重新扫描后，已批准快照可供新会话加载。修改仓库插件字节会撤销信任，需要再次确认；未变更的已审核插件保留禁用选择。确认还绑定当前 `.agh/hooks.json` 摘要，hooks 编辑后须重新审核。插件是完全受信任的代码，以用户权限运行。后续工具调用审批不隔离模块初始化代码。

`/admin/plugins` 显示 `local` 来源、安装/启用状态，以及带修复提示的失败状态。变更经过防抖，复制为新的不可变快照。删除源目录会禁用后续绑定，保留旧会话恢复需要的快照。

Watcher 通过 `LocalPluginReload.reloadPlugin(id)` 调用代际管理者。daemon 已将该接口绑定到现有目标发布流程：worker 确认新目标后，新会话获得新版本，旧会话继续使用固定快照。存储和 sandbox 等基础后端仍需要重启。手动命令和冷恢复行为见[热重载指南](hot-reload.zh-CN.md)。失败的重载保留原激活并显示错误，不替换运行中会话的工具。仅因 profile 锁被占用而失败的重载不算插件故障：插件保持待重载，重新扫描会再次重载。扫描失败时重新扫描会报告错误，watcher 也会有限次自动重试。

嵌入者可配置 `createPackageManager({ localPlugins: localPluginRoots(home, workspace), ... })`，启动时调用 `refreshLocalPlugins(profileDir)`，再调用 `watchLocalPlugins(profileDir)`；用 `bindLocalPluginReload({ reloadPlugin })` 绑定代际服务，退出时关闭 watcher。重载实现必须经代际管理者发布新的快照和包状态，并处理删除、禁用及失败。

本地仓库的信任选项包含 `trustHash`，调用 `packages.trustWorkspace` 时作为 `expectedHash` 传入；缺失或过期摘要以 `E_PACKAGE_PREVIEW_STALE` 拒绝信任。仓库 package 生命周期脚本、Skill 附带代码、仓库 MCP JSON 不会在启动时自动执行；托管 MCP 进程仍须单独显式授权。
