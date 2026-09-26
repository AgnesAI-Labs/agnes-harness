# B-line W5a-0 XMarkdown boundary fixture

This isolated fixture runs the published `@ant-design/x-markdown@2.9.0` with React/ReactDOM
`18.3.1`. Its own `pnpm-lock.yaml` pins the full dependency graph. It is evidence for the W5a
connection design, not a production renderer or a default timeline switch.

## Reproduce

From the repository root with Node >=24.10 and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/web build
pnpm install --dir tools/test-fixtures/b-line-xmarkdown --frozen-lockfile
pnpm --dir tools/test-fixtures/b-line-xmarkdown typecheck
pnpm --dir tools/test-fixtures/b-line-xmarkdown test
pnpm --dir tools/test-fixtures/b-line-xmarkdown build
pnpm exec tsx packages/web/src/serve-entry.ts --ws ws://127.0.0.1:4199 --port 4198 --root /private/tmp/agh-w5a0-browser
```

Open `http://127.0.0.1:4198/` in a browser. The last command runs the **actual Agnes Web
server**, including its file allowlist and CSP. The fixture creates its static root under
`/private/tmp/agh-w5a0-browser`, using the repository's built React vendors through the import
map. The `/style.css` file deliberately merges Agnes base CSS, XMarkdown's generated CSS and
the fixture theme bridge; `/tokens.css` is copied from web-ui. No daemon or external data service
is required. Stop the server with Ctrl-C after testing. The generated static root may be discarded;
the nested lockfile, source, and tests are the reproducible fixture.

`src/compat.test.jsx` separates installed defaults from fixture adaptation. The default test
observes live image nodes, a relative link and missing literal script text. The adapted tests
use the existing `packages/web/test/markdown.test.ts` GFM and safety strings, plus reference,
copy, syntax, selection/focus, final replacement and simple suffix cases. The browser controls
repeat the material cases under the project CSP and display DOM/CSP/resource observations in
the report block.

## Boundary findings

- The installed package's `html-react-parser@5.2.17` ESM entry imports its CommonJS build, which
  calls `require('react')`. Externalizing React without a bridge throws in the browser. The
  fixture's esbuild banner maps only that require to the same import-map React module and throws
  for any other external require. Production builds must verify this exact edge on both Web and
  CLI artifacts before adopting the bridge.
- Its `es/XMarkdown/index.d.ts` imports `./index.css`; TypeScript 7 Bundler mode needs a CSS
  side-effect declaration in the consuming project. The fixture includes `src/css.d.ts`.
- `XMarkdown` imports core CSS itself. esbuild emits a CSS companion when bundling it. The
  browser fixture explicitly merges that output into `/style.css` and loads it, so no unlinked
  CSS chunk is relied upon. Production Web and CLI must do the same or explicitly link a named
  static CSS asset.
- The candidate policy in `src/adapt.jsx` is intentionally local to the fixture. Its escaped-tag
  protection, safe link renderer, image-as-text renderer, code control and update coordinator
  demonstrate feasible extension points. They are not exhaustive security or streaming code;
  W5a and W5b must add the production component and focused regressions.

The complete evidence, component and asset proposal, limitations and continuation are in
`docs/task-records/b-line-w5a-0-xmarkdown.md` in this checkout (task records are locally ignored).

## W5a production vendor browser probe

After `pnpm --filter @agnes/cli build:local`, run `node tools/test-fixtures/b-line-xmarkdown/build-production.mjs`.
It copies that build's `web/` output into `/private/tmp/agh-w5a-production-browser`, replaces
only the three HTML probe pages and `/app.js`, and keeps the production vendor, style and token
assets. Serve the resulting root with `pnpm exec tsx packages/web/src/serve-entry.ts --ws
ws://127.0.0.1:4199 --port 4198 --root /private/tmp/agh-w5a-production-browser`. Open `/`,
`/admin/plugins` and `/admin/resources` in Chrome. The same import map and CSP serve a hook
probe plus actual `ConversationMarkdown` static/body/thinking/theme/safety/copy controls.
This is an opt-in boundary probe; the default CLI pages remain unmodified. Stop the server after
inspection. The temporary output can be rebuilt or discarded.

## W5b-1 streaming and real-region browser acceptance

