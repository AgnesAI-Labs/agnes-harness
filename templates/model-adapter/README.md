# __PACKAGE_NAME__

AGH model-adapter starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

main registers a structural adapter through modelAdapters. Configure provider.adapters with the registration id, a route whose api equals adapter.api, a model on that route, and keyless: true for this no-network demo. Real adapters must implement their protocol and credential requirements. Instances own dispose; registration-wide resources belong in cleanup. Successful reload publishes the adapter for new sessions; existing sessions keep their generation. Process backends still require a restart. The fixed development reply is not a real model integration.
