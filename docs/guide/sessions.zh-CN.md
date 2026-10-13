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

上例原生导入使用一个新的 session key；重复演练时换一个未使用的 key。省略 key 可能指回原会话，遇到已打开或非空目标会拒绝。import 是 one-shot 路径，不支持 `--connect`。导入的会话会在首条事件（`session/start` 的 `imported` 字段）记录来源格式，原生导入还会记录原会话 key；从 Web 导出它的诊断包时会带一条 `imported` 警告。

导出文件可能包含提示、工具参数、路径和业务数据，分享前审查。`--raw` 会减少隐私过滤，不是默认共享方式。外部格式（Claude Code/Codex/Pi）导入是格式转换，不能恢复原工具权限、原进程或保证所有语义无损。导入失败要保留错误并检查会话列表，不通过重试换 ID 来掩盖失败。

## 中断与重启

停止请求、进程退出、审批到期和一轮完成是不同事实。Core 通过持久事件与状态机恢复；副作用未知时可能需要人工确认，不能保证外部系统操作“恰好一次”，也不能用重新发相同自然语言来代替恢复。

后台故障后：先保留 home 和错误，查看 `daemon status`，用同一 profile 启动后检查历史，再决定继续。不要删除 SQLite、owner 或审计记录强行重开。数据库的备份应在停止对应实例后保存同一 home 中相互关联的数据；单独复制正在写入的数据库文件不构成可靠备份。

TUI `/rewind SEQ` 和 Web 分叉从某个历史位置创建新会话，不撤销已经写入的文件、不撤回网络请求、不让已执行工具失效。恢复也按当前权限重新约束执行，而不是复活过去的授权。

## 打开很大的旧会话

历史很长或带大附件的会话打开可能要一段时间：完整历史要先校验，才会被信任。打开期间：

- 后台至少每 5 秒报告一次进度。2 秒后 Web 状态栏会显示进度，例如"仍在加载：正在校验历史 40%"。
- 客户端只在 30 秒内没有收到后台任何消息时才放弃（SDK `session.load` 抛出 `LoadStalled`，代码 `LOAD_STALLED`），总时长上限 10 分钟。持续报告进度的慢打开会等它完成。SDK 调用方可以用 `idleTimeoutMs` 与 `hardTimeoutMs` 调整这两个上限。
- 10 秒后 Web 会显示直接从存储读出的最近历史，只读，上方有提示；完整打开结束后自动切换到实时会话。打开失败时，存储中的历史会留在屏幕上，并写明原因。

存储中的历史未经校验：没有做完整性检查，只能用来阅读，不能当作会话内容的证明。大附件在其中显示为占位。只有在 worker 中运行会话的后台才提供它；进程内后台会拒绝这个请求（`stored-opening-unavailable`）。

实现依据：[会话 SDK](../../packages/sdk/src/session.ts)、[Core](../../packages/core/src)、[导入](../../packages/cli/src/commands/import.ts)、[导出](../../packages/cli/src/commands/export.ts)。
