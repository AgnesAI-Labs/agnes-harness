# 会话与恢复：让工作接续起来

[English](sessions.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安全边界](security.zh-CN.md)

工作可以跨越多次打开终端或浏览器的过程。用明确的会话 ID 找回上下文、查看执行记录，并决定接着做什么。

会话承载任务历史、模型选择和执行状态；一次用户请求会形成一轮运行。CLI、Web 和 SDK 读取相同后台的事实，但界面的历史投影不是原始数据库备份。

## 找到并继续会话

```sh
node packages/cli/dist/local/agnes.mjs sessions --json
node packages/cli/dist/local/agnes.mjs sessions show SESSION_ID
node packages/cli/dist/local/agnes.mjs resume SESSION_ID -p "继续说明尚未完成的部分"
node packages/cli/dist/local/agnes.mjs -p --resume SESSION_ID "接着上次的讨论"
node packages/cli/dist/local/agnes.mjs -p --continue "继续"
```

`--continue` 与 `--resume` 互斥。需要精确控制时使用明确 ID，避免恢复到不期望的最近会话。新建会话和恢复会话的工作目录、模型、权限需要分别核对；切换 Web 工作区不会把已有会话的所有权转移给另一个后台。

## 导出与导入

```sh
node packages/cli/dist/local/agnes.mjs export SESSION_ID --format agnes -o session.jsonl
node packages/cli/dist/local/agnes.mjs export SESSION_ID --format sharegpt -o training.json
node packages/cli/dist/local/agnes.mjs export SESSION_ID --html -o session.html
node packages/cli/dist/local/agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:docs-copy
```

上例原生导入使用一个新的 session key；重复演练时换一个未使用的 key。省略 key 可能指回原会话，遇到已打开或非空目标会拒绝。import 是 one-shot 路径，不支持 `--connect`。

导出文件可能包含提示、工具参数、路径和业务数据，分享前审查。`--raw` 会减少隐私过滤，不是默认共享方式。外部格式（Claude Code/Codex/Pi）导入是格式转换，不能恢复原工具权限、原进程或保证所有语义无损。导入失败要保留错误并检查会话列表，不通过重试换 ID 来掩盖失败。

## 中断与重启

停止请求、进程退出、审批到期和一轮完成是不同事实。Core 通过持久事件与状态机恢复；副作用未知时可能需要人工确认，不能保证外部系统操作“恰好一次”，也不能用重新发相同自然语言来代替恢复。

后台故障后：先保留 home 和错误，查看 `daemon status`，用同一 profile 启动后检查历史，再决定继续。不要删除 SQLite、owner 或审计记录强行重开。数据库的备份应在停止对应实例后保存同一 home 中相互关联的数据；单独复制正在写入的数据库文件不构成可靠备份。

TUI `/rewind SEQ` 和 Web 分叉从某个历史位置创建新会话，不撤销已经写入的文件、不撤回网络请求、不让已执行工具失效。恢复也按当前权限重新约束执行，而不是复活过去的授权。

实现依据：[会话 SDK](../../packages/sdk/src/session.ts)、[Core](../../packages/core/src)、[导入](../../packages/cli/src/commands/import.ts)、[导出](../../packages/cli/src/commands/export.ts)。
