# Community deliverables gallery

This independently installable browser plugin replaces the whole official deliverables experience through the public `deliverables` presentation role. It reads the same immutable snapshots through `DeliverablesStore`, renders turn-tail cards and its own Gallery workbench panel, and uses authorized resource loaders for Open and Download. It imports no Web host or official presentation code. It adds no CSS and needs no backend filesystem permissions.

From a clean throwaway `AGH_HOME`, with the default deliverables tool enabled:

```sh
node agnes.mjs plugins add file:/absolute/path/to/examples/community/deliverables-gallery
```

Review, trust and enable the installed package in Plugins, then preview and adopt its application in Settings → Application. Installation alone never takes over the current product. This profile-lifetime provider statically declares the `deliverables` role and registers priority 0; the official priority-100 provider yields all its cards and its tab. Ask the agent to create a workspace file and call `present`. Open it from its title or download it from Gallery. Editing the source later preserves the delivered bytes. Close/reopen Web or restart the runtime: enabled installed providers reconstruct the same history. Disable this package to restore the official cards and Deliverables tab, then remove it. The Gallery tab and registrations are removed; backend artifact access still requires the current session/lane authorization.

The light automated gates are `packages/web/test/deliverables-plugin.test.tsx` (presentation takeover, recorded files, open/download, denial, reconstruction, fallback and cleanup) and `packages/package-manager/test/bundled-plugin-source.test.ts` (real offline install/trust/enable, manager reconstruction, disable and uninstall in a temporary home). Resource/backend calls in the browser unit test are controlled fakes; this is not a real daemon/browser acceptance run.