Build the complete local CLI first, then run `node tools/test-fixtures/b-line-xmarkdown/build-streaming.mjs`.
It keeps the packaged shared vendors, themes, tokens, licenses and original import map, while
building the actual `mountTranscriptRegion` / `TimelineNodeHost` / message adapter and live
projection into an opt-in probe. Its static root is `/private/tmp/agh-w5b1-streaming-browser`.
Only the Session transport/server facts and clipboard writer are synthetic; the renderers,
projection transformations, stores, DOM, selection, focus and project HTTP/CSP server are real.

```sh
pnpm --filter @agnes/cli build:local
node tools/test-fixtures/b-line-xmarkdown/build-streaming.mjs
pnpm exec tsx packages/web/src/serve-entry.ts --ws ws://127.0.0.1:4199 --port 4196 --root /private/tmp/agh-w5b1-streaming-browser
```

Open the three routes in Chrome to use the manual controls, or start a separate headless Chrome
with a disposable profile and DevTools port 9231, then run
`node tools/test-fixtures/b-line-xmarkdown/check-streaming-browser.mjs`. The checker brings its
page to the front and enables CDP focus emulation: an inactive page can change activeElement
without emitting native focusout, so that setup is required to test blur. Override the probe
origin/debug endpoint with `AGNES_XMD_STREAM_ORIGIN` / `AGNES_XMD_STREAM_DEBUG` if necessary.
The manual API opens the process disclosure when a test reuses a completed turn; normal
production requests use new turn IDs. The checker asserts that focus actually enters a visible
control before updating it.

Acceptance covers incomplete/closed/terminal syntax, late references and unchanged code-control
identity, selected body and thinking, focused copy and its displayed content/feedback, delayed
thinking handover/removal and process folding, cancellation/failure, two reconnects, fresh
preview versus final-result replacement, a later request, replay/order/dedup, session reset,
listener/unmount cleanup and all three routes' import-map/CSP/Chrome errors. It performs no
model call or physical network interruption and does not prove backend exactly-once execution.
No animation is enabled in this checkpoint. Stop the probe server and its Chrome process after
inspection; generated roots/profiles are disposable. The original/default Web pages are unchanged.

## W5b-2 suffix animation and synchronous facade acceptance

The current streaming checker also verifies real CSS animation objects: 480ms duration,
only appended text, retained fragment/node identity and start time, completed range retirement,
selection and copy-focus backlog painted immediately, actual background-tab visibility and
native reduced-motion emulation. It exercises the unchanged legacy timeline host through the
new `markdown.ts` facade, static document-preview updates and accessible/aligned tables.
All attached Markdown text/fragments belong to React; detached parsed-output plans are committed
only with the rendered tree. Limits are 65536 text characters, 4096 visited nodes, 32 active
ranges and 128 intersections, with surrogate-pair checks. The production Markdown component
never invokes the old DOM renderer or `web-admin-frame` reveal helper.

For the full CLI boundary instead of the source Web server, use:

```sh
pnpm --filter @agnes/cli build:local
node tools/test-fixtures/b-line-xmarkdown/build-streaming.mjs --cli
AGH_HOME=/private/tmp/agh-w5b2-cli-home AGNES_PROFILE=local-dev node /private/tmp/agh-w5b2-cli/agnes.mjs serve --port 4196
```

`--cli` copies the entire same-round CLI distribution into `/private/tmp/agh-w5b2-cli`, then
replaces only its probe HTML pages/app. Its executable, daemon, native dependencies, import map,
shared React/vendor/CSS and licenses come from that build; the original distribution remains
available for normal use. Start the isolated Chrome/debug endpoint as above and run the same
`check-streaming-browser.mjs`. The checker temporarily disables focus emulation during the
background-tab test (focus emulation otherwise forces the page visible), then restores it for
native blur checks. Stop the CLI serve process and Chrome after acceptance, and stop only the
probe's isolated daemon with:

```sh
AGH_HOME=/private/tmp/agh-w5b2-cli-home AGNES_PROFILE=local-dev node /private/tmp/agh-w5b2-cli/agnes.mjs daemon stop
node tools/test-fixtures/b-line-xmarkdown/check-streaming-browser.mjs --closed
```

The facade remains synchronous for create/update/dispose and interaction release. It injects
`syntax="immediate"`: the pinned library's normal stream cache is passive-effect driven and
cannot provide the old synchronous DOM read contract. React message consumers retain normal
stream caching; both paths use XMarkdown and the same safe React components/reveal planner.
The default timeline host is unchanged. Session facts and clipboard writes in the probe remain
synthetic, so these checks do not prove real model execution or physical network recovery.
