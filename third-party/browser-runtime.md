# Built-in browser runtime provenance

The optional @agnes/browser plugin uses playwright-core **1.63.0**, published by
Microsoft under Apache-2.0. The CLI build copies the complete pinned npm package,
including LICENSE, NOTICE and bundled dependency notices, to the plugin's
dist/runtime/playwright directory. Its dynamically loaded assets must be retained.

The corresponding Playwright Chromium revision is **1243**. This revision selects
**Google Chrome for Testing 153.0.8010.12** archives, rather than an unbranded
Chromium binary. The browser payload is not part of AGH's Apache-2.0 license.

The feature downloads a reviewed archive from Playwright's HTTPS CDN only after
explicit enable/preparation. It checks the exact byte count and SHA-256 recorded in
[browser-artifacts.json](../packages/package-manager/bundled-plugins/browser/src/browser-artifacts.json)
before extracting it into an owned OS cache. AGH does not distribute the downloaded
browser in its normal CLI payload. The complete archive's ABOUT, embedded credits
and other notices remain in that cache; the package does not remove or replace them.

Upstream information:

- [Playwright](https://github.com/microsoft/playwright)
- [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)
- [Versioned Chrome for Testing downloads](https://github.com/GoogleChromeLabs/chrome-for-testing)

The downloaded ABOUT identifies Google LLC's copyright and directs users to
chrome://credits and chrome://terms. The Apache-2.0 license of the Chrome for
Testing infrastructure repository is not a substitute for browser binary terms.

Windows x64, macOS arm64 and macOS x64 archives were downloaded and hashed on
2026-10-19. Their expected executable paths and macOS Mach-O CPU types were
inspected. Archive inspection does not establish macOS runtime compatibility;
the native smoke test must run on each admitted OS/architecture before release.

This plugin is for trusted development/testing content. It uses an isolated
browser profile and Chromium sandboxing, not an OS virtual machine or a universal
network sandbox. It does not inherit the user's personal browser state.
