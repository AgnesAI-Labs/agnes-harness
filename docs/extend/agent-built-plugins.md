# Build a plugin by asking the agent

English | [简体中文](agent-built-plugins.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Testing](testing.md)

Ask a tool-capable model to implement a reusable tool or Skill, including deterministic tests. The Demo can reproduce explicit `call <tool> <JSON>` instructions offline; it does not autonomously design code.

Agent-authored files follow **candidate → tests → human review → publish**. The Host saves bounded text trees in the profile’s private `.authoring-candidates` area. Discovery never loads that area, including when a custom discovery root points inside it. Creating or submitting a candidate does not install, trust or enable it.

Candidate author tests run in the Host’s OS sandbox on macOS and Linux, with only a disposable candidate copy writable. Protected paths and the AGH private home are denied; network access follows the session’s isolation rules. A missing POSIX sandbox refuses execution. **Workspace-write / standard** shows one confirmation with the package name, short hash, execution mode, risk and scope; approval authorizes that exact hash once. A changed hash is refused. **Full-access** skips this confirmation only when the effective session policy permits it and OS isolation is actually enforced. **Windows** has no OS isolation and always requires confirmation, including under full-access: “This platform is unisolated; candidate code runs directly on this machine.” Review the source in **Settings → Plugins → Candidates** first. The exact-hash decision is recorded in the private resource-control `candidate-test-audit.jsonl`. Tests do not publish, trust or enable code. Read-only and plan restrictions remain authoritative.

Full access still requires explicit confirmation for installing, trusting or enabling candidates, plugins and Skills, and for capability scope changes. It does not waive memory-write approval in **ask before writing** mode or credential administration confirmations. Protected paths retain their existing hard refusals; full access cannot approve ordinary file-tool access to credentials or private application state. Skill import/install and MCP registration/start approvals are unchanged. Human-maintained local plugin and trusted disk-Skill discovery retain their documented trust paths.

## Keyless Demo exercise

Use the isolated home and workspace from the [quickstart](quickstart.md). Create a **Demo** session in Web, submit `create a plugin`, and confirm the tool approval to save its candidate. Demo copies the version-matched text statistics example; it does not design new code for your request. `agh -p` has no interactive permission handler and rejects the authoring call; do not bypass this by weakening policy.

Inspect the generated source and tests in the candidate list. Note the returned `proposalId` (the `candidateId`), then submit these messages in the same Web session, replacing `CANDIDATE_ID` with the actual value and confirming the single exact-hash test-execution card when required by your permission preset:

```text
call plugin_helper_install {"action":"test","proposalId":"CANDIDATE_ID"}
call plugin_helper_install {"action":"commit","proposalId":"CANDIDATE_ID"}
```

Before using the CLI review commands below, confirm `state: review`, `tests.state: passed` and `tests.count >= 1`. A draft has `reviewHash: null` and cannot be approved directly. After publication, submit `call my_text_stats {"text":"hello world"}` in a new session; expect `{"characters":11,"words":2}`. The [growing-skills demo](../../examples/demos/growing-skills/README.md) also provides an isolated offline exercise.

The default **Plugin Helper** exposes three tools:

1. `plugin_helper_guide` (`kind: tool|skill|skin`) returns a version-matched JavaScript template and Node contract test. Implement the requested behavior and strengthen the test, including invalid inputs.
2. `plugin_helper_create` (`files: [{path, content}, …]`) writes only to the Host candidate area and returns `proposalId` (the candidate ID), `candidateHash` and `draft` state. The bounded helper accepts self-contained text ESM without dependencies or lifecycle scripts.
3. `plugin_helper_install` (`action: test`, `proposalId`) uses the session policy described above before executing Node author tests against a private copy of that exact tree. `action: commit` submits passing results for review; `action: status` reads the durable candidate. Commit no longer installs. Old onboarding proposal IDs require a fresh candidate.

For newly authored Markdown, `skill_helper_create` also writes a reviewed Skill package candidate; `skill_helper_install` uses test/commit/status for its candidate ID. Authored packages publish in this profile; code stays pinned per session and approved Skill resources refresh live; creation no longer accepts the old workspace/user scope or install-only flags. Importing existing Skills retains its workspace/user import approval workflow.

The optional `agnes/plugin-creator` extension also provides `plugin_scaffold` (tool, tool-with-panel, mcp-skills, model-adapter, loop or skill), `plugin_candidate_read`, `plugin_candidate_write`, `plugin_test` and `plugin_install_local`. Writes replace the complete text tree and require the previous `candidateHash`; `plugin_install_local` submits the tested hash for human review. It never copies code into a discovery root.

Both tool sets use the same Host-bound candidate service: a draft created by `plugin_helper_create` can be continued with `plugin_candidate_read` and `plugin_candidate_write`, using its existing ID and current hash. The Host records the actual calling package, its snapshot (or the builtin session’s pinned code generation), row and row lease, and checks each tool invocation’s lifetime. Subagents, cancelled or expired invocations, and callers without current owner authority cannot use this port. Builtin authoring tool errors identify the operation, stage and candidate ID, and distinguish unavailable Host capability, permission denial, stale hashes and validation failures. An unavailable capability does not mean an administrator disabled authoring; retain the draft and report the failed operation.

The binding takes effect when the updated Host assembles the tools. Already-running workers retain their assembled capabilities until restarted normally. Retained sessions keep their code pins; reopening does not rewrite them or upgrade their pinned tool code. Existing candidates and hashes remain readable, including drafts created through the helper. No draft cleanup or publication happens during this update.

For large packages, keep each reply's new file text at most 8 KiB and complete one file or uniquely marked section at a time. A write still replaces the full tree, so do not send only changed files. When `run_code` is available, read the current candidate inside the cell, update `sourceFiles` programmatically, and write the full array with its fresh hash; print only the returned hash. The bundled `plugin_creator_guide` includes a small cell example. If code tools are unavailable, keep the full draft within the output allowance or configure a supported higher `model.max_tokens`. After `OUTPUT_LIMIT`, read and continue the existing candidate in smaller pieces: the unfinished call was discarded. Re-test the final hash before review; neither a partial draft nor an output-limit notice is a passing test.

In **Settings → Plugins → Candidates**, select a draft from the list; status chips distinguish awaiting review, rejected and published candidates. The summary shows the plugin, originating session and turn, test result and new permissions. Expand each file to inspect added and removed lines; long files scroll within the diff. **Technical details** is collapsed by default and contains the candidate, installed base, review and test hashes, raw capability changes, session/tool IDs and test output. The review footer keeps **Approve and publish** and **Reject candidate** visible while you inspect the changes.

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
