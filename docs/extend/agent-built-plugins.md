# Build a plugin by asking the agent

English | [简体中文](agent-built-plugins.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Testing](testing.md)

Ask a tool-capable model to implement a reusable tool or Skill, including deterministic tests. The Demo can reproduce explicit `call <tool> <JSON>` instructions offline; it does not autonomously design code.

Agent-authored files follow **candidate → tests → permission decision → publish**. The Host saves bounded text trees in the profile’s private `.authoring-candidates` area. Discovery never loads that area, including when a custom discovery root points inside it. Creating a candidate does not install it; submitting under full access can publish it automatically.

Candidate author tests keep the Host OS sandbox on macOS/Linux and run against a disposable candidate copy. A missing POSIX sandbox refuses execution. Windows remains unisolated. Under full access, all platforms automatically allow the exact-hash test decision; the `workspace-write` permission still shows the package, hash, execution mode, risk and scope for one confirmation. Changed hashes refuse stale authority. The decision is retained in `candidate-test-audit.jsonl`; testing alone never publishes. Submitting a passing candidate under full access completes the existing installation, trust, enablement and runtime activation transaction automatically.

With the resolved session permission `full-access`, every permission decision is automatically allowed on every platform, without approval prompts. This includes candidate tests and publication (install/trust/enable and capability changes), Skill imports, MCP registration/start, ask-mode memory writes, credential administration requested through tools, principal approvals and interactive verifier gates. Each decision retains its actor, exact operation binding and reason `full-access`; Trace and execution evidence show **Auto-allowed (Full access)**. Other permission levels retain their normal human review flow.

Read the [generated author reference](../reference/plugin-author-api.md) returned by both guides before choosing APIs or tokens. `apply(ctx)` registers PluginContext facets; `execute(args, ctx)` receives ToolContext. Workspace files use `ctx.fs.read/write` (bytes/string), while plugin/app profile data uses optional `ctx.store` with reviewed `capabilities.store: true`. `PluginContext.fs.readText/writeText` does not exist.

Choose `tool-with-panel` for a tool with its own UI panel; it reuses the existing scaffold. When offered, initialize it once with `plugin_scaffold({template: "tool-with-panel", name: "my-agh-plugin"})`, which saves the complete manifest, client and tests. Guide `previewFiles` omit files and must not be transcribed as a candidate tree; alternatively, only if `run_code` is offered in this request, use it to pass the full guide `files` array to `plugin_helper_create`. If a candidate already exists, add the missing client, descriptor and tests to that same candidate. Read the candidate, then use `mode: "merge"` with only changed files; untouched manifest, client and tests are retained. The creator guide includes an executable cell example. Every edit invalidates earlier tests: run `plugin_test` against the final `candidateHash`.

Use `@agnes/host/author-testkit` and `createPluginTestHost(main)` for real Host registration and `host.invoke(name, args)` tests. Supply explicit invocation I/O ports through `options.context` when needed; a hand-made PluginContext mock does not verify installation. Use the controlled candidate runner; piping `node --test` into `tail` hides its exit status. Backend tests never establish browser appearance.

The `tool-with-panel` starter is a complete small to-do example: React ESM imports, a profile page, declared query/effect services and shared owner-store persistence. Its inherited tests exercise DOM add/toggle/errors through the real client facade and data retention after Host recreation. Use the [author reference](../reference/plugin-author-api.md) and template using only public author APIs and authorized workspace/artifact references. Never search Host/installed source, other workspaces, environment variables or credentials. There is no browser `ctx.tools.invoke`; use `ctx.profile.services` with exact names in `client.services`. `present` accepts a workspace filesystem path, never an `artifact://` reference.

## Keyless Demo exercise

Use the isolated home and workspace from the [quickstart](quickstart.md). Create a **Demo** session in Web, submit `create a plugin`, and confirm the tool approval to save its candidate. Demo copies the version-matched text statistics example; it does not design new code for your request. `agh -p` has no interactive permission handler and rejects the authoring call; do not bypass this by weakening policy.

