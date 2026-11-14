# Superagent panel source

This private browser source package is bundled into the existing `@agnes/superagent` optional payload
(`src/client.js`, built by `tools/build-feature-clients.mjs` next to the committed `src/agnes.client.json`). Users
install one Superagent package. The browser module uses only React and the public web-client API and never imports the
Superagent runtime: the package's `panel-api` is read for types only, and the few values the panel needs from the
package (limits, error and setup texts, filter lists) are copied into `src/shared.ts`, which `test/shared.test.ts`
keeps identical to their source.

Adapted from dsh-superagent (MIT): the components are the prototype's panel, unchanged. What is new is the mount
(`src/index.tsx`: one primary home entry), the data channel (`src/api.ts`: each route of the prototype's management API
is one profile service, a query for a GET and an effect for the rest) and the translation and form types
(`src/text.ts`, `src/locales.ts`, `src/deployment.tsx`: machine settings are the plugin's configuration and are shown
read-only here, with a link to the plugins page).

A failed service call is an answer, not an exception: the services return `{ failure: { status, error, … } }`, the
status and body the prototype's route sent, and `api.ts` turns it back into an `ApiError`. A call the Host refuses or
cannot reach (plugin off, connection dropped) is reported as the service not answering.

`test/` renders the real panel against a fake set of profile services (`test/helpers/panel-server.ts`), which records
each call as the route it replaces. The tests need a DOM, so each file declares the happy-dom environment.
