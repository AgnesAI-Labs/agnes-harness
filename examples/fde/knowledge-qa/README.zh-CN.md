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

## 快速测试

将本源码版本的匹配作者包 tarball 安装到目录后：

```sh
npm run build
npm test
```

测试覆盖公开 loop/tool/policy 契约、夹具结果与关键拒绝边界。[外部验证器](../README.zh-CN.md#验证)在仓库外安装并测试。本验证不代表真实模型质量、浏览器交互或客户系统验收。