Inspect the generated source and tests in the candidate list. Note the returned `proposalId` (the `candidateId`), then submit these messages in the same Web session, replacing `CANDIDATE_ID` with the actual value and confirming the single exact-hash test-execution card when required by your permission preset:

```text
call plugin_helper_install {"action":"test","proposalId":"CANDIDATE_ID"}
call plugin_helper_install {"action":"commit","proposalId":"CANDIDATE_ID"}
```

Before using the CLI review commands below, confirm `state: review`, `tests.state: passed` and `tests.count >= 1`. A draft has `reviewHash: null` and cannot be approved directly. After publication, submit `call my_text_stats {"text":"hello world"}` in a new session; expect `{"characters":11,"words":2}`. The [growing-skills demo](../../examples/demos/growing-skills/README.md) also provides an isolated offline exercise.

The recommended authoring path is **guide → create once → read/write the same candidate → test its exact hash → submit for human review**. Use `plugin_helper_guide` and `plugin_helper_create`, then `plugin_candidate_read/write`, `plugin_test` and `plugin_install_local` when present in the current catalog. The helper’s older names remain compatibility aliases for the same service and candidate, not a separate workflow. The keyless Demo above exercises these aliases.

The default **Plugin Helper** exposes four tools:

1. `plugin_helper_guide` (`kind: tool|tool-with-panel|skill|skin`) returns a version-matched JavaScript template and Node contract test. Implement the requested behavior and strengthen the test, including invalid inputs.
2. `plugin_helper_create` (`files: [{path, content}, …]`) writes only to the Host candidate area and returns `proposalId` (the candidate ID), `candidateHash` and `draft` state. Creation uses the same text-candidate contract as the builtin scaffold, including its TypeScript panel template; it never executes lifecycle scripts.
3. `plugin_helper_install` (`action: test`, `proposalId`) uses the session policy described above before executing Node author tests against a private copy of that exact tree. `action: commit` submits passing results for review; `action: status` reads the durable candidate. Commit publishes automatically under full access; other permission levels submit for human review. Old onboarding proposal IDs require a fresh candidate.

4. `plugin_helper_write` aliases `plugin_candidate_write` with the same `candidateId`, required `expectedHash`, `mode`, `files` and optional `remove`.

For newly authored Markdown, `skill_helper_create` also writes a reviewed Skill package candidate; `skill_helper_install` uses test/commit/status for its candidate ID. Authored packages publish in this profile; code stays pinned per session and approved Skill resources refresh live; creation no longer accepts the old workspace/user scope or install-only flags. Importing existing Skills retains its workspace/user import approval workflow.

The builtin `agnes/plugin-creator` tools also provide `plugin_scaffold` (tool, tool-with-panel, mcp-skills, model-adapter, loop or skill), `plugin_candidate_read`, `plugin_candidate_write`, `plugin_test` and `plugin_install_local`. `plugin_creator_guide` includes the same recommended path and reports whether the Host port is supplied; supplied does not promise authorization. `plugin_scaffold` is an alternative initial template step, also recommended for copying the complete panel template when it is offered. Writes require the previous `candidateHash` as `expectedHash`; recommended `mode: "merge"` retains untouched files, while default `replace` rewrites the complete tree; `plugin_install_local` submits the tested hash for human review. It never copies code into a discovery root.

Both tool sets use the same Host-bound candidate service: a draft created by `plugin_helper_create` can be continued with `plugin_candidate_read` and `plugin_candidate_write`, using its existing ID and current hash. The Host records the actual calling package, its snapshot (or the builtin session’s pinned code generation), row and row lease, and checks each tool invocation’s lifetime. Subagents, cancelled or expired invocations, and callers without current owner authority cannot use this port. Builtin authoring tool errors identify the operation, stage and candidate ID, and distinguish unavailable Host capability, permission denial, stale hashes and validation failures. An unavailable capability does not mean an administrator disabled authoring; retain the draft and report the failed operation.

## Report evidence and deliver a complete package

