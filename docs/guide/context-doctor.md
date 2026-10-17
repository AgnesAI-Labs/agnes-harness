# Explain context metadata

English | [简体中文](context-doctor.zh-CN.md)

[Documentation](../README.md) · [Default context](context.md) · [Plugin lifecycle](packages.md)

The optional official **Context doctor** plugin explains the context metadata available to public hooks. It is in the built-in plugin catalogue and disabled by default. It needs no model key and adds no tools to sessions.

1. Open Plugins → Catalogue, install `@agnes/context-doctor`, inspect its capabilities, trust and enable it.
2. Start a session with this plugin included in its composition. Existing sessions keep their pinned backend code; enabling a plugin does not retrofit old sessions.
3. Run an ordinary task using your configured model, or your existing offline scripted model fixture. Open **Context** in the workbench and choose **Overview** or **Compaction**. Use Tab and the arrow keys to change the segmented view; Refresh retries a read.
4. Overview separates observed fixed rules, workspace memory and other sections. Compaction shows the latest observed window/reserve, replaced range and before/after estimates after compaction occurs. This is read-only: it cannot trigger compaction or change permissions.
5. Disable the plugin for future sessions or remove it through normal plugin management. UI and hook registrations release on unload. Committed metadata remains in the session ledger under its ordinary retention rules.

Section counts use UTF-16 length divided by four, rounded up per section. Chinese and English can both differ substantially from a provider's tokenizer. Surface and compaction values are also estimates from hooks. A zero that was actually observed is displayed as zero; a missing value is **Unknown**. The observed rule/memory size is not its configured budget, which these hooks do not expose. Later context contributors may not have run yet, so this is not a final model-request decomposition.

Large tool outputs may already be offloaded into artifact references. The panel can count result nodes and their surface estimates, but cannot infer the original bytes, omission causes, or actual retained tool pairs and pins. Core retains authority for pairing and pins; the panel does not verify these after compaction. A before-compaction window belongs to that observation, not necessarily the model used after a later switch. The current-model window is unknown.

Only fixed categories and numeric metadata are persisted: no prompt bodies, paths, arbitrary section IDs/sources, tool names, model names or credentials. The query uses the authenticated current session/lane, accepts no session selector and never enumerates other sessions or global data. Metadata projection and response are capped at 32 KiB; at most 64 live snapshots are cached.

If the panel says it cannot read diagnostics, check that this session includes the backend row and retry Refresh. Missing or older backend rows cannot silently provide another session's data. After a restart, cache eviction or opening old history, live values remain unknown until new hooks run. The existing installed-hook reader cannot restore this projection. Precise wire/tokenizer attribution, historical diagnostics, offload provenance and verified retention depend on a future authorized read-only diagnostics contract.

For a keyless demonstration, run the synthetic tests in the [package](../../packages/package-manager/bundled-plugins/context-doctor/README.md). They cover English/Chinese rules, memory, a large-output surface, a model-window change and compaction ranges without invoking a model or external effect. Browser and real-model acceptance are separate integration checks.
