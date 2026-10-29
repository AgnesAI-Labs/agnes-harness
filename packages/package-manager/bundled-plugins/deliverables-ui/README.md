# Deliverables presentation

Official default browser plugin for immutable delivered files. It owns snapshot cards, same-name history, conversation turn tails and the Deliverables workbench panel. UI uses the shared web-ui primitives without additional CSS. The backend `agnes/deliverables` tool remains independently enabled.

This profile-lifetime plugin registers the `deliverables` presentation role at priority 100. An enabled community provider with a lower priority takes over the entire experience. Revocation synchronously removes its cards, slot and panel; disposing the replacement restores this default. No package identity is hard-coded in Web.

The public `@agnes/web-client` `DeliverablesStore` reads authorized session UI projections, durable `present` structured results and historical Intelligent UI file lists. `DeliverableRecord` carries session/lane, presentation identity, source, owning turn, display fields, placement and the complete existing ArtifactRef. `groupDeliveredFiles` groups by name and immutable content, not filesystem path or proven lineage. Existing `x/agnes/deliverables/presented` events remain canonical; no new storage or migration is introduced. New `present` results additionally persist their file metadata through `structured`; UI-only `details` are not durable.

The reader follows session readiness epochs. A history preview can mount the role before admission; file reads and live event subscriptions start when that same session becomes ready. Leaving readiness clears the displayed files and invalidates pending reads, including when the session id stays the same.

Every delivered version is a content snapshot. Editing the workspace file does not change it. Open and download always use `ClientResourceService` with the recorded lane and full artifact identity. Refusal and reclaimed/missing content remain failures. A reference is never authorization.

Intelligent UI is an optional peer of the backend tool. If rendering is disabled or fails, `present` still records the snapshots and succeeds; this plugin displays the durable plain file list. Existing Intelligent UI file-list records remain readable after switching providers.

The conversation tail follows its parent outlet with `slots.inject()`. It may be absent during startup or conversation replacement; the data store, card renderers and workbench panel remain available. Disposing the role also removes the injection, so later outlet declarations cannot revive its old owner.
