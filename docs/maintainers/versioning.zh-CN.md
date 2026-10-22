# 版本与兼容性

[English](versioning.md) | 简体中文

[文档导航](../README.zh-CN.md) · [发布检查](release.zh-CN.md)

AGH 当前以 pre-alpha 源码版本提供。使用时记录 Git revision，文档、示例与构建产物应来自同一版本；预览阶段的配置、协议和扩展接口可能出现破坏兼容性的变化。

## 包版本

面向独立分发的包采用 Semantic Versioning，并按各自接口分别管理版本。`0.0.0` 标记未发布的开发包，不能直接发布到 npm；`private: true` 防止意外发布，不影响源码的开源许可。

Extension API 已有单独的版本与[变更记录](../../packages/extension-api/docs/CHANGELOG.md)。包版本号不表示整个产品已经稳定或完成所有平台验收。

工作区的部署清单用 `harnessRange` 声明它支持的 harness。这个范围按 harness 契约版本检查，即 `@agnes/protocol` 导出的 `HARNESS_VERSION`，与该包的版本号一致；不按某次构建自己的版本号检查。因此未发布的 `0.0.0` 构建同样接受为它所实现的契约编写的清单。

首次 npm 分发需要明确包集合、正式版本、兼容说明和依赖解析，只对选定包移除 `private`。破坏已发布接口的变化升 major，兼容功能升 minor，兼容修复升 patch；发布标签采用 `<package-name>@v<version>`。`workspace:*` 依赖在发布时解析为兼容版本，仓内锁文件继续固定开发与 CI 的依赖图。

升级前阅读变更说明并保留所需数据。运行数据不迁移。不支持的 home 布局须新建 home；不兼容 SQLite 目录按[数据格式恢复](../guide/install.zh-CN.md#数据格式与升级)处理并保留 profiles。运行时目录替换和 Git 源码切换分别操作，修改版本号不会完成这些步骤。
