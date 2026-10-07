# 数据报告 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

财务分析人员需要可复核的指标与可分享的 CSV 报告。

**流程：** 读取 CSV → 计算合计与利润率 → 含 SVG 图表的 Markdown/HTML → 模型解读。

不需要图表库。报告通过工具结果返回，再写入受限输出目录并由官方 `present` 登记；有边界的 CSV 方言拒绝带引号字段，避免静默误读。

## 包含组件

- `main`：作者工具包插件，注册业务工具、`fde.data-report` loop、策略与随包 Skill。
- `runtime.mjs`：通过公开端口实现带版本 checkpoint、取消与结果未知时的恢复拒绝，每个独立包均包含此辅助文件。
- `fixtures/`：合成输入；`skills/playbook/SKILL.md`：客户手册，注册并加入模型提示。
- 在 `agnes.kinds` 声明 bundle 类型；`agnes.bundles.data-report` 选择 loop 并提供预设。

## 安装与运行

使用 Node 24.10+ 与[源码安装](../../../docs/guide/install.zh-CN.md)得到的 `agh`。预览作者包尚不承诺公开 npm 发行。全新的 local-dev 配置提供无密钥 `demo/demo-model`。已有配置须保留该路由，或使用下节的真实模型配置。安装时审核源码、依赖和能力；确认后安装、信任并启用审核过的包。

最初从仓库根目录执行：

```sh
cd examples/fde/data-report
agh plugins add .
agh run --bundle '@agnes-fde/data-report#data-report' --preset data-report --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装可分发包。运行文件、夹具、手册和可选面板/MCP 服务一同打包，不依赖工作区源码导入或相邻示例。

此只读流程可在无交互模式完成，从 JSONL 工具结果与助手消息检查报告。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/data-report#data-report`，保存并按提示重启 Host。创建新会话，选择 `data-report` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看报告与执行轨迹。

这是使用固定标识的单轮夹具流程。内置 Demo 不执行真实推理，工具产生确定性依据，客服/CRM 草稿为脚本内容。快速测试使用固定模型回复。配置真实模型后，工具依据保持相同，模型文字来自真实推理。

## 真实模型

先在 AGH 配置真实路由和模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset data-report --input fixtures/prompt.txt --json
```

loop 使用 Core 的公开 `prepareRequest()`，由会话主模型提供路由、契约与哈希。Web 中配置等价预设 primary 路由，并为新会话选择对应模型。密钥不要放进示例包。

## 客户适配

定义客户 CSV 方言、指标口径与数据来源。通过公开文件读取端口替换夹具；单独加入经过审批的导出能力。

事实与审批留在后台。普通插件在受信进程内运行，声明用于审核，不提供进程隔离。拒绝工具、模型错误与中断的 pending 阶段都会停止。pending checkpoint 须先对账再新建任务，不自动重放结果未知的副作用。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。bundle 策略继续拒绝修改业务源数据。

官方 `write` 在 `fde-output/data-report/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **3.0.0** 使用 checkpoint codec **3** 保存待答问题。升级后新建会话，旧 codec 1/2 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

在 Web/TUI 中先输入 `/plan on`，再提交**新任务**，启用官方计划模式。Loop 从公开提示区识别计划模式，以 `exit_plan_mode` 提交固定业务步骤；官方审批卡片获准后才运行连接器、报告或命令。拒绝计划会停止流程，未启用时跳过此关卡。示例策略保留默认策略的计划模式拒绝结果。计划获准不替代后续业务问题或工具权限；单个原生工具票据通过公开续跑端口和原调用回执恢复，未知回执会阻止重放。

## 快速测试

将本源码版本构建的匹配作者包 tarball 安装到此独立目录后：

```sh
npm run build
npm test
```

测试以固定模型回复驱动公开 loop/tool 契约，核对结果与拒绝边界。仓库中的外部验证命令见[索引](../README.zh-CN.md#验证)。
