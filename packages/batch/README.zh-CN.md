# 批处理业务服务

[English](README.md) | 简体中文

本包负责文件清单、逐项尝试、额度预留、输出校验和导出。目前处于运行时集成阶段，尚未安装为可运行插件。
运行时适配器必须提供绑定所有者的存储、不可变原件，以及由 Host 强制隔离的子会话和任务执行。
测试中的模拟执行器不得注册为生产权限提供方。

`createBatchPlugin(connector)` 通过公开插件 API 注册声明过的 `batch.*` 查询与效果服务。
连接器从 Host 接纳的调用上下文取得绑定后的 `BatchService`，请求数据不能选择所有者或工作区。
默认 `batchPlugin` 在接入运行时之前以 `E_BATCH_MANAGED_CONNECTOR_REQUIRED` 拒绝安装。

`BatchService` 在请求之外绑定工作区和所有者。运行时在启动及有未完成任务时驱动 `tick()`。
派发前持久化意图；响应丢失后使用原键查证和恢复。不确定结果保留额度并停止新派发，恢复操作不会重置该项或重放效果。
取消必须持久封锁任务键，包括尚未受理的键；得到包含取消费用的最终计费回执后才发布批次终态。
工具名称过滤和模型自述不能证明这些保障。

文件采集拒绝符号链接、特殊文件、路径越界和已观察到的文件或目录变化，保存不可变字节快照。
默认上限为十万文件、每件 20 MiB、总计 256 MiB、二十万目录项、32 层目录。
隐藏项和不支持的扩展名不参与处理；中断后的无引用原件由原件存储回收。
恶意并发替换目录及各平台文件保障仍须由文件系统适配器承担。

`attachmentSnapshots` 使用公开 `AttachmentStore`、`AttachmentScope` 合同，核验原件哈希、大小、
MIME 与精确作用域回执，采集失败时丢弃本次回执。输入记录保留原件引用及回执作用域，执行回执必须匹配
Host 预先绑定的会话和 lane。只有 Core 提交子会话 inbox 输入后才能确认附件；保存批次清单不构成确认。
接入大批量或长任务前，运行时必须处理待确认原件的配额、到期和所有者存储配额，本包不会放宽提供方限额。

并发尝试先从剩余额度预留硬上限。修复重新预留额度，沿用同一子会话、原件和原始截止时间。
费用取自后台回执；每项输出最多 32 KiB，最多修复两次，连续失败达到阈值后停止派发。
输出 Schema 只接受有界的对象、属性、必填、附加属性、数组元素、标量类型、数值范围、字符串和数组长度、
标量枚举与常量，以及说明字段。拒绝正则、引用、异步、`uniqueItems: true` 和组合关键词，不加载外部资源。

导出包含 JSONL 结果与错误、CSV 和摘要。CSV 引用单元格并封锁公式；人工可读文本去除终端控制字符。
模型内容只保留为数据，不拼接到 Markdown 摘要。独占创建目录，拒绝已有目标和竞争导出；
最后写入 `complete.json`。没有完成标记的目录视为中断，不自动覆盖；默认导出总上限为 64 MiB。

CLI 模块只校验选项、读取有界提示词和 Schema 文件并调用后台；枚举、执行和导出由后台负责。
既有 `agh run --batch` 流程保持独立。

`startManagedBatch(runtime, ports)` 已消费真实受管理服务初始化、生命周期和事务型
`ManagedOwnedStore` 接口；单例由通用 supervisor 持有，批插件不另建单例或监听端口。驱动先遍历
manifest 再修改状态，避免写入使分页 cursor 失效。disable/upgrade 先关闭接纳再取消；
截止时间内无法获得结算回执时返回 unknown 并保留预算预留。进程退出保留耐久状态用于恢复。
原生受限 child/job 派发、工作区与附件 scope 仍须由可信运行时注入。

输入枚举保留 `agh-batch` 作为结果目录，不再将其中的旧导出作为输入。schema 支持
`uniqueItems: false`，不执行两两比较；true 仍拒绝。

服务已接入真实 profile query/effect：start、resume、export 由原生 AR1 审批接纳，cancel
走 urgent lane，不获得新的执行权限。prepare 的规范输入绑定进 subject digest，handler 验证
原生 admission 与对应输入。query 无需创建会话。profile 的小容量 store 不替代受管理服务 store。

`agh batch` 入口通过 Node SDK 的 scoped service 调用。待批准或 running 回执返回退出码 3，
unknown/refused 返回 1；CLI 不自行批准、不重放 unknown。批准后，使用输出的 batch id 加
`--id` 重复同一 start；显式指定了 `--operation` 时也沿用原值。原生受限 child/job 连接器
尚未安装时，入口明确拒绝服务调用。
