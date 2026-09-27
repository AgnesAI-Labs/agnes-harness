# Computer Use browser boundary fixture

The fixture consumes the actual Web state coordinator, client-module bootstrap, settings SlotOutlet and React pane with synthetic RPC. It copies shared assets from the current CLI local build, records source/asset hashes, and replaces only the entry script with the probe. It does not start a daemon or run system authorization or driver operations.

From the repository root:

```sh
pnpm --filter @agnes/web build
pnpm --filter @agnes/cli build:local
node tools/test-fixtures/b-line-computer-use/build.mjs
pnpm --filter @agnes/web exec tsx src/serve-entry.ts --ws ws://127.0.0.1:9 --port 4197 --root /private/tmp/agh-w6a2-browser
```

In another terminal, launch Chrome with an isolated profile and debugging port 9233, then run:

```sh
node tools/test-fixtures/b-line-computer-use/check-browser.mjs
```

The check covers four sections, zero sessions, native Tab/Enter, stable buttons and focus on enabled controls, hidden-pane polling, replacement recovery, retired replies, cancellation followed by another operation and completion, safe failures/retry, both themes, CSP/resources and cleanup. Native disabled buttons follow the browser's focus behavior. The runtime manifest and light/dark screenshots are written under the temporary directory. Stop only the fixture server and Chrome processes when finished.
