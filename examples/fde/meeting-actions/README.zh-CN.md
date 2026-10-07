# 会议行动项 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

交付负责人将发布会议转录整理为明确责任的行动项，在向团队发送前审核记录。

**流程：** 会议转录 → 摘要、决定、负责人和日期 → Markdown 导出与面板 → 审批 → 模拟发送。

合成转录使用显式 SUMMARY、DECISION、ACTION 标记，保留 Morgan/2026-10-09、Casey/2026-10-12 与来源行号。业务格式器准备 Markdown，官方 `write`、`present` 生成文件及制品下载卡。会议面板渲染行动依据，官方 `ask_user_question` 等待发送选择；模拟发送器仍受后台权限控制（externalDelivery 为 false）。

## 包含组件

- Loop：`fde.meeting-actions`，支持带版本 checkpoint 与取消；每个独立 tarball 包含 `runtime.mjs`。
- Tools：夹具连接器和转换，由 `main` 通过公开作者工具包注册。
- Policy：`fde.meeting-actions`，每次决定或发送动作均要求人工审批。
- Skills：随包 `skills/playbook/SKILL.md` 注册并加入模型请求。
- Bundle：`agnes.kinds` 声明 `bundle`，`agnes.bundles.meeting-actions` 组合 loop、Skill 和预设。 客户端描述符通过公开 tool.call.toolview 槽位挂载面板。

## 安装与运行

使用 Node 24.10+，按[安装指南](../../../docs/guide/install.zh-CN.md)构建 `agh`。预览作者包尚不承诺公开 npm 发行。安装时审核源码、依赖和能力。全新 local-dev 提供无密钥 `demo/demo-model`；已有配置须保留该路由，或使用下节真实目标。

从仓库根目录开始：

```sh
cd examples/fde/meeting-actions
agh plugins add .
agh run --bundle '@agnes-fde/meeting-actions#meeting-actions' --preset meeting-actions --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装分发包。运行文件、夹具、Skill 和可选面板一同打包，没有工作区或相邻示例导入。

先交付草稿，再由官方问题卡暂停流程。无交互运行在问题或不可用的工具权限边界停止。在 Web/TUI 回答，再按需批准动作权限；取消不会记录动作回执。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/meeting-actions#meeting-actions`，保存并按提示重启 Host。新建会话，选择 `meeting-actions` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看依据与轨迹，会议面板可展示工具结果。

这是固定合成输入且等待人工答案的流程：提示用于启动，业务数据由夹具文件定义。内置 Demo 不推理，工具产生完整夹具成果，快速测试使用固定模型回复。真实模型补充草稿解读，不能覆盖引用、金额、发现或审批。

## 真实模型

先配置 AGH 路由与模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset meeting-actions --input fixtures/prompt.txt --json
```

loop 调用 Core 的公开 `prepareRequest()`；Core 解析会话主模型、契约与哈希。Web 中在用户 profile composition 配置等价预设 primary 路由，为新会话选择该模型。凭据留在包外。

## 客户适配

用客户转录解析器或经校验的结构化模型输出替换标记提取器；缺少负责人或日期时追问。加入日历、时区规则与稳定行动标识。用幂等连接器替换固定收件人与发送器并验证回执。审批保留在后台，面板仅渲染。

后台插件运行在受信进程内，能力声明用于审核，不隔离任意代码。工具拒绝或模型失败会停止流程。pending checkpoint 不自动重放：再次运行前核对依据。模拟回执不是客户系统的持久账本。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。动作前 `ask_user_question` 提供 Proceed/Cancel 选择，保存问题标识并暂停。只有经校验的普通用户答案才能继续，无效答案保持等待；业务选择不授予工具权限。

官方 `write` 在 `fde-output/meeting-actions/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **3.0.0** 使用 checkpoint codec **3** 保存待答问题。升级后新建会话，旧 codec 1/2 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

在 Web/TUI 中先输入 `/plan on`，再提交**新任务**，启用官方计划模式。Loop 从公开提示区识别计划模式，以 `exit_plan_mode` 提交固定业务步骤；官方审批卡片获准后才运行连接器、报告或命令。拒绝计划会停止流程，未启用时跳过此关卡。示例策略保留默认策略的计划模式拒绝结果。计划获准不替代后续业务问题或工具权限；单个原生工具票据通过公开续跑端口和原调用回执恢复，未知回执会阻止重放。

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
