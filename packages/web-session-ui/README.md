# Web session UI

Shared session helpers for the Native Web shell and frontend plugins. Import the
package root or the public helper subpaths (for example
`@agnes/web-session-ui/timeline` and `@agnes/web-session-ui/session-pane`).
Implementations live here; legacy `packages/web/src` files only re-export them.
This package has no dependency on the Web shell or Jev runtime.

`createTimelineRenderer` accepts `slotCardContext` with a public `SlotRegistry`
and a claim resolver, so plugin-owned timelines do not depend on Native boot.
Native boot may continue to bind the default with `bindSlotCardContext`.
`runtimeNodeCard` optionally supplies a runtime-specific card factory with
`update` and optional `dispose`; the default card displays protocol runtime
observations without choosing a runtime implementation.

React, React DOM and the web-client registry must share the host's existing
browser import-map instances. Frontend bundles may include this package, while
externalizing those host modules. All third-party UI components remain behind
`@agnes/web-ui`; this package adds no UI vendor dependencies or stylesheets.
