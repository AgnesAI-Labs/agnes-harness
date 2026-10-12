---
name: plugin-creator
description: Draft, test and submit an Agnes plugin or Skill for human review.
---

# Grow a capability under human review

Use the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) to choose helpers, contracts and service kind tokens. Keep testkit imports in tests; do not compose the legacy plugin-runtime/testkit + host/testkit pair.

1. Describe observable inputs, outputs, errors and side effects. Prefer the `tool` template; choose `skill` for reusable Markdown instructions. For a staged business agent, choose `loop` and `defineWorkflowLoop` from `@agnes/plugin-runtime`: write business stages and use its confirmation, checkpoint, approval continuation and structured input-stage support instead of copying a scheduler. See the [workflow guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/workflow-loops.md).
2. Call `plugin_scaffold` with `template` and lowercase package `name`. It returns a Host-owned candidateId and candidateHash. The candidate stays outside discovery roots and is never automatically installed or activated. The legacy directory hint does not select a filesystem destination.
3. Use `plugin_candidate_read`, then `plugin_candidate_write` with candidateId, expectedHash and the complete files array. Keep public API ranges and honestly declared capabilities. Every change clears tests and any earlier review. Do not write drafts to `.agh/plugins`, user plugins or Skill discovery directories.
4. Extend observable Node tests (`*.test.mjs` or `*.test.ts`). The Host supplies the public author SDK and `@agnes/host/author-testkit`: use `createPluginTestHost(plugin)` with its real Host registration, `scriptedModel(replies)` or `driveLoop(factory, { replies, tools })`. No paid model is needed. Do not fake test results or remove meaningful assertions. The fixed runner compiles tests and runs Node’s test runner; arbitrary npm lifecycle scripts are not run.
5. Call `plugin_test` with candidateId and expectedHash. The local user must approve test code execution. A refused/cancelled/failed test cannot authorize publication. Tests run a private copy, and both that copy and the draft must retain the same hash afterward.
6. Call `plugin_install_local` with candidateId and expectedHash. Despite its legacy name it only submits an immutable review, including baseline hash, file diffs, capability delta, exact-hash tests and Host-stamped session/tool provenance. It never installs or enables code.
7. Ask the user to open Settings → Plugins → Candidates. They inspect the diff, permissions, tests and provenance, then approve and publish or reject. Any candidate change invalidates the old review; retest and resubmit. Only human administration can publish; the agent authoring port cannot approve its own work.
8. Publication uses the normal package install/update, trust, enable and generation path. Verify the actual package status and try the capability in a new session. Existing sessions retain their pinned generation. Failed/interrupted publication is reported honestly and is not resumed automatically from old approval.

Ordinary author tests and backend plugins execute trusted Node code on this machine; this workflow does not sandbox arbitrary code. Review source before approving tests or publication. Skill text is read as data, never interpreted as shell; running its scripts still requires normal tool approval.

Build large packages in separate replies, with at most 8 KiB of new file text per reply. Start with a small valid scaffold, then finish one file or uniquely marked section at a time. `plugin_candidate_write` replaces the complete tree: never send only changed files. If `run_code` is offered, read the current candidate inside each cell, modify its `sourceFiles` programmatically, and write the complete array with the fresh `candidateHash` as `expectedHash`. Return only the new hash; keep unchanged text out of model output. Normal approvals and candidate limits still apply. If code tools are unavailable and the full tree exceeds the response allowance, simplify the package or ask for a supported higher `model.max_tokens` instead of emitting a truncated package.

Minimal TypeScript cell pattern (replace the candidate ID and use a path/unique marker observed in the current candidate):

```ts
const candidateId = 'CANDIDATE_ID';
const unpack = (result) => {
  if (result.isError) throw new Error('Candidate operation refused');
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
};
const current = unpack(await tools.plugin_candidate_read({candidateId}));
const path = 'skills/example/SKILL.md', marker = '<!-- next-section -->';
const target = current.sourceFiles.find((file) => file.path === path);
if (!target || target.content.split(marker).length !== 2) throw new Error('Read the current path/marker again');
const files = current.sourceFiles.map((file) => file.path === path
  ? {...file, content: file.content.replace(marker, 'A complete small section.')}
  : file);
const updated = unpack(await tools.plugin_candidate_write({candidateId, expectedHash: current.candidateHash, files}));
return {candidateId, candidateHash: updated.candidateHash};
```

After OUTPUT_LIMIT, the unfinished tool call was discarded. Read and continue the same candidate; inspect which sections persisted, add smaller complete pieces, then run tests on the final hash and submit review. Do not scaffold a duplicate, assume the discarded call wrote anything, or claim tests/review succeeded.
