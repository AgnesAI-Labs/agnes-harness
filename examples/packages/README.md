当前可检查和安装的 Cordis 行示例通过 `agnes.plugins` 声明后端。前端模块及皮肤由
`agnes.clientDescriptors` 绑定同包的插件行，包括 `client-panel`、`client-multi-panel`、
`client-service-panel`、`skins-builtin` v1/v2、`skin-example` v1 和四组 DSH fixture。
`hot-service`、`hot-tool-plugin`、`cordis-greeting`、`hook-context-note`、
`hook-runner-takeover` 与 `acme-dashboard` 也使用行格式。包管理页的本地目录只公布已迁移
且检查通过的版本；测试专用 broken 版本须显式启用。

`hot-tool`、`agent-automation`、`compaction-policy`、`supply-rescue` 四组旧格式示例已从
仓库删除。包检查明确拒绝第三方 `agnes.extensions`；请使用上述行格式示例。

## DSH browser-row fixtures

`dsh-input-controls`、`dsh-model-picker-a`、`dsh-model-picker-b` 和 `dsh-tool-view` 是专门验证浏览器 row 生命周期的可安装 fixture，不是业务插件：

- `conversation.input.right` 覆盖 `list/session` 输入区追加；
- `conversation.input.model` 覆盖 `single/session` 的 A/B priority shadowing；
- `tool.call.toolview` 覆盖按 `bash` 或 `shell` 工具名匹配的 `keyed/session` 工具视图。

每个 family 都有 `v1`、`v2` 和仅测试目录可见的 `broken`：v1/v2 用于安装、启用、无刷新更新和清理，broken 用于 apply-stage、render-stage、abdication 和失败 row 隔离。前端资源通过 `agnes.client.json` 声明，client entry 依赖宿主 import map 的 `react`。

`client-panel/v1`、`v2` 作为 `workbench.panel` 兼容槽位 fixture 单独保留；它与上述 DSH browser-row fixture 的槽位合同和验收目标不同。

## 其他示例边界

- `client-panel` v1/v2 用 `workbench.panel` 的可见版本标记验证前端更新与停用。
- `acme-dashboard` v1/v2 声明 Cordis 后端行、静态 `services` 名称与 Surface 依赖；部署清单指向 v2。其 Surface artifact 有意在启动时失败，不应被算作健康部署。
- `hot-tool-plugin` 与 `hook-context-note`、`hook-runner-takeover` 是可安装的单目录 Cordis 示例；
  `cordis-greeting` 只作为 workspace 内部接线示例。

包管理测试在隔离的临时 profile 中真实安装示例；这不等于用户 profile 或浏览器的发布验收。
