# 会话与恢复：让工作接续起来

[English](sessions.md) | 简体中文

[文档导航](../README.zh-CN.md) · [安全边界](security.zh-CN.md)

工作可以跨越多次打开终端或浏览器的过程。用明确的会话 ID 找回上下文、查看执行记录，并决定接着做什么。

会话承载任务历史、模型选择和执行状态；一次用户请求会形成一轮运行。CLI、Web 和 SDK 读取相同后台的事实，但界面的历史投影不是原始数据库备份。

## 日志尾部损坏

打开 JSON 或校验和损坏的 SQLite 日志尾部时，会保留已验证前缀，先将受损原始行及寄存器持久隔离到私有 `sessions.db.tail-<diagnosticId>.json` 文件，再记录恢复诊断。JSONL 示例将精确损坏字节保存在 `store.jsonl.tail-<diagnosticId>.bin`。Web 显示含诊断 ID 的本地化通知。调查存储故障时请保留隔离文件；它不会作为普通模型上下文发送。

在途副作用按未知结果关闭，不会重放，包括通常可安全重放的工具。再次请求操作前，先核对外部实际结果。损坏后仍有有效事件/事务、完整性链缺行，或受损前缀被 fork 引用时，拒绝自动截断。未知未来格式版本明确拒绝；此恢复不升级或迁移格式。

## 找到并继续会话

```sh
node agnes.mjs sessions --json
node agnes.mjs sessions show SESSION_ID
node agnes.mjs resume SESSION_ID -p "继续说明尚未完成的部分"
node agnes.mjs -p --resume SESSION_ID "接着上次的讨论"
node agnes.mjs -p --continue "继续"
```

`--continue` 与 `--resume` 互斥。需要精确控制时使用明确 ID，避免恢复到不期望的最近会话。新建会话和恢复会话的工作目录、模型、权限需要分别核对；切换 Web 工作区不会把已有会话的所有权转移给另一个后台。

## 搜索历史

设置中的「历史」可以搜索会话标题和消息文本，按工作区路径精确过滤，并分页查看结果。索引是根据账本重建的独立 SQLite 文件，不会修改账本。只读工具 `session_search`、`session_event_search`、`session_trace`、`session_event_trace` 和 `session_event_read` 只查看调用者所在工作区及其已记录的所有者。

## 导出与导入

```sh
node agnes.mjs export SESSION_ID --format agnes -o session.jsonl
node agnes.mjs export SESSION_ID --format sharegpt -o training.json
node agnes.mjs export SESSION_ID --html -o session.html
node agnes.mjs import session.jsonl --from auto --key agnes:local:default:import:dm:docs-copy
```

上例原生导入使用一个新的 session key；重复演练时换一个未使用的 key。省略 key 可能指回原会话，遇到已打开或非空目标会拒绝。import 是 one-shot 路径，不支持 `--connect`。导入的会话会在首条事件（`session/start` 的 `imported` 字段）记录来源格式，原生导入还会记录原会话 key；从 Web 导出它的诊断包时会带一条 `imported` 警告。

导出文件可能包含提示、工具参数、路径和业务数据，分享前审查。`--raw` 会减少隐私过滤，不是默认共享方式。外部格式（Claude Code/Codex/Pi）导入是格式转换，不能恢复原工具权限、原进程或保证所有语义无损。导入失败要保留错误并检查会话列表，不通过重试换 ID 来掩盖失败。

## 中断与重启

停止请求、进程退出、审批到期和一轮完成是不同事实。Core 通过持久事件与状态机恢复；副作用未知时可能需要人工确认，不能保证外部系统操作“恰好一次”，也不能用重新发相同自然语言来代替恢复。

后台故障后：先保留 home 和错误，查看 `daemon status`，用同一 profile 启动后检查历史，再决定继续。不要删除 SQLite、owner 或审计记录强行重开。数据库的备份应在停止对应实例后保存同一 home 中相互关联的数据；单独复制正在写入的数据库文件不构成可靠备份。

TUI `/rewind SEQ` 和 Web 分叉从某个历史位置创建新会话，不撤销已经写入的文件、不撤回网络请求、不让已执行工具失效。恢复也按当前权限重新约束执行，而不是复活过去的授权。

实现依据：[会话 SDK](../../packages/sdk/src/session.ts)、[Core](../../packages/core/src)、[导入](../../packages/cli/src/commands/import.ts)、[导出](../../packages/cli/src/commands/export.ts)。

<a id="persistent-goals"></a>

## 持久目标

官方默认目标插件将会话目标保存在账本中。打开 Web 对话上方的目标栏，可创建/编辑目标，设置自动续轮上限和可选额度预算，暂停/恢复、完成或清除。CLI 使用同一会话输入：

```text
/goal create --max-rounds 10 --budget 20 交付并验证补丁
/goal edit --max-rounds 5 交付较小的补丁
/goal edit --budget none 移除目标积分上限
/goal pause
/goal resume
/goal complete
/goal clear
```

/goal 后接目标内容也可创建目标，CLI 中 /goal 显示当前状态。选项写在目标内容之前。默认允许十次自动续轮，不额外限制额度。恢复会重新授权续轮次数并保留已用额度；编辑保留阶段与额度。模型只能通过 goal_update 提交带原因的完成或受阻状态，不能提高上限或自行恢复。

自动续轮进入下一回合输入队列；人工控制优先，过期续轮在推理前停止。完成、受阻、取消、错误或耗尽上限都会停止续轮。额度在步骤与回合边界检查，因此正在执行的响应可能超过目标预算，模型的常规预算准入仍生效。设置目标预算但额度用量未知时，续轮会受阻。恢复进程或派生分支后，原本活跃的目标暂停，等待明确恢复。

## 控制正在运行的任务

Agent 工作时发送消息，默认排队为指引，在当前模型调用或工具批次结束后的步骤边界送达。送达前可在输入框上方编辑或撤回。排队消息旁的**立即打断**会合作停止当前步骤，再优先执行该消息；已提交的效果保持已提交，未知结果仍如实显示为未知。

**暂停**在下一个步骤边界生效，**继续**恢复同一轮。浏览器刷新和 daemon 冷启动都会保留暂停。**取消**结束当前轮，并将待送达的指引退回输入框。Trace 的**人工控制记录**显示操作者、时间、请求和结果。控制始终作用于会话固定的 Loop 版本，包括热升级期间；不支持的控件显示禁用原因。

SDK：`session.controls()` 读取能力与状态；`steer(content)`、`editQueued(itemId, content)`、`removeQueued(itemId)`、`interrupt(itemId)`、`pause()`、`resume()` 和 `cancel()` 都走持久命令路径。Loop 通过 `LoopFactory.controls` 声明支持能力，省略即拒绝指引、打断和暂停。