Restate each actual receipt’s `operation`, `stage` and `candidateId`. If create succeeded and write later reports `unavailable-host-capability`, say that the draft was created and **write** failed; keep the same draft. Read its current hash before continuing. Never recreate it just to recover from a later-stage failure, infer an “admin disabled” setting, invent switches, or use shell/config edits to bypass a refusal. Create another draft only when the human explicitly requests one.

Candidate tool summaries expose `verification`; it is a conservative display projection, not new durable state. Report these stages separately:

| Stage | Required evidence |
| --- | --- |
| Draft generated | A successful create receipt with candidate ID/hash |
| Structure validated | Explicit inspection evidence with no blockers, such as the submitted review preview or successful package packing; a draft receipt alone does not expose this evidence |
| Candidate test passed | `tests.state: passed`, matching candidate hash and at least one executed test |
| Install verified | Actual installed/runtime evidence; a `published` receipt includes runtime confirmation |
| Browser/appearance verified | Browser observation for the installed skin in light and dark mode, then disable and restore default appearance |
| Published | An actual `state: published` receipt after human review |

The skin template’s Node test checks entry/manifest/descriptor/asset structure only. JSON/path/CSS string assertions never prove installation or appearance. Candidate results always mark browser appearance **not verified**; report a later browser check separately with its evidence. If it cannot run in this session, explicitly say “browser/appearance not verified” and give the human the light/dark and disable/restore checklist. Passing source tests do not justify saying “the skin is fine”.

Before giving installation commands, verify the actual CLI executable/version and help, effective `AGH_HOME`, profile and daemon startup workspace; do not display credentials. This version has `agh dev <plugin-folder>`, `agh plugins add` and `agh plugins pack`. `dev` accepts a folder below the daemon startup workspace and follows normal management review. Its existence does not authorize agent self-installation, and there is no general requirement to stop the server.

For a downloadable result, read **all** `sourceFiles` from the same candidate/hash with `plugin_candidate_read`; reconstruct paginated JSON completely before copying. Use ordinary authorized workspace writes to stage every file at its relative path in a new directory outside discovery roots and the private AGH home. Never execute the entry or package lifecycle scripts. Then use the verified version of the existing pack command:

```sh
agh plugins pack <staging-folder> <new-output.tgz>
```

This invokes `plugin-pack.ts`, validates the distributable tree and creates a directory archive. A skin includes `package.json`, `index.mjs`, its descriptor and every relative asset; packing also adds the bundled entry selected by the packed manifest. Keep the output outside the staging directory. After successful packing, call `present` with `files: [{path: "<workspace-output.tgz>", description: "Complete plugin package; installation and appearance checks remain separate"}]`. It offers one durable download (maximum 32 MiB). Loose CSS/JSON cards and `candidate-source.json` are source previews, not installable packages. If authorized workspace writes, pack or present are unavailable, report delivery as incomplete and preserve the candidate. Downloading does not install, trust, enable or publish; the human uses the existing admin flow.

The binding takes effect when the updated Host assembles the tools. Already-running workers retain their assembled capabilities until restarted normally. Retained sessions keep their code pins; reopening does not rewrite them or upgrade their pinned tool code. Existing candidates and hashes remain readable, including drafts created through the helper. No draft cleanup or publication happens during this update.

For large packages, keep each reply's new file text at most 8 KiB and finish one file at a time. Read the same candidate, then write only changed files with `mode: "merge"`. Use `remove` for explicit deletions. Optional `run_code` automation may be used only when actually offered in the current request; catalog metadata alone does not establish availability. After `OUTPUT_LIMIT`, read and continue the existing candidate in smaller pieces: the unfinished call was discarded. Re-test the final hash before review.

In **Plugins → To review → Drafts**, select a draft from the list; status chips distinguish awaiting review, rejected and published candidates. The summary shows the plugin, originating session and turn, test result and new permissions. Expand each file to inspect added and removed lines; long files scroll within the diff. **Technical details** is collapsed by default and contains the candidate, installed base, review and test hashes, raw capability changes, session/tool IDs and test output. The review footer keeps **Approve and publish** and **Reject candidate** visible while you inspect the changes.

