# 零构建本地插件

[English](local-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [让 Agent 创建插件](agent-built-plugins.zh-CN.md)

Daemon 在启动时扫描 `<AGNES_HOME>/plugins/<name>/` 和 `<workspace>/.agnes/plugins/<name>/`，并监听变更。这里的 home 是实际配置的运行目录（CLI 使用 `AGH_HOME`）；workspace 是 daemon 的启动工作区。目录名使用小写字母、数字、点、下划线和连字符。

每个目录可以包含 `package.json`：声明 `agnes.plugins`，并将 `exports` 指向 `./src/index.ts` 等源文件。也可以只放 `plugin.ts` 或 `plugin.js`，默认导出（或导出 `main`）一个 `defineTool` / `defineAgnesPlugin` 对象。[英文页](local-plugins.md)提供完整示例。

使用已有的 jiti 即时转译 TypeScript，无需编译。不会自动猜测缺失的 dist 入口，也不会安装依赖；外部依赖必须能由运行时解析。作者 API 和 TypeBox 使用 Host 的模块。快照不包含 `node_modules`、`.git`，拒绝插件中的符号链接。

将代码放入这些目录表示信任其在进程内运行。首次发现会安装、信任并启用插件；已有的禁用选择保留。会话审批约束创建工具和工具调用，但不隔离插件初始化代码。包标识冲突会失败，不会自动覆盖现有包。

`/admin/plugins` 显示 `local` 来源、安装/启用状态，以及带修复提示的失败状态。变更经过防抖，复制为新的不可变快照。删除源目录会禁用后续绑定，保留旧会话恢复需要的快照。

Watcher 通过 `LocalPluginReload.reloadPlugin(id)` 调用代际管理者。当前 daemon 尚未绑定正在开发的程序化重载入口，因此变更显示需要重启。重启后启动发布走已合入的 session generation 机制，新会话获得新版本，旧会话继续使用固定快照。失败的重载保留原激活并显示错误，不替换运行中会话的工具。

嵌入者可配置 `createPackageManager({ localPlugins: localPluginRoots(home, workspace), ... })`，启动时调用 `refreshLocalPlugins(profileDir)`，再调用 `watchLocalPlugins(profileDir)`；用 `bindLocalPluginReload({ reloadPlugin })` 绑定代际服务，退出时关闭 watcher。重载实现必须经代际管理者发布新的快照和包状态，并处理删除、禁用及失败。
