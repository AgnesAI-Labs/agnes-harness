# 支持范围与已知限制

[English](limitations.md) | 简体中文

[文档导航](../README.zh-CN.md) · 验证方法与范围见[验证记录](../maintainers/verification.zh-CN.md)

用本页判断 AGH 是否适合你当前的试用或集成目标。表中区分已实现但受约束的能力、尚待验证的环境，以及仍在探索的方向；具体运行结果集中在[验证记录](../maintainers/verification.zh-CN.md)。

| 领域 | 当前边界 |
| --- | --- |
| 发布 | pre-alpha；项目自有代码采用 [Apache-2.0](../../LICENSE)，第三方例外见 [NOTICE](../../NOTICE)；没有公共 npm 发布、消费者安装器或自动更新承诺 |
| 平台 | macOS 与 Linux 已有持续维护的原生、进程及 Chromium 检查和平台基线。Windows 完整端到端验收未验证；全新机器安装、签名与升级交付仍需独立发行检查 |
| Windows Web 静态资源 | 主线已将 URL 路径规范化改为 posix 路径，修复 vendor 资源路由；相关测试在 macOS 通过不等于真实 Windows 浏览器通过 |
| Windows 安全 | 部分文件/符号链接、受限 token 与网络沙箱边界未完整关闭；不能宣称与 macOS/Linux 等价 |
| Web | 本机回环工作台，不是带远程登录/反向代理支持的公共服务；每个浏览器能力须单独验证 |
| 普通插件 | 受信进程内代码；`ctx.extension()` 可注册全部 16 类 hook，但 Service/Projection/Slot/Resource 须走已验证行上的 Cordis 入口 |
| 联动 | 需 `agnes.plugins` 后端行 + 同 rowId 的 `agnes.clientDescriptors` + 服务定义/策略与当前会话 allow-list；不能把任意 Cordis service 自动远程化 |
| 热更新 | 审阅后的代码版本并存；新会话绑定当前代码，持久历史保留原绑定，动态 MCP/技能下一轮更新。快照缺失或不兼容时明确失败；基础后端需重启，外部副作用不回滚 |
| 回滚 | 上一版本保留有界；不能当作完整历史版本仓库，撤信任/删除快照不自动复活 |
| 插件删除 | 禁用/删除停止新代码绑定；已有会话保留快照，直到授权迁移或删除。进程/浏览器测试覆盖清理路径，具体部署插件及外部副作用仍需验证 |
| 长时间连续运行 | 内置、托管与普通插件行的租约已改为随行生命周期释放，旧的默认 24 小时到期问题已修复；写者租约仍单独管理。长期运行稳定性和资源使用仍需按工作负载验证，见[验证说明](../maintainers/verification.zh-CN.md) |
| MCP 会话调用 | 会话启动及轮次重载采用逐服务器行；当前路径跳过 OAuth 绑定，管理面测试成功不等于会话工具可用，见[MCP 运行方式](../guide/mcp.zh-CN.md#运行方式与版本) |
| Skills | 当前源码已实现永久删除与同名优先级覆盖。删除不可恢复/不可取消，失败可能部分删除并保留标记；package/runtime 不可单独删文件，runtime 不接受优先级覆盖 |
| Hooks / 扩展迁移 | `registerHook` 已开放 16 类事件；旧第三方 `agnes.extensions` 后端入口已收敛到 `agnes.plugins`。内置兼容路径不等于第三方可继续使用旧格式 |
| 模型 | 提供方目录与合同决定能力；文档自动演示使用本地模型夹具，外部模型效果和工具选择能力需另行验证 |
| 程序化工具 | 本地 macOS/Linux 支持 PTC，Windows 和远程执行不支持。独立 CPython 为实验功能，见[代码工作流](../guide/code-workflows.zh-CN.md) |
| Desktop/系统集成 | 不包含桌面客户端、系统登录启动注册、自动更新 |
| 行业/企业 | 业务接口、身份、数据与部署政策需要按[FDE 场景](../guide/why-agh.zh-CN.md)分别集成和验收 |
| MHS/物理设备 | 已有模拟 MCP 巡检组合包与预览接入点，不宣称物理适配器已验证或 MHS 兼容 |
| 性能/Eval | 不提供未经固定模型、预算、任务与测量验证的领先/提升数字 |

当前验证的命令与范围见[验证记录](../maintainers/verification.zh-CN.md)。版本更新时需重新核对当前源码，特别是长期运行、MCP OAuth 会话支持、插件与客户端描述合同、默认安全策略和发行状态。
