# 招聘初筛 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

招聘协调者为人工评审准备一致的岗位技能依据，并明确显示未知项。

**流程：** 简历夹具 → 数据最小化 → 岗位规则依据评审 → 偏差防护说明 → 人工确认后续评审。

岗位规则为 API 集成（4）、事故分析（3）、技术写作（3）分配权重。CAND-1 有 7/10 的明确依据，CAND-2 为 3/10。缺少依据表示未知，不能推断无能力。评分和模型提示前删除姓名、年龄、性别与学校。所有候选人均进入人工后续评审；模拟器不录用或拒绝任何人，分数不代表公平认证或经验证的招聘预测。

## 包含组件

- Loop：`fde.recruiting-screen`，支持带版本 checkpoint 与取消；每个独立 tarball 包含 `runtime.mjs`。
- Tools：夹具连接器和转换，由 `main` 通过公开作者工具包注册。
- Policy：`fde.recruiting-screen`，每次决定或发送动作均要求人工审批。
- Skills：随包 `skills/playbook/SKILL.md` 注册并加入模型请求。
- Bundle：`agnes.kinds` 声明 `bundle`，`agnes.bundles.recruiting-screen` 组合 loop、Skill 和预设。

## 安装与运行

使用 Node 24.10+，按[安装指南](../../../docs/guide/install.zh-CN.md)构建 `agh`。预览作者包尚不承诺公开 npm 发行。安装时审核源码、依赖和能力。全新 local-dev 提供无密钥 `demo/demo-model`；已有配置须保留该路由，或使用下节真实目标。

从仓库根目录开始：

```sh
cd examples/fde/recruiting-screen
agh plugins add .
agh run --bundle '@agnes-fde/recruiting-screen#recruiting-screen' --preset recruiting-screen --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装分发包。运行文件、夹具、Skill 和可选面板一同打包，没有工作区或相邻示例导入。

先交付草稿，再由官方问题卡暂停流程。无交互运行在问题或不可用的工具权限边界停止。在 Web/TUI 回答，再按需批准动作权限；取消不会记录动作回执。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/recruiting-screen#recruiting-screen`，保存并按提示重启 Host。新建会话，选择 `recruiting-screen` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看依据与轨迹。

这是固定合成输入且等待人工答案的流程：提示用于启动，业务数据由夹具文件定义。内置 Demo 不推理，工具产生完整夹具成果，快速测试使用固定模型回复。真实模型补充草稿解读，不能覆盖引用、金额、发现或审批。

## 真实模型

先配置 AGH 路由与模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset recruiting-screen --input fixtures/prompt.txt --json
```

loop 调用 Core 的公开 `prepareRequest()`；Core 解析会话主模型、契约与哈希。Web 中在用户 profile composition 配置等价预设 primary 路由，为新会话选择该模型。凭据留在包外。

## 客户适配

使用已授权、最小化的简历及客户审核的岗位相关规则。验证依据摘录，对每位候选人使用一致且可访问的后续问题。检查特征代理、留存、授权和客户招聘流程。最终录用决定由人负责，并通过已审核系统记录理由。

后台插件运行在受信进程内，能力声明用于审核，不隔离任意代码。工具拒绝或模型失败会停止流程。pending checkpoint 不自动重放：再次运行前核对依据。模拟回执不是客户系统的持久账本。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。动作前 `ask_user_question` 提供 Proceed/Cancel 选择，保存问题标识并暂停。只有经校验的普通用户答案才能继续，无效答案保持等待；业务选择不授予工具权限。

官方 `write` 在 `fde-output/recruiting-screen/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **2.0.0** 使用 checkpoint codec **2** 保存待答问题。升级后新建会话，旧 codec 1 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

TODO：Stream E2 合并后采用官方 Plan mode；当前保留固定阶段或 DAG 流程。

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
