# 让插件服务接收渠道私聊

[English](channel-targets.md) | 简体中文

[插件作者工具包](README.zh-CN.md) · [插件托管会话](managed-sessions.zh-CN.md) · [编写 IM 渠道插件](channel-plugins.zh-CN.md)

作用域为 profile 的进程内托管服务，可以接收主人在私聊里发给渠道机器人的文字，并向这个私聊发回文字或按钮；主人点击这些按钮，点击会送回服务。服务本身不持有平台客户端或凭据：连接由已安装的渠道插件维持，Host 把一个已配对的私聊交给一个服务。主人在渠道页完成配对之前，服务收不到任何消息。

## 声明

在 `capabilities.managedServices` 里给托管服务加上 `channelTargets: true`。信任审核会显示能力项 `channelTargets:profile:<id>`。能力哈希覆盖这个标记，新增它需要重新信任。没有这个标记时，`init.channels` 上的每个调用都以 `CAPABILITY_DENIED` 拒绝。

```json
{ "id": "desk", "scope": "profile", "artifact": { "kind": "in-process" }, "channelTargets": true, "...": "..." }
```

渠道插件无需改动：任何已安装的渠道都能承载配对。

## 配对私聊

1. 在渠道页展开某个机器人连接的详情，选择“配对到插件服务”，再选目标服务。
2. 生成配对码需要人工审批。审批请求和其他审批放在一起，在同一处处理；批准后点“继续生成”。配对码形如 `XXXX-XXXX`，只显示一次，一小时内有效。系统只在内存里保存它的摘要。
3. 在要配对的私聊里把配对码发给机器人。机器人会在这个私聊里确认，发送者成为配对的主人。

一个服务最多一个配对；一个私聊要么绑定到 AGH 会话，要么配对给服务，不能同时两样。没有等待中的配对码时，形似配对码的消息照常走会话路径。同一个机器人连续收到五次错误的配对码，它等待中的配对码全部作废。在渠道页点“解除配对”会立即删除配对。

## 使用

`start(init)` 收到 `init.channels`，即 [ManagedChannelTargets](../../packages/extension-api/src/channel-targets.ts) 接口。

```ts
init.channels.onEvent(async (event) => {
  // event.origin 总是 'owner'：只有已配对发送者的文字和点击会送达。
  if (event.kind === 'action') {
    // event.messageId 是 send 返回的编号；核对 event.actionId 是否是那条消息给出的按钮。
    return
  }
  await init.channels.send(event.pairingId, {
    deliveryKey: `reply:${event.eventId}`,
    title: '已记下',
    text: event.text,
    actions: [
      { id: 'done', label: '完成', style: 'primary' },
      { id: 'later', label: '稍后' },
    ],
  })
})
init.channels.onPairingChange(async () => console.log(await init.channels.pairing()))
```

| 调用 | 作用 |
| --- | --- |
| `pairing()` | 返回本服务的配对或 `undefined`：配对 id、实例、渠道、主人与私聊 id、标签、机器人是否在线，以及 `textChars`，即一次发送的 `text` 最多可带的字符数。 |
| `onEvent(handler)` | 每个主人事件收到一次：`message`（渠道报告了它回复或引用的消息时带 `quotedMessageId`），或点击产生的 `action`。服务未运行时到达的消息不会保留：机器人会提醒主人稍后重发，十分钟内最多一次。处理函数抛错会重试，共三次。 |
| `onPairingChange(handler)` | 配对建立、撤销或删除后调用。 |
| `send(pairingId, { deliveryKey, text, title?, actions? })` | 向已配对私聊发一条消息，返回平台消息 id。`deliveryKey`（1–256 个字符）让重试安全：已送达的键直接返回同一个消息 id，不会重发。不带 `actions` 时发文字，`title` 作为加粗首行；带 `actions` 时发卡片，不支持卡片的渠道收到同样内容的编号文字。 |
| `delivery(pairingId, deliveryKey)` | 返回 `delivered`（带消息 id）、发送进行中时的 `pending`，或没有确认结果时的 `unknown`：这个键从未发送、发送未获确认，或记录已超过七天。`failed` 是类型里为明确失败保留的状态，当前渠道桥不会返回。 |
| `unpair(pairingId)` | 解除配对。 |

## 按钮

- `textChars` 是渠道文字上限减去平台预留的 395 个字符，用来容纳平台自己加的内容：`title` 行，以及不支持卡片的渠道上的按钮列表。因此长度恰为 `textChars` 的 `text` 总能发出。
- `actions` 含 1–6 个按钮。每个 `id` 为 1–64 个 `A-Z a-z 0-9 : _ -` 字符，同一条消息内不重复；每个 `label` 为 1–40 个字符、不含换行；`style` 为 `primary`、`default` 或 `danger`。`title` 为 1–100 个字符、不含换行。
- 只有配对主人在已配对私聊里点击本服务七天内发出的消息，点击才以 `{ kind: 'action', messageId, actionId, ... }` 送达；其他点击被丢弃，也不会进入 AGH 会话。
- Host 不记录按钮列表。请核对 `actionId` 是被点消息给出的按钮之一；点击等同主人打字，不授予更多权限。

## 拒绝

被拒绝的调用以[插件托管会话](managed-sessions.zh-CN.md#拒绝)里描述的 JSON-RPC 错误形状 reject，`data.code` 说明原因：

- `NOT_PAIRED`：配对不存在，或属于另一个服务。
- `CHANNEL_UNAVAILABLE`：机器人当前未连接，或同一个键的发送还在进行。
- `TOO_LARGE`（错误为 `INVALID_PARAMS`）：`text` 超过 `textChars`，渠道实际收到的消息超过渠道文字上限，或在支持卡片的渠道上组好的卡片超过卡片大小上限。
- 不带其他代码的 `INVALID_PARAMS`：`title` 或 `actions` 超出“按钮”一节的限制。
- `OUTCOME_UNKNOWN`：平台没有确认这次发送；用同一个键重试之前先读 `delivery`。

## 生命周期

- 配对属于注册该服务的插件包和插件行，跨重启和升级保留。删除插件包会删除它的配对和送达记录；之后以同一 id 重新安装的包从未配对状态开始。
- 修改机器人的凭据引用或平台账号会结束它的配对。删除渠道插件也会结束它的配对。
- 服务停止或停用期间配对保留，但期间发来的消息不会保留。
