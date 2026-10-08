# Build a plugin by asking the agent

English | [简体中文](agent-built-plugins.zh-CN.md)

[Author guide](README.md) · [Local plugins](local-plugins.md) · [Testing](testing.md)

Ask a tool-capable model to implement a reusable tool or Skill, including deterministic tests. The Demo can reproduce explicit `call <tool> <JSON>` instructions offline; it does not autonomously design code.

Agent-authored files follow **candidate → tests → human review → publish**. The Host saves bounded text trees in the profile’s private `.authoring-candidates` area. Discovery never loads that area, including when a custom discovery root points inside it. Creating or submitting a candidate does not install, trust or enable it.

The default **Plugin Helper** exposes three tools:

1. `plugin_helper_guide` (`kind: tool|skill|skin`) returns a version-matched JavaScript template and Node contract test. Implement the requested behavior and strengthen the test, including invalid inputs.
2. `plugin_helper_create` (`files: [{path, content}, …]`) writes only to the Host candidate area and returns `proposalId` (the candidate ID), `candidateHash` and `draft` state. The bounded helper accepts self-contained text ESM without dependencies or lifecycle scripts.
3. `plugin_helper_install` (`action: test`, `proposalId`) asks explicit permission to execute Node author tests against a private copy of that exact tree. `action: commit` submits passing results for review; `action: status` reads the durable candidate. Commit no longer installs. Old onboarding proposal IDs require a fresh candidate.

For newly authored Markdown, `skill_helper_create` also writes a reviewed Skill package candidate; `skill_helper_install` uses test/commit/status for its candidate ID. Authored packages publish in this profile; code stays pinned per session and approved Skill resources refresh live; creation no longer accepts the old workspace/user scope or install-only flags. Importing existing Skills retains its workspace/user import approval workflow.

The optional `agnes/plugin-creator` extension also provides `plugin_scaffold` (tool, tool-with-panel, mcp-skills, model-adapter, loop or skill), `plugin_candidate_read`, `plugin_candidate_write`, `plugin_test` and `plugin_install_local`. Writes replace the complete text tree and require the previous `candidateHash`; `plugin_install_local` submits the tested hash for human review. It never copies code into a discovery root.

In **Settings → Plugins → Agent candidates**, read the file diff, installed `baseHash`, candidate hash, capability/permission changes, tests and agent session/turn provenance. Run tests only after inspecting the source: author tests execute trusted JavaScript on this machine, with a stripped environment, bounded time/output and cancellation, but are not a sandbox for hostile code. The runner uses Node 24 and the public author SDK; it never runs package lifecycle scripts or treats Markdown as a command. Tests must pass with at least one executed case.

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

Candidate trees are text-only (64 files, 128 KiB per file, 256 KiB total), with 128 candidates per profile. Binary assets and dependency installation use the normal author/package workflow. There is no candidate garbage collection command yet. Bundled implementation: `packages/package-manager/bundled-plugins/plugin-helper`; creator assets: `node packages/base/extensions/plugin-creator/gen-assets.mjs`.
