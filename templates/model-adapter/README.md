# __PACKAGE_NAME__

AGH model-adapter starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Use `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.

main registers a structural adapter through `ctx.providers.register(modelAdapterKind, adapter)`. Select it in the profile with `providers.model-adapter: { provider: adapter.id }`, a route whose api equals adapter.id, a model on that route using adapter.wireApi, and keyless: true for this no-network demo. wireApi names the transport format. Real adapters must implement their protocol and credential requirements. Instances own dispose; registration-wide resources belong in cleanup. Successful reload publishes the adapter for new sessions; existing sessions keep their generation. Process backends still require a restart. The fixed development reply is not a real model integration.

`capabilities` states what the adapter takes. `imageInput`, `tools` and `streaming` are required booleans. Set `payload: true` only if the adapter reads `request.payload`, the structured JSON value a loop sends with a side model call; without it the host refuses a request that carries a payload before sending anything. Set `payloadOnly: true` as well if the adapter takes a payload and no messages. It requires `payload: true`, and the host then leaves the adapter's models out of the conversation and child-agent model choices it serves and refuses to select one for a session or a child agent (a model list read before the runtime has started may still show them, but choosing one is refused), and a preset slot left at `default` skips the routes it serves. An adapter that also answers chat messages declares only `payload: true` and stays selectable. A registration whose `payload` or `payloadOnly` is not a boolean, or that sets `payloadOnly` without `payload`, is refused.
