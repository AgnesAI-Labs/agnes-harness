# Client Panel v1

可安装的最小前端模块插件。它以更高优先级替换已迁移的 `ui:sidebar` 区域，显示
`Agnes client module demo · v1`。停用、撤信任或删除后，内置侧栏必须立即恢复。

- `capabilities.ui: ["client"]` 与 `contributes.client` 成对声明。
- `contributes.client.publicConfig` 只承载随包发布、明确公开的展示元数据；它不是后端 runtime config，也不能放凭据、token 或 secret 引用。
- client entry 是无外部 import 的原生 ESM，可直接从不可变快照加载。
- 同包 ID 的 `v2` 将侧栏标识改为 `v2`，用于验证无刷新更新。
