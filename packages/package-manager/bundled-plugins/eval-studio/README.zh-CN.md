# 评测工作室

[English](README.md) | 简体中文

`@agnes/eval-studio` 是官方可选插件。在内置目录安装，审核权限、信任并显式启用；默认不安装、不启用。延迟加载工具 `eval_studio_import` 仅供选定的会话组合使用。[使用指南](../../../../docs/guide/eval-studio.zh-CN.md)。

首页“评测”和工作台面板接收明确粘贴的报告，展示案例差异并导出 JSON。导入仅存于内存，停用/卸载释放注册并清空；打开页面不调用模型。导入证据未经签发验证，不代表审批或可信执行证明。会话工具通过现有授权 artifact 端口保存验证后的数据集、报告和对照。

源码环境使用 Node 24.10+ 和仓库固定 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm exec tsx packages/package-manager/bundled-plugins/eval-studio/src/demo.mjs > /tmp/agh-eval-demo.json
```

演示使用 SDK `runHeadless`、scripted 模型适配器、内存 synthetic SDK 会话和临时私有工作区，不启动 daemon、不验证生产 Loop。`reports[0]` 通过；漏步骤、错误输出和尝试越权业务工具均失败。把报告对象分别粘贴为基线、候选，即可导出对照。没有真实 key、业务工具或网络请求。

Node 入口 `./runner` 导出 `runEvaluation(dataset, {variant, openCase, signal?, judge?})`、`digest(value)`；`./offline` 提供 `syntheticDataset`、`offlineFactory`、`demo`。使用者将 Node 入口与 SDK/model-adapters peers 打包；它不是安装后即可调用的独立 CLI。插件后台入口不加载 runner 或这些 peers。

`openCase({case, dataset, signal})` 是可信调用方拥有的集成，不接受浏览器或 agent 直接提供代码。它必须准备明确授权的隔离 home/workspace、仅 fixture 工具、所选模型/Loop/Skill/pin，并在运行时执行 token 预算。返回 `{client,cwd,components,replay,seed,effectPolicy:'fixture-only',observe,close}`；`observe()` 返回 `{output,tools,effects}`，`close()` 关闭客户端、模型和临时资源。runner 在 SDK 调用前验证实际组件哈希；factory 必须如实报告配置并拒绝真实业务效果。插件 JS/factory 是可信代码，本库不提供恶意 JS 沙箱，也不自动发现 profile、访问默认 home、扫描数据库或授权审批。setup、运行和 judge 均收到取消信号，调用方必须配合；清理失败使案例失败，清理完成后才调度下一案例。

v1 数据集包含 `schemaVersion:1`、`id`、`replay`（`scripted/strict/sequence`）、显式 `seed`（整数或 null）、`hashes`、`budget:{wallMs,tokens}`（tokens 可为 null），最多 100 个唯一案例。`hashes` 绑定 `prompt/tools/fixture/model/loop/skills/pins` 规范化 JSON 的 SHA-256；应包含实际提示词、工具 schema、fixture 内容、模型配置/回放原文、Loop 代码和 Skill 版本，不只写名称。不支持 seed 的模型填写 null。

案例为 `{id,input,expected:{output,requiredTools,allowedTools,effects}}`。输出可为精确文本或 `{json: value}` 规范化 JSON 结构相等断言，必需步骤不能遗漏，尝试越权工具或 fixture 效果不同单独失败。报告逐 case 保留执行数 0/1、结构/效果/预算检查、tokens、输出、工具和独立 judge。0 case 不通过；缺 usage 标 null/unknown，有限 token 预算且 usage 未知不能通过。token 仅统计 parent 输入加输出，不冒充子 Agent 全树账单；MVP 只提供有界单轮 fixture 集成。

数据集输入哈希绑定案例和断言；完整 binding hash 及内嵌数据集保留环境、预算、seed、回放模式。对照要求案例输入/断言相同，保留双方配置。strict 匹配规范化请求；sequence 只按顺序取响应，不证明请求等价。回放仅替换模型，生产运行仍可能执行工具，必须使用仅 fixture 的隔离集成。

judge 默认跳过，显式传入时是另一次可能收费的模型调用，返回 `{status:'pass'|'fail'|'unknown',tokens:number|null,cost:number|null}`。成本和 usage 独立显示；未知、错误或调用失败不能使案例通过。本包不提供真实模型胜率或隐藏 judge。导入总数会重新计算，但 case 声明仍未经验证；发布门禁需要另行审核的证据签发合同。

工具输入 `{kind:'dataset'|'report'|'comparison',json:'...'}`，comparison 为 `{baseline,candidate}`。最多 1 MiB；不执行数据、不接受读取文件路径。报告包含案例输出，分享前检查。没有遥测、上传、全局会话扫描或旧 home 迁移；格式不兼容时可读失败，沿用既有 backend pin 与 frontend activation 生命周期。
