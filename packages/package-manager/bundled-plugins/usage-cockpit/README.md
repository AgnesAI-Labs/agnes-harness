# Usage cockpit

English | [简体中文](README.zh-CN.md)

Optional official `@agnes/usage-cockpit` plugin, disabled by default. Install it
from the built-in catalogue, review and trust it, then enable it. Open **Usage**
in the home navigation or the selected session's workbench.

The plugin reads only the selected session through the authenticated SDK UI
projection. It contributes no model tools, billing rules or background collector.
See the [guide](../../../../docs/guide/usage-cockpit.md).

Session totals come directly from the backend ledger projection, which owns
request/effect deduplication, cumulative usage and adjustments. Credits and USD
remain separate. Gateway-reported amounts, estimates and unknown amounts retain
their source. Retained late or interrupted-call charges stay visible.

Call categories show primary, summary, reviewer, side calls, parent-recorded
child charges and other calls. Turn-call effect IDs deduplicate the display; linked signed adjustments apply to
the original charge without counting its tokens again. These amounts are already
in the session total. Records outside the turn-call projection, unresolved
adjustments and missing calls retain unknown attribution. Older projections
without usage show unknown. The plugin does not read child sessions, unadopted
children or other owners' data, and does not claim a full task-tree bill.

Disable/uninstall removes navigation, panel, cards, locale registrations and
subscriptions. Nothing writes to the billing ledger or changes budget admission.
The browser keeps only a derived view; reopening replays the authorized projection.

Maintainers: `pnpm --filter @agnes/usage-cockpit build:client` regenerates
`src/generated/client.js` from TypeScript. Its only runtime imports are existing public
platform exports. No third-party implementation, prompt or asset is embedded.

Offline checks (synthetic records and fake model identities; no keys):

```sh
pnpm exec vitest run packages/package-manager/bundled-plugins/usage-cockpit/test --project fast --maxWorkers=1
```
