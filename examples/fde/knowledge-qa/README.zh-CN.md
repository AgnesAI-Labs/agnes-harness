# 知识问答 bundle

[English](README.md) | 简体中文 · [FDE 示例](../README.zh-CN.md)

客服赋能团队根据本地政策目录回答问题，并提供可审核的引用。

**流程：** 问题 → 检索段落 → 带引用的摘录回答或拒答 → 模型解读。

输入文本是真正的查询。退款夹具引用 refunds.md 第 2 段与 30 天窗口。无匹配时返回 refused、空引用且不调用模型。轻量词项检索可能返回仅能部分回答问题的依据。

## 包含组件

- Loop：`fde.knowledge-qa`，支持带版本 checkpoint 与取消；每个独立 tarball 包含 `runtime.mjs`。
- Tools：夹具连接器和转换，由 `main` 通过公开作者工具包注册。
- Policy：`fde.knowledge-qa`，拒绝写入，包括全访问会话。
- Skills：随包 `skills/playbook/SKILL.md` 注册并加入模型请求。
- Bundle：`agnes.kinds` 声明 `bundle`，`agnes.bundles.knowledge-qa` 组合 loop、Skill 和预设。

## 安装与运行

使用 Node 24.10+，按[安装指南](../../../docs/guide/install.zh-CN.md)构建 `agh`。预览作者包尚不承诺公开 npm 发行。安装时审核源码、依赖和能力。全新 local-dev 提供无密钥 `demo/demo-model`；已有配置须保留该路由，或使用下节真实目标。

从仓库根目录开始：

```sh
cd examples/fde/knowledge-qa
agh plugins add .
agh run --bundle '@agnes-fde/knowledge-qa#knowledge-qa' --preset knowledge-qa --input fixtures/prompt.txt --json
agh serve
```

在本目录执行 `npm pack`，通过 `agh plugins add ./NAME.tgz` 安装分发包。运行文件、夹具、Skill 和可选面板一同打包，没有工作区或相邻示例导入。

此只读流程可无交互完成，从 JSONL 工具结果和助手消息查看报告与依据。

Web：打开 serve 地址，进入 **Admin → Plugins → Bundles**，选择 `@agnes-fde/knowledge-qa#knowledge-qa`，保存并按提示重启 Host。新建会话，选择 `knowledge-qa` 预设与 Demo 模型，粘贴 `fixtures/prompt.txt`。旧会话保留固定 loop。查看依据与轨迹。

查询文本控制检索，其他工具使用随包夹具。内置 Demo 不推理，工具产生完整夹具成果，快速测试使用固定模型回复。真实模型补充草稿解读，不能覆盖引用、金额、发现或审批。

## 真实模型

先配置 AGH 路由与模型，再将 [real-model.bundle.json](real-model.bundle.json) 中预设 primary 路由改为已配置的标识：

```sh
agh run --bundle ./real-model.bundle.json --preset knowledge-qa --input fixtures/prompt.txt --json
```

loop 调用 Core 的公开 `prepareRequest()`；Core 解析会话主模型、契约与哈希。Web 中在用户 profile composition 配置等价预设 primary 路由，为新会话选择该模型。凭据留在包外。

## 客户适配

替换成已注册的客户只读检索工具，在插件配置 workflow.retrieverTool 中填写工具名。契约为 { question: string } → { sources: Array<{ quote: string, citation: string }> }；没有依据返回空数组。每条来源须有非空摘录与引用，策略拒绝可写检索。权限过滤与稳定引用标识由连接器负责，按客户语言调整分词与相关性阈值。

在插件行配置检索工具名：

```json
{
  "workflow": { "retrieverTool": "customer_retrieve" }
}
```

运行前通过公开作者工具包注册该工具；默认使用夹具检索器。

后台插件运行在受信进程内，能力声明用于审核，不隔离任意代码。工具拒绝或模型失败会停止流程。pending checkpoint 不自动重放：再次运行前核对依据。模拟回执不是客户系统的持久账本。

## 官方工具与输出

已安装的 standard 预设提供[官方工具](../../../docs/reference/default-tools.zh-CN.md)，本 bundle 只注册业务连接器和格式器。bundle 策略继续拒绝修改业务源数据。

官方 `write` 在 `fde-output/knowledge-qa/<run-hash>/` 生成报告，`present` 复制为会话制品，使用标准打开/下载卡。问题前先交付草稿，完成后交付最终结果。策略仅允许此受限路径的报告写入，官方已读/过期版本保护继续生效；只读依据流程仍拒绝其他源数据写入。输出相对于会话工作区，manifest 声明了相应读写范围。

Loop **2.0.0** 使用 checkpoint codec **2** 保存待答问题。升级后新建会话，旧 codec 1 会被拒绝，不会自动重放。模型选择来自预设 primary 路由。快速测试使用官方工具端口、模型和制品回执的脚本夹具，不验证真实问题投影、下载、搜索服务或后台进程隔离。

TODO：Stream E2 合并后采用官方 Plan mode；当前保留固定阶段或 DAG 流程。

仅在插件配置 `workflow.publicQuery` 提供显式公开查询时调用 `web_search`，不会发送本地用户问题或文档内容。没有搜索服务时记录不可用，保留本地引用回答或拒答；公开摘要只是补充背景，不是本地依据。workflow 配置示例：

```json
{ "retrieverTool": "fde_knowledge_retrieve", "publicQuery": "public support handbook" }
```

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
