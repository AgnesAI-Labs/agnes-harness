# Client Panel v2

`client-panel` 的热更新候选版本。它与 v1 使用相同的包 ID 和插件 ID，将
`ui:sidebar` 的可见版本标识改为 `Agnes client module demo · v2`，并更换侧栏强调色。

在 v1 已安装、信任并启用时，用这个目录执行更新，可验证名册变更、
新快照加载与旧 fiber 卸载。

`contributes.client.publicConfig` 只承载随包发布、明确公开的展示元数据；它不是后端 runtime config，也不能放凭据、token 或 secret 引用。
