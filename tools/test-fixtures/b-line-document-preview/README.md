# Rightbar document browser boundary fixture

This fixture uses the current `startClientModules`, rightbar registry/SlotOutlet, session service, resource adapter and React document component. Only the external artifact-read RPC is synthetic. It copies the current CLI build's shared assets and records source and asset hashes. It does not start a daemon or exercise SDK transport authorization.

Build and serve from the repository root:

```sh
pnpm --filter @agnes/web build
pnpm --filter @agnes/cli build:local
node tools/test-fixtures/b-line-document-preview/build.mjs
pnpm --filter @agnes/web exec tsx src/serve-entry.ts --ws ws://127.0.0.1:9 --port 4198 --root /private/tmp/agh-w6b2-browser
```

Launch an isolated Chrome profile with debugging port 9234, then run:

```sh
node tools/test-fixtures/b-line-document-preview/check-browser.mjs
```

The ordinary check requires working native PDF display and no unexpected browser resource failures. Chrome currently rejects PDF navigation in the preserved sandbox, so this check fails. To verify the other behaviors while explicitly asserting that refusal:

```sh
node tools/test-fixtures/b-line-document-preview/check-browser.mjs --expect-pdf-blocked
node tools/test-fixtures/b-line-document-preview/inspect-pdf.mjs
```

The diagnostic mode reports `acceptanceComplete: false`; its pass is not full PDF or W6b-2 acceptance. The matrix compares the same valid PDF with no sandbox, an empty sandbox, and script/origin variants in the isolated diagnostic page. It never changes production sandbox attributes. Chrome displays the document only in the unsandboxed diagnostic frame.

Checks include literal/empty text, sanitized HTML, decoded image, 401/403/410/500 text, title-update focus/control identity, Tab/Enter, old and late URL release, plugin replacement/return, session loss/return, actual client-module remount, themes and cleanup. `--expect-blob-blocked` is an additional diagnostic for the former CSP conflict and is not ordinary acceptance. Runtime evidence and screenshots are written under the temporary directory. Stop only the fixture server and browser processes when finished.
