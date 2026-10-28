# Use TypeSafe Jev for side model calls

English | [简体中文](typesafe-jev.zh-CN.md)

[Documentation](../README.md) · [Generic credentials](credentials.md) · [Use a local model](local-model.md) · [Network deployment](deployment.md) · [Write a plugin](../develop/plugins.md)

`@agnes/ai` includes a model adapter for TypeSafe Jev, registered as `typesafe-systemone`. It answers one structured request at a time: a JSON `state` and a set of `questions`, to which the vendor returns an answer for each question. A loop plugin uses it for quick decisions that should not go through the conversation model.

Jev is **not a chat model**. The adapter takes a payload and nothing else: no messages, no system prompt, no tools and no streaming. It declares the capabilities `payload: true` and `payloadOnly: true`, so a model served by it never appears in a model picker, cannot be chosen as a session, default, fast, verifier or child-agent model, and is refused if a client asks for it by name. A loop plugin reaches it through a side model call.

## Settings page

In Settings → Models & accounts, expand **Advanced: side models and task models**, then add an entry under **Side models**. The same page also offers a **Voice** adapter for dictation and read-aloud in the conversation; it is covered in [Talk to the agent](voice.md). For a Jev entry:

1. The adapter is fixed to `typesafe-systemone`.
2. The endpoint defaults to `https://openrouter.ai/api/v1` and can point at `https://api.typesafe.ai/v1` directly. The rules are the adapter's: no templates, no inline credentials, no query or fragment, and plain `http` only on loopback addresses.
3. Pick a [generic credential](credentials.md), or create one in place; the entry stores its `secret://generic/<UUID>` reference, never the key.
4. Each model needs only `id`, `name`, `contextWindow`, `maxTokens` and an optional `cost`; the remaining fields are fixed by the adapter's template (`reasoning: false`, `input: [text]`, `toolCallFormats: []`, `thinkingReplay: drop`, `contract_id: null`).
5. The test button sends one fixed minimal payload `{state: {}, questions: {ping: 'ping'}}`: a success or a rate limit both count as reachable, and a rejected credential is called out. What the probe sends is provisional, and you can skip the test and save.
6. Saving takes effect for new sessions; an entry can be enabled, disabled or removed. A side model can never become the default account, and it never appears in the fast or verifier slots.

The page names the route it creates `account-<id>`, and the entry's summary line shows that name; a loop plugin targets it by that name. A route declared in the user profile (the next section) is used only while Settings manages no account: once a page entry or any other account is saved, the settings service supplies the whole `provider` block and the profile's routes are no longer used. When moving from a profile route to the page, save the page entry, point the loop at its route name, then remove the profile route. The workspace file `.agh/profile.local.yaml` cannot declare a route: in this version it accepts only `extensionIsolation`, and any other key stops the runtime from starting with `E_DEP_MISSING`.

## Profile route

Add a route to the provider configuration of the user profile, `AGH_HOME/profiles/<profile>/profile.yaml`. Use this in a home where Settings manages no account, such as a headless or scripted setup; otherwise use the settings page. The adapter ships with `@agnes/ai`, so there is nothing to install or trust. If the profile lists model adapters explicitly under `providers.model-adapter`, include `typesafe-systemone` (or `@agnes/ai`) in that list.

```yaml
provider:
  package: "@agnes/ai"
  routes:
    - route: jev
      api: typesafe-systemone
      baseUrl: https://openrouter.ai/api/v1
      credentialRef: secret://openrouter/jev
      models:
        - id: typesafe/jev-1.13-20260917
          name: Jev 1.13 (2026-09-17)
          api: typesafe-systemone
          route: jev
          baseUrl: https://openrouter.ai/api/v1
          reasoning: false
          input: [text]
          cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }
          contextWindow: 65536
          maxTokens: 32768
          toolCallFormats: []
          thinkingReplay: drop
          contract_id: null
```

- `api` selects the adapter, and every model on the route repeats it. `contract_id` must be `null`: Jev has no system prompt to carry a contract.
- The adapter posts to `<baseUrl>/systemone` with the key as a bearer token. Plain `http` is accepted for loopback addresses only, so the key is never sent unencrypted to another machine.
- `credentialRef` names a secret, not the key. Save the key as a [generic credential](credentials.md) and use the `secret://generic/<UUID>` reference it returns, or place it in the profile's secret store. The reference is resolved when the runtime is assembled; a reference that cannot be resolved stops the route from starting. Never write a key into the profile.
- The model id is sent exactly as written. Pin a dated version such as `typesafe/jev-1.13-20260917`; an alias such as `~typesafe/jev-latest` can change what answers without any change on your side. The reply reports the exact model that answered, and the side-call record keeps it.
- `cost` is in US dollars per million tokens. When the vendor reports the price of a call, AGH records that price; otherwise it estimates from `cost`. Check the vendor's current price before copying the numbers above.
- Do not name a Jev model in a preset slot. A slot is a conversation model. A slot that a preset leaves at `default` takes the first declared route that no payload-only adapter serves, so `default` never picks a Jev route and the route may be declared first. If a profile declares only payload-only routes, `default` stays on the first of them and every conversation fails at the adapter.

