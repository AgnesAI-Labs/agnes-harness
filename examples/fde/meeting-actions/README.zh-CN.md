# 会议行动项 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

交付负责人将发布会议转录整理为明确责任的行动项，在向团队发送前审核记录。

**流程：** 会议转录 → 摘要、决定、负责人和日期 → Markdown 导出与面板 → 审批 → 模拟发送。

合成转录使用显式 SUMMARY、DECISION、ACTION 标记。Morgan/2026-10-09 与 Casey/2026-10-12 保留来源行号。导出返回 filename、mediaType 与 markdown，不写文件。公开工具结果面板展示依据，完整导出能放入预览时可下载。截断预览不提供下载，较大导出请使用完整 JSONL 结果。发送始终需要审批，externalDelivery 为 false。

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

无交互 CLI 会拒绝审批：生成草稿或导出后停止动作，不产生回执。请在 Web 完成确认。快速测试注入批准与拒绝，不产生客户副作用。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/meeting-actions#meeting-actions`，保存并按提示重启 Host。新建会话，选择 `meeting-actions` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看依据与轨迹，会议面板可展示工具结果。

这是固定合成输入的单轮流程：提示用于启动，业务数据由夹具文件定义。内置 Demo 不推理，工具产生完整夹具成果，快速测试使用固定模型回复。真实模型补充草稿解读，不能覆盖引用、金额、发现或审批。

## 真实模型

先配置 AGH 路由与模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset meeting-actions --input fixtures/prompt.txt --json
```

loop 调用 Core 的公开 `prepareRequest()`；Core 解析会话主模型、契约与哈希。Web 中在用户 profile composition 配置等价预设 primary 路由，为新会话选择该模型。凭据留在包外。

## 客户适配

用客户转录解析器或经校验的结构化模型输出替换标记提取器；缺少负责人或日期时追问。加入日历、时区规则与稳定行动标识。用幂等连接器替换固定收件人与发送器并验证回执。审批保留在后台，面板仅渲染。TODO：官方 present 和 ask_user_question 可用后分别替换导出与可编辑问题；当前使用轻量导出工具与工具策略审批。

后台插件运行在受信进程内，能力声明用于审核，不隔离任意代码。工具拒绝或模型失败会停止流程。pending checkpoint 不自动重放：再次运行前核对依据。模拟回执不是客户系统的持久账本。

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
