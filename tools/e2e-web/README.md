# Web browser smoke tier

Run from the repository root against an isolated running AGH server:

```sh
AGH_WEB_URL=http://127.0.0.1:PORT pnpm test:web-smoke
pnpm test:web-smoke --list
```

This tier is intentionally separate from normal Vitest `*.test.ts` suites. The runner finds an installed Playwright package or one already in the npm cache. It uses cached Chromium and does not install browsers. Set `AGH_PLAYWRIGHT_PACKAGE` to a Playwright package directory or `AGH_CHROMIUM_PATH` to an existing browser executable when required. Failure traces go to a temporary directory unless `AGH_WEB_TEST_OUTPUT` is set.

The navigation skeleton verifies both locales, every settings destination, all provider kinds, local-plugin controls and uncaught browser errors. Extend it for the final integrated mutation/session acceptance described in [UI coverage](../../docs/develop/ui-coverage.md). Do not point mutation acceptance at a real user home.
