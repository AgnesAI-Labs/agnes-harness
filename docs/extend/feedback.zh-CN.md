# 反馈服务

[English](feedback.md) | 简体中文

反馈是 daemon 安装的、workspace 作用域、按请求建实例、每个 profile 单选的提供者（`agh.feedback`）。`@agnes/host` 导出 `feedbackKind`、`FEEDBACK_DESCRIPTOR`、`createFeedbackOwner`、`createFeedbackService` 与 `FeedbackAuthority`。线路 DTO `FeedbackRequest`、`FeedbackResult`、`FeedbackItem`、`FeedbackTarget`、`FeedbackGrowth` 来自 `@agnes/protocol` 与 `@agnes/protocol/gen/app-server`。保留事实仍是 `x/feedback/item` 与 `x/feedback/growth`。

```ts
interface FeedbackInstance {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}
```

daemon 通过共享服务绑定准入每一次请求。安装授权只有账本端口：反馈不向智能体投递，候选证据留在包管理端口。每个请求围绕该请求的 authority 打开一个新实例。没有组合根工厂覆盖。

反馈服务代码或该提供者的更换是 restart-required。daemon 在受控进程重启时应用，不用中断在途反馈操作来换代码。提交反馈、生成 Skill 候选，以及明确支持热更新的配置，都不需要重启。重启与已有反馈记录兼容，并保留幂等的候选恢复。重启不能修复不兼容的数据格式。

平台负责本地管理身份、会话归属、写入 actor 的解析、会话命令串行化，以及持久账本与候选端口。服务保留反馈不外发、取消、版本检查及人工评审语义。不能从请求字段推断授权，也不能应用草稿。普通后端扩展仍属于进程内受信任代码。

生成的 App Server 方法 `_agnes/v1/admin.feedback` 接受 `action: 'list' | 'put' | 'withdraw' | 'generate'`。写操作必须给出 `sessionId` 和 `expectedRevision`：初次创建为 null，其他操作为已读取条目的账本序号。`put` 接受 `rating`，以及新建用的 `target` 或已有 `id`；`category`、`note` 可选。消息目标是已结束主 lane 助手消息的 `{messageSeq, turn}`；会话目标两项均为 null。已有目标不能改换。撤回和生成引用已有条目。浏览器通过同源 `POST /api/feedback` 的本地管理桥接访问。

`list` 可按 `sessionId`、`category`、`rating`、`hasCandidate` 筛选，返回当前反馈、成长来源、统计和 `truncated`。`revision` 是账本序号。条目的 `candidateHash` 保留生成时的候选哈希；成长记录从候选所属模块取得当前候选哈希、经核验的评审和发布状态。候选证据不可用时不能显示为批准。原始反馈修订及生成哈希在编辑后仍保留于账本。

可忽略事件 `x/feedback/item`、`x/feedback/growth` 的 envelope 包含平台写入的 actor 与时间。反馈保留作者、目标、创建/修改时间和撤回标记。成长关联保留 `feedbackId`、`feedbackRevision`、`messageSeq`、`candidateId`、`candidateHash`。`AuthoringOrigin` 新增可选 `feedbackId`、`feedbackRevision`、`messageSeq`；已有 review digest 包含 origin，将来源与评审快照绑定。发布仍需确切候选测试哈希与 reviewHash。

协议明确保留这两个平台事件名，拒绝其他 `x/feedback/*` 名称；插件自己的事件继续使用已公开的扩展命名空间。

append 端口对所有调用方只接受这两个固定事件名。写入绑定已准入的会话，每次 append 重新检查本地写权限、会话归属和 fitted actor，并写入认证 actor。新反馈 ID 必须来自 `id()`；修订只能重用该 actor 在同一会话中的已有条目。成长链接必须绑定已有条目 revision 与其消息。调用方自选 ID、封套 ID 字段、其他事件类型或 actor 均以 `CAPABILITY_DENIED` 拒绝；封套事件 ID 始终由 Host 生成。只读请求不提供写权限。

参见[用户流程](../guide/feedback.zh-CN.md)与[候选评审](agent-built-plugins.zh-CN.md)。默认生成新 Skill；记忆仍走已有的显式差异审批流程。

增长重试先按服务端绑定的 profile/principal/session/反馈 revision command key 恢复 candidate，再决定是否生成草稿。candidate 已保存但账本链接失败时，即使重连也补写同一份完整性校验后的 candidate 链接，不重新生成草稿。`FeedbackAuthority.recoverCandidate` 在推理之前执行。

Tool-policy provider 可实现 `ToolPolicy.settings(context, signal)`，选择策略并解释 provider 自己管理的 JSON 设置。Host 传递部署上下文并转发选择，不辨认官方策略 ID。官方 approval provider 通过 `@agnes/base/approval-policy` 管理 `AutoReviewSettingsStore`。
