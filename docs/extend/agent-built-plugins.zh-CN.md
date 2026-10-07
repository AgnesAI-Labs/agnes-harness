# 让 Agent 创建插件

[English](agent-built-plugins.md) | 简体中文

[作者指南](README.zh-CN.md) · [本地插件](local-plugins.zh-CN.md) · [测试](testing.zh-CN.md)

先配置能调用工具、编辑文件的模型 route，再在 daemon 的工作区内打开本地会话。内置 Demo 用于教学回复，不是自动插件作者。可以要求：

> 创建一个校验客户编号的插件，返回规范化编号，解释无效输入。包含确定性测试，执行测试，并在安装前让我确认。

默认内置的 **Plugin Helper** 提供三个工具：

1. 调用 `plugin_helper_guide`，传入 kind: tool（也可选 skill / skin）。它返回与当前版本匹配的说明和完整、自包含的 JavaScript 模板；不会创建作者工具包的全部五种 TypeScript 模板。
2. 实现所需行为，并在返回的文件集合中加入确定性测试。保持包名、row ID、具名 export、inject 服务与工具名一致。Helper 接受不带依赖与包脚本的纯文本 ESM；高级 Loop、adapter 与客户端面板走[作者快速入门](quickstart.zh-CN.md)。
3. 调用 `plugin_helper_create`，传入 files: [{ path, content }, ...]。它验证文件集合，在会话工作区的 .plugin-helper 下写入新目录，返回 `prepared proposal`、目录、integrity 与能力预览。这一步保存源码，不安装或执行插件。
4. 检查保存的文件，通过普通已审批 shell 工具执行测试。例如自包含的 node:test 用例可执行 `node --test <返回目录>/test.mjs`。Plugin Helper 不会自动跑测试。测试失败时如实报告，用 `plugin_helper_install` 的 action: cancel 取消 proposal，修复文件集合后重新 prepare。编辑已保存目录不会改变不可变的 `prepared proposal`。
5. 仅在检查和测试通过后，调用 `plugin_helper_install`，传入 action: commit 与 `proposalId`。本地确认单独授权安装、信任并启用这份已准备的确切内容。创建源码不等于同意安装；拒绝或取消后停止流程。
6. 返回 `submitted` 时结束当前轮次；后续轮次再用 `plugin_helper_install` 的 action: status 与同一 `proposalId` 查询。在“设置 → 插件管理”或 /admin/plugins 核对实际 running 状态后再报告成功。新工具在后续轮次可用，提交回执不代表已激活。

默认 Plugin Helper 没有上述名称以外的测试／脚手架工具；作者测试用普通已审批 shell 与文件工具。可选源码扩展 `agnes/plugin-creator` 是另一套作者工具包集成，不是默认内置 Helper。

写文件、测试与安装均遵循会话审批和沙箱策略；不得用 shell 或配置修改绕过拒绝。普通已安装插件执行可信 Node 代码，预览与测试通过并不会隔离模块初始化。测试需覆盖用户所需行为及无效输入，不能只保留 echo 断言；失败的检查和未验证的浏览器效果应分别报告。

后续源码开发可使用[本地插件](local-plugins.zh-CN.md)根目录与[热重载](hot-reload.zh-CN.md)：运行中的 daemon 会监视修改，也可用 `agh dev <folder>` / `agh plugins reload <id>` 立即重载。普通插件改动无需重启，新会话使用新代际，已有会话保留原版本。

内置 Plugin Helper 实现与模板位于 packages/package-manager/bundled-plugins/plugin-helper。独立 creator 扩展通过 node packages/base/extensions/plugin-creator/gen-assets.mjs 内嵌作者工具包资源；修改其 Skill 或 templates 后应重新生成。
