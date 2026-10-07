# 设备巡检 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

现场人员需要带版本的状态、异常判断，以及经过审核并可核对回执的受约束动作。

**流程：** 读取状态 → 检测异常 → 人工确认 → 受约束动作 → 回执与状态验证。

受 MHS 启发，不宣称 MHS 兼容。dry_run 默认为 true：温度保持 38 °C，回执标为 preview-only。仅接受 20–30 的 targetC、新鲜 expectedVersion 和受约束幂等键。显式 dry_run:false 也只改变本地模拟状态；回执仅存于进程中。

## 包含组件

- `main`：作者工具包插件，注册业务工具、`fde.device-inspection` loop、策略与随包 Skill。
- `runtime.mjs`：通过公开端口实现带版本 checkpoint、取消与结果未知时的恢复拒绝，每个独立包均包含此辅助文件。
- `fixtures/`：合成输入；`skills/playbook/SKILL.md`：客户手册，注册并加入模型提示。
- 在 `agnes.kinds` 声明 bundle 类型；`agnes.bundles.device-inspection` 选择 loop 并提供预设。

## 安装与运行

使用 Node 24.10+ 与[源码安装](../../../docs/guide/install.zh-CN.md)得到的 `agh`。预览作者包尚不承诺公开 npm 发行。全新的 local-dev 配置提供无密钥 `demo/demo-model`。已有配置须保留该路由，或使用下节的真实模型配置。安装时审核源码、依赖和能力；确认后安装、信任并启用审核过的包。

最初从仓库根目录执行：

```sh
cd examples/fde/device-inspection
agh plugins add .
agh run --bundle '@agnes-fde/device-inspection#device-inspection' --preset device-inspection --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装可分发包。运行文件、夹具、手册和可选面板/MCP 服务一同打包，不依赖工作区源码导入或相邻示例。

无人值守的 agh run 会停在待答的官方问题或工具权限请求。在 Web/TUI 问题卡片完成业务选择；动作仍需后台权限。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/device-inspection#device-inspection`，保存并按提示重启 Host。创建新会话，选择 `device-inspection` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。审核交付物和官方问题卡片；取消或权限拒绝后停止，不产生动作回执。

这是使用固定标识且等待人工答案的夹具流程。内置 Demo 不执行真实推理，工具产生确定性依据，客服/CRM 草稿为脚本内容。快速测试使用固定模型回复。配置真实模型后，工具依据保持相同，模型文字来自真实推理。

## 真实模型

先在 AGH 配置真实路由和模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset device-inspection --input fixtures/prompt.txt --json
```

loop 使用 Core 的公开 `prepareRequest()`，由会话主模型提供路由、契约与哈希。Web 中配置等价预设 primary 路由，并为新会话选择对应模型。密钥不要放进示例包。

## 客户适配

先保留模拟，定义单位、限额和前置条件，验证适配器并加入持久去重和回执对账。控制器保留互锁、急停与实时安全职责；结果未知时先检查，不重放。

事实与审批留在后台。普通插件在受信进程内运行，声明用于审核，不提供进程隔离。拒绝工具、模型错误与中断的 pending 阶段都会停止。pending checkpoint 须先对账再新建任务，不自动重放结果未知的副作用。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。动作前 `ask_user_question` 提供 Proceed/Cancel 选择，保存问题标识并暂停。只有经校验的普通用户答案才能继续，无效答案保持等待；业务选择不授予工具权限。

官方 `write` 在 `fde-output/device-inspection/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **3.0.0** 使用 checkpoint codec **3** 保存待答问题。升级后新建会话，旧 codec 1/2 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

在 Web/TUI 中先输入 `/plan on`，再提交**新任务**，启用官方计划模式。Loop 从公开提示区识别计划模式，以 `exit_plan_mode` 提交固定业务步骤；官方审批卡片获准后才运行连接器、报告或命令。拒绝计划会停止流程，未启用时跳过此关卡。示例策略保留默认策略的计划模式拒绝结果。计划获准不替代后续业务问题或工具权限；单个原生工具票据通过公开续跑端口和原调用回执恢复，未知回执会阻止重放。

随包 SDK 连接器调用 MCP 服务原始工具名（status / cool / receipt），它们不是 Host 别名。若改为 Host 配置的服务，服务 ID 为 `device` 时，在 loop 调用及允许列表中使用规范名称 `mcp__device__status`, `mcp__device__cool`, `mcp__device__receipt`；若 ID 需清理或有冲突，以目录中的实际名称为准。新客户集成不沿用旧的哈希 `mcp_...` 别名。暴露资源的服务可使用官方 `list_mcp_resources` / `read_mcp_resource`，本夹具仅暴露工具。

## 快速测试

将本源码版本构建的匹配作者包 tarball 安装到此独立目录后：

```sh
npm run build
npm test
```

测试以固定模型回复驱动公开 loop/tool 契约，核对结果与拒绝边界。短小的 .e2e.test.mjs 还会启动并关闭真实本地 MCP stdio 夹具。仓库中的外部验证命令见[索引](../README.zh-CN.md#验证)。