To call TypeSafe directly instead of through OpenRouter, change the route's and the models' `baseUrl` to `https://api.typesafe.ai/v1`, point `credentialRef` at the direct key, and use the vendor's model id, for example `jev-1.13.0`. The direct endpoint follows the vendor's documentation and has not been exercised against a live key.

## Not a chat model

- The Web model picker, the CLI `/model` list and the list returned by `apis.list` leave Jev models out, so a new session cannot start on one by default.
- Admin defaults for new sessions and the fast and verifier slots do not offer them, and scheduled tasks cannot target them.
- Child agents cannot choose them: `list_subagent_models` leaves them out, and starting a child on one is refused as an unknown model (`E_MODEL_UNKNOWN`). Side model calls are not affected, so a loop plugin can still target the route.
- The server refuses the same choices when a client sends them directly: switching a session to a Jev model is refused with `PRESET_SWITCH_REJECTED`, and saving one as a default or slot fails with `CONFIG_MODEL_UNAVAILABLE`.
- If a request still reaches the adapter with messages, tools or a system prompt, it is refused with `CONTRACT_MISMATCH` before any network call.
- The Web settings still list the adapter, marked **Payload requests only, no chat**; its technical details show the `payload` and `payloadOnly` capabilities.

A community adapter that answers both messages and payloads declares only `payload: true`; its models stay selectable. The model adapter plugin template explains the `payload` and `payloadOnly` capability fields.

## Call it from a loop plugin

A loop that receives `ctx.sideCall` prepares a call, checks the estimate if it wants to, and invokes it. The target is a route and model of the assembled catalog; a slot name is refused.

```ts
const sideCall = ctx.sideCall
if (!sideCall) return fallback() // the port is optional

const prepared = await sideCall.prepare({
  label: 'sample.decide',
  target: { route: 'jev', model: 'typesafe/jev-1.13-20260917' },
  payload: { state, questions }, // exactly these two keys
  output: 'json', // the answers, parsed
  deadlineMs: 10_000,
})
const result = await sideCall.invoke(prepared, signal)
if (result.status === 'ok') return result.json // one answer set per question id
if (result.status === 'failed' && result.retryable) {
  // The adapter does not retry. Ask again as a new call, with a new invocationId.
}
return fallback()
```

`payload` is limited to 1 MiB, `deadlineMs` to 100–120000 ms (default 10000), and the deadline covers the whole call. See [Side model calls from a loop](../develop/plugins.md#side-model-calls-from-a-loop) for the full contract, including `status` and the `unknown` and `refused` outcomes.

The [Jev agent loop](jev-loop.md) is a loop plugin, an optional bundled package of the distribution, that makes this call at every step; its guide covers installing it from the Marketplace and pointing it at your route.

## Limits

- **Context.** The vendor accepts about 64k tokens for the whole request, and about 32.8k tokens for the state plus the longest question. A request over the limit comes back as `OVERFLOW`.
- **Questions.** The vendor sets no cap on how many questions a request carries; the limit is tokens. The adapter checks only the shape of the payload (`state` and `questions`), not the number of questions, their ids or the size of the state. Keeping a request inside the token limit is the loop plugin's job.
- **Rate.** The vendor documents a limit of 100K tokens per second per key. It is a rate, not a spending cap.
- **Reply.** The adapter reads at most 1 MiB of reply and refuses a larger one.
- **No retry in the adapter.** Every call makes exactly one HTTP request. A rate limit or a server error comes back as a retryable error, with the vendor's `retry-after` wait when it sends one, and the loop decides whether to ask again.

## Errors

The message is a fixed phrase such as `typesafe-systemone RATE_LIMIT (HTTP 429)`. It never quotes the reply, the key or the vendor's account fields.

| Code | When | Retryable |
| --- | --- | --- |
| `CONTRACT_MISMATCH` | The request is not a `{state, questions}` payload, carries messages, tools or a system prompt, or the vendor rejects it with another 4xx status | No |
| `AUTH` | No credential is bound, or the vendor answers 401 or 403 | No |
| `OVERFLOW` | The vendor reports `max_tokens_exceeded` | No |
| `NO_MODEL` | The vendor does not know the model id | No |
| `QUOTA` | The vendor answers 402 | No |
| `RATE_LIMIT` | The vendor answers 429 or 529 | Yes |
| `TRANSPORT` | A server error, a refused redirect or a connection failure | Yes |
| `TIMEOUT` | The call's own deadline passed | Yes |
| `FORMAT` | The reply is not a valid envelope, is over 1 MiB or is not UTF-8 | No |
| `NO_ADAPTER` | The route no longer exists or the adapter was shut down | No |
| `ABORTED` | The caller cancelled | No |

When the vendor rejects a request with a 4xx status, nothing was processed and nothing is charged, so the adapter reports zero usage before the error.

## Network and privacy

The adapter follows `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` like the other official adapters, and each route keeps a connection pool that is closed when the runtime is reconfigured or stopped. Redirects are refused so the key cannot be sent anywhere else. Set `networkTimeouts` on the route to tighten connection limits; the per-call limit is the side call's `deadlineMs`.

The `state` and `questions` of every call are sent to the vendor, and to OpenRouter when you use it. The local request trace records the same body as it does for every model request. Keep personal data and secrets out of the payload unless your agreement with the vendor covers them.
