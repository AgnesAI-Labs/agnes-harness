# 文件批处理

[English](README.md) | 简体中文

`@agnes/batch` 负责输入快照、持久进度、结果校验和导出。已安装的 `batchPlugin` 使用当前
profile 的托管单例与公开 Node SDK。每项任务创建普通可见会话，标题为
`batch <id> · <file>`；会话工作区仅放该项输入文件的副本。现有工作区沙箱和文件策略负责
隔离，后台会话拒绝权限请求。Core、Host、协议中没有新增批处理业务或授权。

启用 `ext:agnes.batch`，通过原生审批配置 `batchWorker.configure`：`workspaceRoot` 为输入
工作区，`ownedArea` 为该安装/profile 专用数据目录，`socketPath` 为当前 profile 的本地
SDK 地址。路径必须是绝对规范路径，数据目录与输入工作区不得互相包含。Windows 还需
提供已验证的 `serverIdentity`（`pid`、`processStartId`）。配置不包含凭据。标准托管服务
提供 `.status`、`.configuration`、`.retry`、`.check`，不会另起守护进程或监听器。

```sh
agh batch start inputs --prompt '总结 {{path}}，序号 {{ordinal}}' --schema result.schema.json
agh batch start inputs --prompt-file template.txt --budget 5 --concurrency 4 --max-edge 1024 --out reports
agh batch status b123456abcdef --watch
agh batch results b123456abcdef --json
agh batch resume b123456abcdef
agh batch cancel b123456abcdef
agh batch export b123456abcdef --out final-copy
```

启动、恢复、导出经过 profile 原生 AR1 审批；取消走独立紧急队列且不授予新执行权限。
待审批/执行中返回退出码 3。审批后使用打印的 `--id` 重复完全相同的启动命令；如显式传入
`--operation`，也须保持不变。未知操作不会重发。`--cwd` 必须匹配配置的输入工作区。
`agh run --batch` 仍是独立的无界面运行方式。

默认并发 4、单项超时 600 秒（范围 60–3600）、图片边长 1456（256–1456）、结构错误修复
一次，连续失败五项后停止。预算可选；默认导出到 `agh-batch/<id>`。`--ext` 支持逗号分隔、
前导点、大小写和空格归一化。模板支持 `{{name}}`（文件名）、`{{path}}`（单项副本路径）和
`{{ordinal}}`。图片读取指令将 `max_edge` 传给现有 B3 `read` 工具，由它负责有界解码与等比例缩图；工作区
中的原始副本保持不变。

进度保存在专属 SQLite 中，使用真实 SDK 事务 owned store。在创建会话或提交提示词之前
先持久化操作栅栏。每项操作保留有界修复尝试记录；修复复用原会话及截止时间。重新打开
存储后，缺少持久终态的在途操作标记为 `unknown`，包括尚未取得回复的 outbox 意图，绝不
自动重发。恢复只核对已有进度并继续安全的待办；不会重置未知项。未知项阻止继续派发，
保留预算占用。禁用/升级先关闭入口再取消会话；进程退出保留进度。结果或计费读取失败
保持未知，不会假定成功或免费。

费用来自公开会话 usage projection。SDK 将每次预留额度绑定到普通会话轮次，Core 在
provider 派发前持久预留请求费用上界；缺少价格上界或预算存储时拒绝执行。修复共享该项
剩余额度和原始截止时间，未知工作保留预留。旧服务端不支持硬预算时拒绝 prompt；有界
轮次跳过自动标题生成。已有 profile 和会话策略照常生效，省略预算时使用最大安全数值
作为记账边界。费用上界以 provider 遵守目录价格和输出 token 上限为前提；缺失或不一致
的账单保持未知，不释放额度。

枚举拒绝符号链接、非普通文件、越界路径和观察到的变更。隐藏项和保留目录 `agh-batch`
不参与。未知类型保留为 `skipped/unsupported_type`；文本超过 1 MiB、PNG/JPEG 超过
20 MiB 保留为 `skipped/too_large`。上限为十万文件、二十万目录项、32 层目录、256 MiB
快照总量。默认使用专属文件，不占 B3 pending receipt 配额；显式传入真实 B3 scope 的
调用方仍可使用独立的 `attachmentSnapshots` 适配器。

单项结果上限 32 KiB，导出上限 64 MiB。JSON Schema 支持有界对象、属性、必填、额外属性、
数组、标量类型、标量 enum/const、数值及长度范围和注释；引用、正则、复杂组合以及
`uniqueItems: true` 会明确拒绝，schema 不会加载外部资源。

导出包含 `results.jsonl`、`errors.jsonl`、`results.csv`、`summary.md`、批次归属标记及
`progress.json`。后台增量输出已完成/跳过行，待办和运行中行暂不写入数据文件。每个文件
原子替换，摘要标记最后写入，可识别中断的发布。重启仅复用同批次认领的目录；拒绝覆盖
无关输出、隐藏路径或与输入树重叠的自定义输出。显式 export 只接受已结算终态，独占新
目录并最后写 `complete.json`。CSV 转义并防公式注入，摘要不插入模型生成内容。
