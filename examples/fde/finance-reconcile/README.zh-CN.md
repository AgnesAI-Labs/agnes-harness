# 财务对账 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

财务人员核对银行与账簿台账，在记录前审核建议调整分录。

**流程：** 两份 CSV 台账 → 整数分匹配 → 差异与建议 → 审批 → 模拟平衡分录。

TX-1 匹配；TX-2 相差 5000 分；银行独有 TX-3 为 7525 分；账簿独有 TX-4 保持未解决。账簿独有及日期不符交易不自动建议分录；重复标识拒绝对账。CSV 有意限制为无引号字段、ISO 日期及两位小数 USD 金额。批准后生成 cash/review-suspense 的相反符号金额，posted 为 false，不改变真实账户。

## 包含组件

- Loop：`fde.finance-reconcile`，支持带版本 checkpoint 与取消；每个独立 tarball 包含 `runtime.mjs`。
- Tools：夹具连接器和转换，由 `main` 通过公开作者工具包注册。
- Policy：`fde.finance-reconcile`，每次决定或发送动作均要求人工审批。
- Skills：随包 `skills/playbook/SKILL.md` 注册并加入模型请求。
- Bundle：`agnes.kinds` 声明 `bundle`，`agnes.bundles.finance-reconcile` 组合 loop、Skill 和预设。

## 安装与运行

使用 Node 24.10+，按[安装指南](../../../docs/guide/install.zh-CN.md)构建 `agh`。预览作者包尚不承诺公开 npm 发行。安装时审核源码、依赖和能力。全新 local-dev 提供无密钥 `demo/demo-model`；已有配置须保留该路由，或使用下节真实目标。

从仓库根目录开始：

```sh
cd examples/fde/finance-reconcile
agh plugins add .
agh run --bundle '@agnes-fde/finance-reconcile#finance-reconcile' --preset finance-reconcile --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装分发包。运行文件、夹具、Skill 和可选面板一同打包，没有工作区或相邻示例导入。

同一 preset surface 在对话与工作台展示差异表、金额图和调整表单。审阅后点击 **确认调整**，后台再通过原工具路径申请模拟调整权限。刷新恢复同一个审阅状态和待审批回执；无交互运行在此边界等待。TUI／渠道展示文本摘要与工作台链接。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/finance-reconcile#finance-reconcile`，保存并按提示重启 Host。新建会话，选择 `finance-reconcile` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看依据与轨迹。

这是固定合成输入且等待人工答案的流程：提示用于启动，业务数据由夹具文件定义。内置 Demo 不推理，工具产生完整夹具成果，快速测试使用固定模型回复。真实模型补充草稿解读，不能覆盖引用、金额、发现或审批。

## 真实模型

先配置 AGH 路由与模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset finance-reconcile --input fixtures/prompt.txt --json
```

loop 调用 Core 的公开 `prepareRequest()`；Core 解析会话主模型、契约与哈希。Web 中在用户 profile composition 配置等价预设 primary 路由，为新会话选择该模型。凭据留在包外。

## 客户适配

替换为授权台账连接器，与客户会计确认匹配键、符号、币种与容差。带引号字段使用正式 CSV 解析器，其他币种须验证精度。记账前解决歧义匹配与账户映射。经批准的幂等连接器须验证账簿回执，模型文字不能决定金额。

后台插件运行在受信进程内，能力声明用于审核，不隔离任意代码。工具拒绝或模型失败会停止流程。pending checkpoint 不自动重放：再次运行前核对依据。模拟回执不是客户系统的持久账本。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)和 `agnes/intelligent-ui`。业务插件通过 `ui_render` 声明审阅界面，按钮映射到原 `fde_finance_approve`。业务确认不授予工具权限。默认 Loop 与财务 Loop 使用同一个公开 deferred-invocation 合同；终态结果通过 SC1 到达 Agent，再由 `ui_update` 标记已处理行，保留未解决交易。

官方 `write` 在 `fde-output/finance-reconcile/<run-hash>/` 生成报告，`present` 将最终结果复制为会话制品，使用标准打开／下载卡。策略仅允许此受限路径的报告写入，已读／过期版本保护继续生效。输出相对于会话工作区，manifest 声明相应读写范围。

Loop **4.0.0** 使用 checkpoint codec **4** 保存业务依据、SC1 输入和已处理交易 ID。升级后新建会话，旧 codec 被拒绝。工具 dispatch 前，业务校验核对已提交建议、精确金额、唯一 ID 和已处理行。模型选择来自预设 primary 路由。已编写真实隔离 Host、原审批路径、UI 插件与脚本模型的测试；本开发窗口按规则未运行。

在 Web/TUI 中先输入 `/plan on`，再提交**新任务**，启用官方计划模式。Loop 从公开提示区识别计划模式，以 `exit_plan_mode` 提交固定业务步骤；官方审批卡片获准后才运行连接器、报告或命令。拒绝计划会停止流程，未启用时跳过此关卡。示例策略保留默认策略的计划模式拒绝结果。计划获准不替代后续 UI 确认或工具权限；单个原生工具票据通过公开续跑端口和原调用回执恢复，未知回执会阻止重放。

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
