# __PACKAGE_NAME__

AGH tool-with-panel starter. Requires Node.js 24.10 or later and matching AGH package builds.

```sh
npm install
npm run build
npm test
```

The AGH packages in this preview are not yet on npm. Until distribution is available, supply local package artifacts or links through their public package names; keep application imports unchanged.

Install the built directory through AGH plugin management, enable it, then ask a new session to call __TOOL_NAME__ with {"message":"hello"}. Inspect the tool record for the structured result. Update effect and replay metadata when adding I/O.
