# Channel chats for plugin services

English | [简体中文](channel-targets.zh-CN.md)

[Author kit](README.md) · [Plugin-managed sessions](managed-sessions.md) · [Write an IM channel plugin](channel-plugins.md)

A profile-scoped, in-process managed service can receive the text its owner sends to a channel bot in a direct message, and send text back to that chat. The service never holds a platform client or credentials: the installed channel plugin keeps its connection, and the Host routes one paired chat to one service. The owner pairs the chat on the Channels page; until then the service receives nothing.

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
  // event.origin is always 'owner': only the paired sender's direct-message text arrives.
  await init.channels.send(event.pairingId, { deliveryKey: `reply:${event.eventId}`, text: `Noted: ${event.text}` })
})
init.channels.onPairingChange(async () => console.log(await init.channels.pairing()))
```

| Call | Does |
| --- | --- |
| `pairing()` | The service's pairing, or `undefined`: id, instance, provider, owner and chat ids, label, whether the bot is connected, and the provider's text limit. |
| `onEvent(handler)` | Receives each owner message once. A message that arrives while the service is not running is not kept: the bot tells the owner, at most once every ten minutes, to send it again later. A handler that throws is retried, three attempts in all. |
| `onPairingChange(handler)` | Runs after the pairing is created, revoked or removed. |
| `send(pairingId, { deliveryKey, text })` | Sends one text message to the paired chat and returns the platform message id. `deliveryKey` (1–256 characters) makes a retry safe: a key already delivered returns the same message id without sending again. |
| `delivery(pairingId, deliveryKey)` | `delivered` with the message id, `pending` while a send is running, or `unknown` when no confirmed outcome is recorded: the key was never sent, the send was not confirmed, or its record is older than seven days. `failed` is part of the type for a definite failure; the current bridge does not report it. |
| `unpair(pairingId)` | Ends the pairing. |

## Refusals

A refused call rejects with the JSON-RPC error shape described in [Plugin-managed sessions](managed-sessions.md#refusals); `data.code` carries the reason:

- `NOT_PAIRED`: the pairing does not exist or belongs to another service.
- `CHANNEL_UNAVAILABLE`: the bot is not connected now, or a send with the same key is still running.
- `TOO_LARGE` (with `INVALID_PARAMS`): the text exceeds the provider's text limit.
- `OUTCOME_UNKNOWN`: the platform did not confirm the send; read `delivery` before retrying with the same key.

## Lifecycle

- A pairing belongs to the package and plugin row that registered the service, and survives restarts and upgrades. Removing the package removes its pairings and delivery records; a package installed again under the same id starts unpaired.
- Changing the bot's credential references or platform account ends its pairings. Removing the channel plugin ends its pairings too.
- While the service is stopped or disabled, its pairing stays; messages sent meanwhile are not kept.
