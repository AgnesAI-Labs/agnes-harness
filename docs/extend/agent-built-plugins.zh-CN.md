# 让 Agent 创建插件

[English](agent-built-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试](testing.zh-CN.md)

在 daemon 的工作区内开启会话，例如要求：

> 创建一个校验客户编号的插件，返回规范化编号，解释无效输入。编写确定性测试，并安装到本地。

内置 plugin creator Skill 引导 Agent 完成以下流程：

1. `plugin_creator_guide` 读取创建说明。
2. `plugin_scaffold` 使用 `create-agh-plugin` 的五种模板创建新目录，并将包入口和测试指向 TypeScript 源码。
3. 使用普通读写工具编辑代码，经 shell 工具安装开发依赖。源码预览 SDK 的本地链接方式见[快速入门](quickstart.zh-CN.md)。
4. `plugin_test` 执行 `npm test`。工具模板覆盖真实 Host 注册、无效输入、取消，以及 `scriptedModel` 驱动的工具调用；Loop 使用已有的 `driveLoop` testkit，不调用付费模型。
5. `plugin_install_local` 再次执行测试，将通过测试的源码复制到 `<session cwd>/.agnes/plugins/<name>`，拒绝覆盖已有目录，省略依赖和构建目录。
6. 查看 `/admin/plugins`，激活后在新会话试用。程序化代际重载入口接通前需要重启 daemon，详见[本地插件](local-plugins.zh-CN.md)。

写代码、安装依赖、执行测试和安装插件均遵循会话审批和沙箱策略；拒绝、失败或取消会停止后续步骤。安装到全局 home 时使用普通审批工具及配置的允许路径。测试必须覆盖用户要求的行为，不能只保留模板的 echo 断言。

Skill 和模板资源内嵌在插件中，打包程序无需源码 checkout。修改 Skill 或 `templates/` 后运行 `node packages/base/extensions/plugin-creator/gen-assets.mjs` 更新生成资源。Agent 应如实报告失败的检查与尚未验证的集成。
