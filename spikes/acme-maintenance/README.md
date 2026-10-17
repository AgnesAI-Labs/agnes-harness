# Acme Maintenance white-label spike

A research-only package. Do not merge it into the product. It contains one synthetic read-only tool, one fixed workflow Loop/Bundle/preset, and a profile-lifetime browser contribution. It uses public package exports only. No customer systems or model keys are needed.

`client/agnes.client.json` declares the public host-region and DSH brand slots, the exact slot catalog version, a primary home entry and a selectable Acme skin. The browser module registers both locales, uses a presentation role to own cleanup, replaces the sidebar and conversation welcome region, and starts an ordinary SDK session from its home page. The host still owns sessions, policies, approvals and recovery.

The root URL opens the Acme page when no explicit page/session/settings selection exists. Conversation and home remain ordinary host surfaces. An administrator can use `/?page=plugins` and `/?settings=general`. This is presentation customization, not a user/admin authorization boundary.

Select **Acme** under Settings → General → Appearance → Skin. Selection is a browser preference; installing this package does not select its skin. Browser document titles, favicon, assistant identity and other built-in administration copy retain AGH branding. Replacing the sidebar also means retaining history/workspace navigation would be the application author's responsibility; this minimal spike retains the current conversation and session deep links.

From the repository root, after a local production build:

```sh
node --import tsx spikes/acme-maintenance-harness.mjs setup
node --import tsx spikes/acme-maintenance-harness.mjs web
# In another terminal:
node --import tsx spikes/acme-maintenance-harness.mjs install
node spikes/acme-accept.mjs en --start
node spikes/acme-accept.mjs zh-CN --start
```

The driver uses only the production CLI and public Node SDK. It initializes a new `/tmp` home before writing `acme-maintenance-profile.json`, registers a synthetic workspace, inspects the package, installs the inspected integrity, trusts the exact capability hash, and enables it. It prints a dynamically selected loopback URL. It starts no real model provider. Run with Node 24 and the repository's pinned pnpm. Run builds/checks through the task's machine-wide heavy-lock wrapper.

The browser probes use the repository's installed Playwright. `acme-browser.mjs` captures a requested route; `acme-defaults.mjs` captures the default UI after removal. Browser state and screenshots are written outside the checkout, under the sibling `reports/mp/ARCH/PC-ARCH0-WHITELABEL` evidence directory. Browser state contains local authentication and must not be published. The hidden native settings selects mirror the host's React pickers; the probes dispatch their ordinary change handlers.

```sh
node spikes/acme-upgrade-fixture.mjs
# Pass the printed temporary directory:
node --import tsx spikes/acme-maintenance-harness.mjs update /tmp/<printed-directory>/v11
node --import tsx spikes/acme-maintenance-harness.mjs resume <existing-session-id>
node --import tsx spikes/acme-maintenance-harness.mjs disable
node --import tsx spikes/acme-maintenance-harness.mjs uninstall
# Stop the Web terminal with Ctrl-C first, then:
node --import tsx spikes/acme-maintenance-harness.mjs stop
```

Compatible upgrade changes package version and tool evidence to 1.1.0 while retaining Loop version 1.0.0; old sessions should return old evidence and new sessions new evidence. A changed Loop version is a different contract and can refuse activation while old selections still reference 1.0.0. Do not force or bypass that refusal. Disabling/removing revokes profile UI, restores default navigation and clears an unavailable skin; pinned backend code may remain for historical sessions.

In the measured build, SDK projection contains completed tool results but the stock browser conversation omits the workflow body. This spike deliberately does not repair product rendering. Runtime completion alone is not full browser-session acceptance.
