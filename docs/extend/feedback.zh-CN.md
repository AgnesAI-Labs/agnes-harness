# 反馈服务

[English](feedback.md) | 简体中文

`@agnes/extension-api` 导出 `FeedbackService`、`FeedbackServiceFactory`、`FeedbackPorts`、`FeedbackRequest`、`FeedbackResult`、`FeedbackItem`、`FeedbackTarget`、`FeedbackGrowth`、`FEEDBACK_EVENT` 与 `FEEDBACK_GROWTH_EVENT`。官方默认实现为 `createFeedbackService(ports)`。嵌入式 daemon 可通过 `startSupervisor` 的 `feedbackServiceFactory` 替换服务；这是组合根的服务工厂，并非普通运行时 provider row。

```ts
interface FeedbackService {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}
type FeedbackServiceFactory = (ports: FeedbackPorts) => FeedbackService
```

平台负责本地管理身份、会话归属、写入 actor 的解析、会话命令串行化，以及持久账本与候选端口。替换服务须使用这些端口，保留反馈不外发、取消、版本检查及人工评审语义。不能从请求字段推断授权，也不能应用草稿。普通后端扩展仍属于进程内受信任代码。

生成的 App Server 方法 `_agnes/v1/admin.feedback` 接受 `action: 'list' | 'put' | 'withdraw' | 'generate'`。写操作必须给出 `sessionId` 和 `expectedRevision`：初次创建为 null，其他操作为已读取条目的账本序号。`put` 接受 `rating`，以及新建用的 `target` 或已有 `id`；`category`、`note` 可选。消息目标是已结束主 lane 助手消息的 `{messageSeq, turn}`；会话目标两项均为 null。已有目标不能改换。撤回和生成引用已有条目。浏览器通过同源 `POST /api/feedback` 的本地管理桥接访问。

`list` 可按 `sessionId`、`category`、`rating`、`hasCandidate` 筛选，返回当前反馈、成长来源、统计和 `truncated`。`revision` 是账本序号。条目的 `candidateHash` 保留生成时的候选哈希；成长记录从候选所属模块取得当前候选哈希、经核验的评审和发布状态。候选证据不可用时不能显示为批准。原始反馈修订及生成哈希在编辑后仍保留于账本。

可忽略事件 `x/feedback/item`、`x/feedback/growth` 的 envelope 包含平台写入的 actor 与时间。反馈保留作者、目标、创建/修改时间和撤回标记。成长关联保留 `feedbackId`、`feedbackRevision`、`messageSeq`、`candidateId`、`candidateHash`。`AuthoringOrigin` 新增可选 `feedbackId`、`feedbackRevision`、`messageSeq`；已有 review digest 包含 origin，将来源与评审快照绑定。发布仍需确切候选测试哈希与 reviewHash。

协议明确保留这两个平台事件名，拒绝其他 `x/feedback/*` 名称；插件自己的事件继续使用已公开的扩展命名空间。

参见[用户流程](../guide/feedback.zh-CN.md)与[候选评审](agent-built-plugins.zh-CN.md)。默认生成新 Skill；记忆仍走已有的显式差异审批流程。

增长重试先按服务端绑定的 profile/principal/session/反馈 revision command key 恢复 candidate，再决定是否生成草稿。candidate 已保存但账本链接失败时，即使重连也补写同一份完整性校验后的 candidate 链接，不重新生成草稿。实现该流程的 provider 必须提供 `FeedbackPorts.recoverCandidate`。

Tool-policy provider 可实现 `ToolPolicy.settings(context, signal)`，选择策略并解释 provider 自己管理的 JSON 设置。Host 传递部署上下文并转发选择，不辨认官方策略 ID。官方 approval provider 通过 `@agnes/base/approval-policy` 管理 `AutoReviewSettingsStore`。
