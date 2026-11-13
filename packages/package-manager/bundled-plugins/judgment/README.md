# Judgment

An optional plugin for replies that promise to act but end early. Install it from the AGH Marketplace, enable the plugin, and select a judgment model. Unexpected-stop detection stays **off by default** until you explicitly enable `uses.stop.enabled`. Real-session effectiveness has not been evaluated.

The plugin uses the host's `sideCall` capability and reads conversation messages through its own projection. It sends the latest request's first 2,000 characters and the final reply's last 8,000 characters after credential redaction, together with a fixed judgment question. Remote providers receive the remaining text.

A sole native route with one model can be selected automatically. Multiple routes or models require an explicit selection. You may explicitly choose a chat primary; native failures never fall back to chat. At most one native fallback is allowed.

It may prompt one continuation in the current turn per user request. A durable session marker preserves that limit across restarts. Child sessions, turns marked unattended, and goal-driven work are excluded. Failed or cancelled judgments let the turn finish normally.

Native answers use a process-local LRU cache of at most 2,000 entries for 30 days. Hashed keys and answers contain no source excerpts; the cache disappears on plugin disposal or restart.

See the [English guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/develop/docs/guide/judgment.md) or [中文指南](https://github.com/AgnesAI-Labs/agnes-harness/blob/develop/docs/guide/judgment.zh-CN.md) for setup, disclosure and limitations.

The generated entry requires an in-process host compatible with Extension API 5.17. It is built from `packages/judgment`; it is not a separate implementation.

The shared judgment runtime limits actual side calls to 16 per plugin instance. It checks recorded request identities before replay and uses a new attempt id for a retry. Results distinguish native probabilities from text answers and include observed usage, dispatch and replay information; missing billing stays unknown. The plugin adds no dollar cap or price-availability dispatch gate; host budgets continue to apply.

Two additional opt-in tools are available: `uses.find.enabled` exposes `find_relevant` with a native judgment primary, and `uses.batch.enabled` exposes `judge_batch` with a native or explicitly selected chat primary. Both default off. Find locally ranks filenames and content from bounded 1 MiB prefixes, sends redacted paths, 256-original-character summaries and 8 KiB source windows from at most 20 fresh prefixes, and returns ranked line ranges with partial reasons. Batch sends up to 500 redacted independent JSON states and question text; credential-shaped question/choice identifiers refuse the entire batch without renaming; choice questions require `other` and `mixed`. Text answers always need review and expose no calibrated probabilities. Complete available context is redacted before bounded source selection; remote providers receive remaining content, which can still be confidential. Find and batch have total 20/60-second deadlines, share the runtime scheduler and preserve original usage/accounting. Human source-query and batch effectiveness evaluations have not been performed. See the guides for limits, privacy and cancellation behavior.
