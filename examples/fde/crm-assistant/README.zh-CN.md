# CRM 助手 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

客户负责人需要根据 CRM 健康度与未解决工单制定续约跟进。

**流程：** 本地 MCP 查询 → Skills 续约手册 → 草拟备注 → 审批 → 幂等模拟备注。

连接器按需启动 stdio MCP 服务，转发取消并在卸载时关闭。备注仅存于进程中，不连接外部 CRM。随包 Skill 已注册并加入模型提示。

## 包含组件

- `main`：作者工具包插件，注册业务工具、`fde.crm-assistant` loop、策略与随包 Skill。
- `runtime.mjs`：通过公开端口实现带版本 checkpoint、取消与结果未知时的恢复拒绝，每个独立包均包含此辅助文件。
- `fixtures/`：合成输入；`skills/playbook/SKILL.md`：客户手册，注册并加入模型提示。
- 在 `agnes.kinds` 声明 bundle 类型；`agnes.bundles.crm-assistant` 选择 loop 并提供预设。

## 安装与运行

使用 Node 24.10+ 与[源码安装](../../../docs/guide/install.zh-CN.md)得到的 `agh`。预览作者包尚不承诺公开 npm 发行。全新的 local-dev 配置提供无密钥 `demo/demo-model`。已有配置须保留该路由，或使用下节的真实模型配置。安装时审核源码、依赖和能力；确认后安装、信任并启用审核过的包。

最初从仓库根目录执行：

```sh
cd examples/fde/crm-assistant
agh plugins add .
agh run --bundle '@agnes-fde/crm-assistant#crm-assistant' --preset crm-assistant --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装可分发包。运行文件、夹具、手册和可选面板/MCP 服务一同打包，不依赖工作区源码导入或相邻示例。

无人值守的 agh run 会拒绝权限请求，停在写入前，这是预期结果。在 Web 完成流程，确认或拒绝具体动作。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/crm-assistant#crm-assistant`，保存并按提示重启 Host。创建新会话，选择 `crm-assistant` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。审核审批卡片；拒绝后停止，不产生动作回执。

这是使用固定标识且等待人工答案的夹具流程。内置 Demo 不执行真实推理，工具产生确定性依据，客服/CRM 草稿为脚本内容。快速测试使用固定模型回复。配置真实模型后，工具依据保持相同，模型文字来自真实推理。

## 真实模型

先在 AGH 配置真实路由和模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset crm-assistant --input fixtures/prompt.txt --json
```

loop 使用 Core 的公开 `prepareRequest()`，由会话主模型提供路由、契约与哈希。Web 中配置等价预设 primary 路由，并为新会话选择对应模型。密钥不要放进示例包。

## 客户适配

替换 MCP 端点与账户字段，调整手册；凭据保存在部署绑定中。真实写入前加入持久幂等记录和回执查询。

事实与审批留在后台。普通插件在受信进程内运行，声明用于审核，不提供进程隔离。拒绝工具、模型错误与中断的 pending 阶段都会停止。pending checkpoint 须先对账再新建任务，不自动重放结果未知的副作用。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。动作前 `ask_user_question` 提供 Proceed/Cancel 选择，保存问题标识并暂停。只有经校验的普通用户答案才能继续，无效答案保持等待；业务选择不授予工具权限。

官方 `write` 在 `fde-output/crm-assistant/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **2.0.0** 使用 checkpoint codec **2** 保存待答问题。升级后新建会话，旧 codec 1 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

TODO：Stream E2 合并后采用官方 Plan mode；当前保留固定阶段或 DAG 流程。

## 快速测试

将本源码版本构建的匹配作者包 tarball 安装到此独立目录后：

```sh
npm run build
npm test
```

测试以固定模型回复驱动公开 loop/tool 契约，核对结果与拒绝边界。短小的 .e2e.test.mjs 还会启动并关闭真实本地 MCP stdio 夹具。仓库中的外部验证命令见[索引](../README.zh-CN.md#验证)。
