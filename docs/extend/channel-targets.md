# Channel chats for plugin services

English | [简体中文](channel-targets.zh-CN.md)

[Author kit](README.md) · [Plugin-managed sessions](managed-sessions.md) · [Write an IM channel plugin](channel-plugins.md)

A profile-scoped, in-process managed service can receive the text its owner sends to a channel bot in a direct message, and send text or buttons back to that chat. The owner's clicks on those buttons come back to the service. The service never holds a platform client or credentials: the installed channel plugin keeps its connection, and the Host routes one paired chat to one service. The owner pairs the chat on the Channels page; until then the service receives nothing.

## Declare it

Set `channelTargets: true` on the managed service in `capabilities.managedServices`. Trust review shows the atom `channelTargets:profile:<id>`. The capability hash covers the flag, so adding it requires a new trust decision. Without the flag, every call on `init.channels` is refused with `CAPABILITY_DENIED`.

```json
{ "id": "desk", "scope": "profile", "artifact": { "kind": "in-process" }, "channelTargets": true, "...": "..." }
```

Channel plugins need no change: any installed channel provider can carry a pairing.

## Pair a chat

1. On the Channels page, open a bot connection's details and choose **Pair with a plugin service**, then pick the service.
2. Minting a pairing code requires a person's approval. The request waits beside the other approvals and is answered in the same place; then choose **Continue**. The code is shown once, as `XXXX-XXXX`, and is valid for one hour. Only a digest of it is kept, in memory.
3. Send the code to the bot in a direct message from the chat to pair. The bot confirms in that chat. The sender becomes the owner of the pairing.

A service has at most one pairing, and a chat is either bound to an AGH session or paired with a service, never both. A code-shaped message reaches the session path as usual when no code is waiting. Five wrong codes for one bot void its waiting codes. **Unpair** on the Channels page removes a pairing at once.

## Use it

`start(init)` receives `init.channels`, a [ManagedChannelTargets](../../packages/extension-api/src/channel-targets.ts) port.

```ts
init.channels.onEvent(async (event) => {
  // event.origin is always 'owner': only the paired sender's text and clicks arrive.
  if (event.kind === 'action') {
    // event.messageId is the id send returned; check event.actionId against the buttons that message offered.
    return
  }
  await init.channels.send(event.pairingId, {
    deliveryKey: `reply:${event.eventId}`,
    title: 'Noted',
    text: event.text,
    actions: [
      { id: 'done', label: 'Done', style: 'primary' },
      { id: 'later', label: 'Later' },
    ],
  })
})
init.channels.onPairingChange(async () => console.log(await init.channels.pairing()))
```

| Call | Does |
| --- | --- |
| `pairing()` | The service's pairing, or `undefined`: id, instance, provider, owner and chat ids, label, whether the bot is connected, and `textChars`, the most text one send's `text` may carry. |
| `onEvent(handler)` | Receives each owner event once: a `message`, with `quotedMessageId` when the channel reports the message it replies to or quotes, or an `action` for a click. A message that arrives while the service is not running is not kept: the bot tells the owner, at most once every ten minutes, to send it again later. A handler that throws is retried, three attempts in all. |
| `onPairingChange(handler)` | Runs after the pairing is created, revoked or removed. |
| `send(pairingId, { deliveryKey, text, title?, actions? })` | Sends one message to the paired chat and returns the platform message id. `deliveryKey` (1–256 characters) makes a retry safe: a key already delivered returns the same message id without sending again. Without `actions` it sends text, with `title` as a bold first line. With `actions` it sends a card; a channel without cards gets the same content as numbered text. |
| `delivery(pairingId, deliveryKey)` | `delivered` with the message id, `pending` while a send is running, or `unknown` when no confirmed outcome is recorded: the key was never sent, the send was not confirmed, or its record is older than seven days. `failed` is part of the type for a definite failure; the current bridge does not report it. |
| `unpair(pairingId)` | Ends the pairing. |

## Buttons

- `textChars` is the provider's text limit minus 395 characters the platform reserves for what it adds: the `title` line and, on a channel without cards, the button list. A `text` of exactly `textChars` therefore always fits.
- `actions` holds 1–6 buttons. Each `id` is 1–64 characters of `A-Z a-z 0-9 : _ -` and unique within the message. Each `label` is 1–40 characters without a line break. `style` is `primary`, `default` or `danger`. `title` is 1–100 characters without a line break.
- A click arrives as `{ kind: 'action', messageId, actionId, ... }` only when the paired owner clicked it in the paired chat, on a message this service sent within the last seven days. Other clicks are dropped and never reach an AGH session.
- The Host does not keep the button list. Check that `actionId` is one the clicked message offered, and treat a click like a message the owner typed: it grants nothing more.

## Refusals

A refused call rejects with the JSON-RPC error shape described in [Plugin-managed sessions](managed-sessions.md#refusals); `data.code` carries the reason:

- `NOT_PAIRED`: the pairing does not exist or belongs to another service.
- `CHANNEL_UNAVAILABLE`: the bot is not connected now, or a send with the same key is still running.
- `TOO_LARGE` (with `INVALID_PARAMS`): `text` exceeds `textChars`, the message the channel would receive exceeds the provider's text limit, or the composed card exceeds its card size limit on a channel that renders cards.
- `INVALID_PARAMS` without another code: `title` or `actions` break the limits under Buttons.
- `OUTCOME_UNKNOWN`: the platform did not confirm the send; read `delivery` before retrying with the same key.

## Lifecycle

- A pairing belongs to the package and plugin row that registered the service, and survives restarts and upgrades. Removing the package removes its pairings and delivery records; a package installed again under the same id starts unpaired.
- Changing the bot's credential references or platform account ends its pairings. Removing the channel plugin ends its pairings too.
- While the service is stopped or disabled, its pairing stays; messages sent meanwhile are not kept.
