# Superagent panel source

This private browser source package is bundled into the existing `@agnes/superagent` optional payload
(`src/client.js`, built by `tools/build-feature-clients.mjs` next to the committed `src/agnes.client.json`). Users
install one Superagent package. The browser module uses only React, the public web-client API and the page's shared
`@agnes/web-ui` components, and never imports the Superagent runtime: the package's `panel-api` is read for types only, and the few values the panel needs from the
package (limits, error and setup texts, filter lists) are copied into `src/shared.ts`, which `test/shared.test.ts`
keeps identical to their source.

Adapted from dsh-superagent (MIT): the views are the prototype's panel on AGH controls. What is new is the mount
(`src/index.tsx`: one primary home entry), the data channel (`src/api.ts`: each route of the prototype's management API
is one profile service, a query for a GET and an effect for the rest) and the translation and form types
(`src/text.ts`, `src/locales.ts`, `src/deployment.tsx`: machine settings are the plugin's configuration and are shown
read-only here, with a link to the plugins page).

A failed service call is an answer, not an exception: the services return `{ failure: { status, error, … } }`, the
status and body the prototype's route sent, and `api.ts` turns it back into an `ApiError`. A call the Host refuses or
cannot reach (plugin off, connection dropped) is reported as the service not answering.

Look and feel: the controls are the AGH ones from `@agnes/web-ui` (button, switch, segmented control, tabs, fields,
dialog, help tooltip, banner, empty state); `src/controls.tsx` adapts them to the props the views use. The views' own
layout is `src/superagent.css`, written with the AGH theme tokens only. The descriptor lists it under `styles`, and the
payload build copies it next to `src/client.js`: the page loads a plugin stylesheet as a file in its `app` layer, and its
CSP refuses an inline `<style>`, so a stylesheet rendered by the panel itself would never apply.

`test/` renders the real panel against a fake set of profile services (`test/helpers/panel-server.ts`), which records
each call as the route it replaces. The tests need a DOM, so each file declares the happy-dom environment.
`test/panel-styles.spec.ts` runs in Chromium with the shared component checks (`tools/e2e-web/playwright.components.config.mjs`):
`test/helpers/browser.ts` serves the panel with the page's stylesheets, the descriptor's stylesheets and the page's CSP,
and the spec checks that the stylesheet applies and the AGH controls render.
