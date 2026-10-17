# Review and consolidate memory

English | [简体中文](memory-review.zh-CN.md)

[Learned memory](memory.md) · [Plugin lifecycle](packages.md)

**Memory review** (`@agnes/memory-review`) is an optional official plugin. It finds possible duplicate, conflicting or obsolete workspace preferences and proposes replacements with source hashes, a snapshot revision and complete file diffs. Findings are model suggestions for human review. AGENTS.md and authorized knowledge sources take precedence over learned preferences.

## Install and run

1. Open **Settings → Plugins → Catalogue**, select **Memory review**, inspect its source and permissions, then install, trust and enable it. It ships with the built-in catalogue but is never installed or enabled automatically. A CLI installation can use `node agnes.mjs package add file:./bundled-plugins/memory-review`; trust and enable remain separate operations.
2. In **Settings → Agent → Memory**, select **Ask before writing** for this workspace. Off refuses agent reads and writes. This workflow also refuses Automatic at entry because it is intended for human-reviewed corrections. It cannot enable memory itself.
3. Create a **new session** in that workspace and select `agnes.memory-review@1.0.0` in the Loop picker. Use the ordinary configured conversation model; no special account or new credential is required. Selecting this Loop does not change the default for other sessions. An explicit profile selection is `providers.loop: { provider: agnes.memory-review, version: 1.0.0 }`; its matching optional tool policy is `providers.tool-policy: { provider: agnes.memory-review }` in a preset. The supplied remembering Skill is named `memory-review`.
4. Ask, for example: “Find duplicate preferences and conflicting package-manager advice. Our AGENTS.md requires pnpm. Propose conservative corrections.”
5. Open **Memory review** in the session workbench. **Findings** shows conflict groups and their source hashes; **Changes** shows each full replacement diff, base/new hashes and the revision. Long file lists use a Select, and the two views use keyboard-accessible Segmented controls.
6. Review the native memory approvals as the workflow reaches each file. In Ask mode, each write still needs the existing one-time human approval bound to its complete diff and base/new hashes. Full access and session grants do not replace that approval. Reject unsupported corrections.

The plugin consumes the existing Host-produced `memory:index` prompt section through the public Loop turn view and normal mediated file ports. If the section is omitted or its format is unavailable on an older backend, the workflow refuses to infer a path. Increase the memory context budget if needed, or use the ordinary memory editor. The default Loop receives no extra model-visible tools from this plugin.

## Results and recovery

Topic replacements run before the index. Retiring a topic writes a small provenance tombstone rather than unlinking it; consolidation retains the revision, source file hashes and reason inside the memory file. Provenance is untrusted learned data, not authoritative instruction. Native memory budgets and credential-like-text checks still apply, including the added provenance bytes.

Multi-file publication is **not atomic**. If a topic commits and the index fails, the panel displays **partial**, with the confirmed files, failed file, safe error code and remaining files. **Refresh receipt** reads records; it never repeats writes. Inspect the current files in Settings, then start a fresh turn to reconcile. Do not automatically retry or roll back. An unknown write result means no confirmed commit for that file, not proof that nothing happened.

Human edits during approval cause a CAS conflict and remain intact. Topic reads, retries and the index use one snapshot per turn; a committed correction becomes readable in the next turn. A changed policy or cancelled native approval cannot publish the old candidate. If an operator changes the memory setting, the live file provider remains the policy authority.

The MVP handles up to 16 existing flat Markdown files, 128 KiB total inspected content, 16 finding groups and eight replacements per review, with a 240,000-byte encoded snapshot/review ceiling below the tool-result JSON limit. It fails clearly on larger inputs; reduce memory manually first. It does not create new topics, move memory, merge workspaces, change user memory, scan other sessions, or run background consolidation. Model quality and detecting genuinely obsolete preferences need human judgment.

## Privacy and removal

The Loop reads the Host turn view before any memory operation; the existing memory-private marker keeps session exports and telemetry structural. The panel reads complete authorized tool records through the current session SDK, never truncated transcript previews or a global store. No report artifact, telemetry stream, network connector or second memory writer is added. A configured model receives the selected workspace memory for the requested analysis; use a local model when that content must stay on the machine. The existing platform limitations in [Learned memory](memory.md) still apply.

Disable or uninstall the plugin through Settings → Plugins. Its registrations and panel are released; existing memory files remain under the file provider and can be inspected in Settings. Saved sessions keep their pinned backend, while UI compatibility follows the installed version; unavailable older tool records show a readable fallback.
