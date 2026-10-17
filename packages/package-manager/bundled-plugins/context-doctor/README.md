# Context doctor

English | [简体中文](README.zh-CN.md)

`@agnes/context-doctor` is an official optional plugin. It is shipped in the built-in catalogue and **disabled by default**. Install it from **Plugins → Catalogue**, review its capabilities, trust and enable it, then create a session whose composition includes it. Open **Context** in that session's workbench.

It adds no model-facing tools and calls no models. It observes `context`, `before_request`, `before_compact` and `compact`, stores a bounded metadata projection in its own session namespace, and provides the read-only `context.read` query to its panel. It requests no filesystem, network, credentials, process, input-delivery or administrative access. Its session lifecycle hooks remove live state; uninstall removes hooks, services, projection registration, panel and locale registration. Previously committed metadata follows normal session ledger retention.

The overview separates observed repository rules (`agents-md`), workspace memory (`memory:index`) and other sections. It shows UTF-16 character counts and the explicit heuristic `ceil(length / 4)` per section, plus surface estimates, missing-estimate counts, pins, tool result count, model slot and tool-name count. These estimates are **not provider tokenizer measurements**, for either Chinese or English. Missing sections and configured category budgets are unknown; absence does not mean zero or disabled. The hook sees only contributors that ran before it, rather than a final request breakdown.

Compaction shows the latest observed window/reserve, replaced sequence range and before/after estimates. Core still owns pin retention and tool-call/result pairing. Their post-compaction verification, actual wire tokens, omission causes and offloaded bytes are **unknown**. Tool result nodes can represent artifact references; their estimates cannot reveal the original output size. Model names and custom slot strings are omitted for privacy. The observed compaction window is not a current-model claim after a switch.

No body text, paths, arbitrary section IDs/sources, tool names, model identifiers, sampling values, or custom compaction instructions enter this plugin's persisted metadata. Categories and numeric counts are fixed. Projection state and query output are capped at 32 KiB; the live cache keeps at most 64 session/lane snapshots. Queries take `{}` and select only the Host-bound session/lane, never a browser-supplied session ID.

Current installed-hook projection readers do not expose an own-projection read capability. The panel therefore reads live metadata, rather than reconstructing history or using a private API. After restart, cache eviction or opening old history it shows unknown until new hooks run. Older backend versions or disabled/missing rows show a readable failure and Refresh. An additional authorized request-diagnostics facade is needed for historical reads and precise wire attribution; no new Core/Host seam is added here.

See the bilingual [user guide](../../../../docs/guide/context-doctor.md). Sources are independent project-authored code under Apache-2.0; no third-party implementation, prompts or assets were copied. `src/client.js` is generated from `src/client.tsx` by `node tools/build-feature-clients.mjs` from the repository root.
