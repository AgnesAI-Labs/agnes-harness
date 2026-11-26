当前可检查和安装的 Cordis 行示例通过 `agnes.plugins` 声明后端。前端模块及皮肤由
`agnes.clientDescriptors` 绑定同包的插件行，包括 `client-panel`、`client-multi-panel`、
`client-service-panel`、`skins-builtin` v1/v2、`skin-example` v1 和四组 DSH fixture。
`hot-service`、`hot-tool-plugin`、`cordis-greeting`、`hook-context-note`、
`hook-runner-takeover` 与 `acme-dashboard` 也使用行格式。包管理页的本地目录只公布已迁移
且通过包检查的版本。通过包检查不代表原生界面已获官方工作台准入。测试专用 `broken` 版本须显式启用。

`hot-tool`、`agent-automation`、`compaction-policy`、`supply-rescue` 四组旧格式示例已从
仓库删除。包检查明确拒绝第三方 `agnes.extensions`；请使用上述行格式示例。

## DSH browser-row fixtures

`dsh-input-controls`、`dsh-model-picker-a`、`dsh-model-picker-b` 和 `dsh-tool-view` 是专门验证浏览器 row 生命周期的可安装 fixture，不是业务插件：

- `conversation.input.right` 覆盖 `list/session` 输入区追加；
- `conversation.input.model` 覆盖 `single/session` 的 A/B priority shadowing；
- `tool.call.toolview` 覆盖按 `bash` 或 `shell` 工具名匹配的 `keyed/session` 工具视图。

每个 family 都有 `v1`、`v2` 和仅测试目录可见的 `broken`：v1/v2 用于安装、启用、无刷新更新和清理，broken 用于 apply-stage、render-stage、abdication 和失败 row 隔离。前端资源通过 `agnes.client.json` 声明，client entry 依赖宿主 import map 的 `react`。

## 旧版原生界面测试 fixture

下面三个包可安装，用于兼容性与失败隔离测试，不是可在官方工作台中运行的面板教程。官方工作台未准入这些旧版原生界面。安装或启用插件不会加载它们，插件的后端运行状态不受影响。

- `client-panel` v1 和 v2 是 `workbench.panel` 兼容性 fixture。测试通过可见的版本标记验证更新与停用。
- `client-multi-panel` v1 分别在第一行声明 `workbench.panel`、在第二行声明 `ui:sidebar`。v2 的第二行故意在应用阶段抛出错误，用来验证失败不会影响第一行。
- `client-service-panel` v1 和 v2 是 `workbench.panel` 与受限服务桥接的兼容性 fixture。批准调用 `panel.version` 不会准入或加载这个旧版原生面板。

## 其他示例边界

- `acme-dashboard` v1/v2 声明 Cordis 后端行、静态 `services` 名称与 Surface 依赖；部署清单指向 v2。其 Surface artifact 有意在启动时失败，不应被算作健康部署。
- `hot-tool-plugin` 与 `hook-context-note`、`hook-runner-takeover` 是可安装的单目录 Cordis 示例；
  `cordis-greeting` 只作为 workspace 内部接线示例。

包管理测试在隔离的临时 profile 中真实安装示例；这不等于用户 profile 或浏览器的发布验收。
