# Inspect session usage

English | [简体中文](usage-cockpit.zh-CN.md)

[Documentation](../README.md) · [Plugin lifecycle](packages.md) · [Sessions](sessions.md)

Install **Usage cockpit** (`@agnes/usage-cockpit`) from the built-in plugin
catalogue. Review its source and UI capability, trust it and enable it. It is
optional and disabled by default; it adds no tools to session prompts.

1. Select a readable session in the sidebar and open **Usage** in home navigation,
   or open the **Usage** workbench panel in that session.
2. The **Session** view shows input/output/cache tokens, recorded USD and credits.
   Credits are not converted into dollars. An incomplete record explicitly says
   coverage is partial; missing usage or billing is unknown, not a free call.
3. Switch to **Calls** with the keyboard-accessible two-choice control. Inspect
   primary, summary, reviewer, side-call, parent-recorded child and other charges.
   Provider-reported and estimated USD are separate. Interrupted charges remain.
4. Use **Refresh usage** after new activity or a failed read. A failed or unavailable
   old projection shows a readable retry state. Changing sessions discards old
   in-flight reads. Turning off or removing the plugin releases its UI registrations.

Session totals use the backend's ledger projection, including effect/request
deduplication, cumulative provider usage and adjustments. Call amounts deduplicate turn-call effect IDs and apply linked signed adjustments
without recounting tokens. They are already included in the session total.
Records outside the turn-call projection, unresolved adjustments and missing
request usage retain unknown attribution. Model changes are shown on individual recorded calls. Restarting the
backend or reopening the panel recomputes the same ledger cut without a private
billing database.

The coverage notice is always visible: independent child sessions, including
unadopted or foreign children, are not read. Parent-recorded child charges are
already counted once. This page is a selected-session view, not a full task-tree
bill. Headless parent summaries similarly omit independent child ledgers. A future
full-tree view needs an authorized aggregate API that checks each child's access.
No global scan, telemetry upload, quota change or budget override is performed.
Amounts are recorded evidence or estimates, not a provider's final invoice.

For an offline demonstration, run the focused synthetic tests described in the
[package README](../../packages/usage-cockpit/README.md).
No model account or API key is needed to inspect existing records.
