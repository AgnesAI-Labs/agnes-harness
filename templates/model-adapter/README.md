# __PACKAGE_NAME__

AGH model-adapter starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Use `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.

main registers a structural adapter through `ctx.providers.register('model-adapter', packageName, adapter)`. Configure provider.adapters with the registration id, a route whose api equals adapter.id, a model on that route using adapter.wireApi, and keyless: true for this no-network demo. wireApi names the transport format. Real adapters must implement their protocol and credential requirements. Instances own dispose; registration-wide resources belong in cleanup. Successful reload publishes the adapter for new sessions; existing sessions keep their generation. Process backends still require a restart. The fixed development reply is not a real model integration.
