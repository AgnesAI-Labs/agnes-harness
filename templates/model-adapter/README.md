# __PACKAGE_NAME__

AGH model-adapter starter. Requires Node.js 24.10 or later and matching AGH package builds.

```sh
npm install
npm run build
npm test
```

The AGH packages in this preview are not yet on npm. Until distribution is available, supply local package artifacts or links through their public package names; keep application imports unchanged.

main registers a structural adapter through modelAdapters. Configure provider.adapters with the registration id, a route whose api equals adapter.api, a model on that route, and keyless: true for this no-network demo. Real adapters must implement their protocol and credential requirements. Instances own dispose; registration-wide resources belong in cleanup. Runtime adoption follows the Host model-adapter contract and may require a restart. The fixed development reply is not a real model integration.
