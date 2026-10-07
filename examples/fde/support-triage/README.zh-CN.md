# 客服分诊 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

客服负责人需要一致的事件分诊与可审核的客户回复。

**流程：** 读取工单 → 分类 → 草稿 → 人工审批 → 模拟发送回执。

分诊面板在公开工具结果槽位显示工单、分类与发送状态，不投递真实邮件。

## 包含组件

- `main`：作者工具包插件，注册业务工具、`fde.support-triage` loop、策略与随包 Skill。
- `runtime.mjs`：通过公开端口实现带版本 checkpoint、取消与结果未知时的恢复拒绝，每个独立包均包含此辅助文件。
- `fixtures/`：合成输入；`skills/playbook/SKILL.md`：客户手册，注册并加入模型提示。
- 在 `agnes.kinds` 声明 bundle 类型；`agnes.bundles.support-triage` 选择 loop 并提供预设。

## 安装与运行

使用 Node 24.10+ 与[源码安装](../../../docs/guide/install.zh-CN.md)得到的 `agh`。预览作者包尚不承诺公开 npm 发行。全新的 local-dev 配置提供无密钥 `demo/demo-model`。已有配置须保留该路由，或使用下节的真实模型配置。安装时审核源码、依赖和能力；确认后安装、信任并启用审核过的包。

最初从仓库根目录执行：

```sh
cd examples/fde/support-triage
agh plugins add .
agh run --bundle '@agnes-fde/support-triage#support-triage' --preset support-triage --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装可分发包。运行文件、夹具、手册和可选面板/MCP 服务一同打包，不依赖工作区源码导入或相邻示例。

无人值守的 agh run 会拒绝权限请求，停在写入前，这是预期结果。在 Web 完成流程，确认或拒绝具体动作。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/support-triage#support-triage`，保存并按提示重启 Host。创建新会话，选择 `support-triage` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。审核审批卡片；拒绝后停止，不产生动作回执。

这是使用固定标识的单轮夹具流程。内置 Demo 不执行真实推理，工具产生确定性依据，客服/CRM 草稿为脚本内容。快速测试使用固定模型回复。配置真实模型后，工具依据保持相同，模型文字来自真实推理。

## 真实模型

先在 AGH 配置真实路由和模型，再将 [real-model.bundle.json](real-model.bundle.json) 中插件 target 与预设 primary 路由改成同一组标识：

```sh
agh run --bundle ./real-model.bundle.json --preset support-triage --input fixtures/prompt.txt --json
```

loop 使用显式 `target`，仅在客户端选择模型不会改变它。Web 中在用户 profile composition 为该插件行设置等价 target，并为新会话选择对应模型。密钥不要放进示例包。

## 客户适配

替换客服系统连接器、分类、SLA 和模板。审批参数包含完整草稿，执行后核对投递回执。

事实与审批留在后台。普通插件在受信进程内运行，声明用于审核，不提供进程隔离。拒绝工具、模型错误与中断的 pending 阶段都会停止。pending checkpoint 须先对账再新建任务，不自动重放结果未知的副作用。

## 快速测试

将本源码版本构建的匹配作者包 tarball 安装到此独立目录后：

```sh
npm run build
npm test
```

测试以固定模型回复驱动公开 loop/tool 契约，核对结果与拒绝边界。仓库中的外部验证命令见[索引](../README.zh-CN.md#验证)。