Run tests only after inspecting the source: candidate author tests use the Host sandbox described above, with a stripped environment, bounded time/output and cancellation. Published backend plugins remain trusted in-process code. The runner uses Node 24 and the public author SDK; it never runs package lifecycle scripts or treats Markdown as a command. Tests must pass with at least one executed case.

Submit the tested tree, then choose **Approve and publish** or **Reject** in the existing confirmation dialog. Approval binds both the candidate hash and the immutable review hash. Any draft edit, damaged review copy or changed installed base refuses the old approval; re-test and request a fresh review. Failed tests and rejected candidates cannot publish. New capabilities require a fresh human approval under the installation’s normal capability policy.

For CLI review:

```sh
agh plugins candidates list --json
agh plugins candidates show <candidate-id> --json
agh plugins candidates approve <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
agh plugins candidates reject <candidate-id> --candidate-hash <sha256> --review-hash <sha256>
```

Take both hashes from the review you inspected. CLI does not silently approve the latest edited draft. App Server exposes `_agnes/v1/plugins.candidates.{list,show,create,write,test,submit,approve,reject}`; create/write require the Host-stamped authoring lane, and the agent cannot approve/reject itself. The protocol schemas own these methods and persisted provenance.

Publication uses normal package install/update, trust, enable and generation reconciliation. A `published` result requires the runtime to report the reviewed integrity as running. New sessions gain the plugin code; existing sessions keep their pinned code generation. Approved Skill Markdown is a live resource and can become visible to existing sessions as well. Provenance retains `installer=agent`, author session/turn and reviewer. A failed or interrupted publication is never automatically replayed; inspect actual package state before creating a new candidate.

Markdown Skills are package data: review their full text with the plugin snapshot. A script mentioned by a Skill still needs normal tool approval. Human-maintained [local plugins](local-plugins.md) and [hot reload](hot-reload.md) remain explicit developer trust paths; the authoring helper never writes drafts there. Already-authorized shell access retains its ordinary filesystem authority.

Candidate trees are text-only (64 files, 128 KiB per file, 256 KiB total), with 128 durable candidates per profile. Failed creation removes its unpublished tree; unreadable or damaged entries are isolated from listings. Incomplete directories without a valid record do not consume the durable-candidate quota. Binary assets and dependency installation use the normal author/package workflow. There is no candidate garbage collection command yet. Bundled implementation: `packages/package-manager/bundled-plugins/plugin-helper`; creator assets: `node packages/base/extensions/plugin-creator/gen-assets.mjs`.

Web shows pending candidates first and keeps published, rejected and interrupted reviews in collapsed history. Successful publication closes the review detail and shows a link to the installed Skill or plugin. Terminal reviews retain their files and provenance without approve/reject controls.

Authoring receipts include bounded, allowlisted `diagnostics` (reason code, package-relative path, field, offending name and fix hint). Validation and test failures expose actionable details in ordinary tool text; test output is redacted and truncated with `[truncated]`. Read the same candidate (through `run_code` only when offered) to inspect the full bounded `tests.output`. Passing test receipts stay concise. Timeouts and nonzero process exits retain bounded partial output through the same redaction path; they remain failed tests even if that output contains passing TAP lines.

`candidate.write` supports explicit `mode: "merge"`: listed `files` add or replace paths, `remove: [paths]` deletes existing files, and untouched files stay. `files: []` allows deletion-only merges. A path in both lists or a non-existent removal returns `conflicting-write-path` or `missing-remove-path` with the relative path. Required `expectedHash` binds the current full tree; the result returns the new full-tree hash. All path, text, file-count and byte limits apply to the resulting tree. Default `mode: "replace"` preserves whole-tree replacement compatibility; it accepts no removals and must contain every file you want to keep.

`writeSummary` lists added, removed and changed files, declared entries and missing files. Incomplete drafts remain drafts; removing `package.json` or an entry warns, and test/submit refuse. Repeated identical content or rejection prompts a read without a retry cap. Every accepted write clears test and human-review evidence.
