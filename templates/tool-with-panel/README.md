# __PACKAGE_NAME__

English | [简体中文](README.zh-CN.md)

AGH tool-with-panel starter: a working profile to-do list with a tool, query/effect services and a React page. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Ask a new session to call `__TOOL_NAME__` with `{"action":"add","text":"First item"}`, `{"action":"list"}` or `{"action":"toggle","id":"<item id>"}`. The tool and page share the public owner/profile-bound `OwnedStore`; review `capabilities.store: true`. This is profile data, independent of the workspace and retained across restart. The example limits the list to 100 items of 200 characters.

Open the printed AGH Web URL and the additional `__PACKAGE_NAME__` sidebar page. It works without a selected conversation. Add an item, toggle its checkbox and refresh; a failed request shows an alert. The plain JavaScript imports React from the Host import map and uses `React.createElement`, with no frontend build step or global React/h injection. `apply(ctx, config)` captures the client context; page props contain presentation context, not tool execution APIs.

The descriptor declares `__SERVICE_NAME__.list` and `__SERVICE_NAME__.change` in `client.services`. The backend registers these with `scope: 'profile'`. The browser uses `ctx.profile.services.query/effect/readOperation`; there is no browser `ctx.tools.invoke`. The page saves pending operation identity in browser-tab session storage, scoped to the profile activation and client revision. Reopening or reloading reads the original receipt before permitting another mutation; final receipts clear the entry. Storage failure prevents dispatch. For approval-required receipts, approve in the Host Approvals tab and check the same operation. For running/unknown results, inspect or reconcile that operation before starting another mutation. Host authorization remains authoritative.

Both shipped tests are inherited by authored candidates: the backend test uses `createPluginTestHost` with an isolated `storeDir`, invokes the tool and services and recreates the Host to check persisted data. `invokeProfileService` tests registered handler contracts; it does not simulate native approvals or the operation journal. The DOM test uses `@agnes/web-client/testkit` and replaces only `profileCaller`, keeping the real client facade, descriptor allowlist and registration lifecycle. It exercises loading, list rendering, add/toggle, receipt lookup and errors in English and Chinese. Run these through `agh plugin test <folder>` (or `plugin_test` for a candidate). They do not prove installation or real-browser appearance.

Use the [version-matched author reference](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/reference/plugin-author-api.md) and template instead of searching Host/installed source to guess APIs; private install directories are denied by design. For delivery, assemble the complete candidate, pack it with `agh plugins pack <folder> <output.tgz>`, then call `present` with the workspace `.tgz` filesystem path. An `artifact://` reference is not a workspace path. Installation and publication require the exact tested-candidate permission decision: full access allows it automatically, while other permission levels retain human review.
