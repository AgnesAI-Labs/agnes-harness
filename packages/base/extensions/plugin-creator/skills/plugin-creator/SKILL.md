---
name: plugin-creator
description: Draft, test and submit an Agnes plugin or Skill for publication under the session permission policy.
---

# Grow a capability under the session permission policy

Use the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) to choose helpers, contracts and service kind tokens. Keep testkit imports in tests; do not compose the legacy plugin-runtime/testkit + host/testkit pair.

1. Describe observable inputs, outputs, errors and side effects. Use `tool-with-panel` when the user asks for backend tools with their own UI panel; use `tool` for backend operations alone; choose `skill` for reusable Markdown instructions. For a staged business agent, choose `loop` and `defineWorkflowLoop` from `@agnes/plugin-runtime`: write business stages and use its confirmation, checkpoint, approval continuation and structured input-stage support instead of copying a scheduler. See the [workflow guide](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/workflow-loops.md).
2. Follow the recommended path in the accompanying authoring guidance: `plugin_helper_guide` → create ONE initial candidate → `plugin_candidate_read/write` → `plugin_test` → `plugin_install_local`. For a new backend tool, prefer `plugin_scaffold` once with `template: "tool"` (or `"tool-with-panel"` for a tool with its own UI) and a lowercase package `name`: it saves the complete manifest and tests. Other supported templates are `mcp-skills`, `model-adapter`, `loop` and `skill`; otherwise create the candidate once with `plugin_helper_create`. For a CSS skin, use `plugin_helper_guide(kind: "skin")` only if that tool appears in the current tool catalog; otherwise report the missing capability. The skin guide returns files; pass the complete array to `plugin_helper_create` once. Creation returns a Host-owned candidateId and candidateHash. The draft stays outside discovery roots. Submission can publish it automatically under full access. The legacy directory hint does not select a filesystem destination.
3. Use `plugin_candidate_read`, then `plugin_candidate_write` with candidateId, required expectedHash, mode: "merge" and only changed files. Optional remove lists existing paths to delete; untouched files stay. A path in files and remove or a missing removal is refused. plugin_helper_write is the same alias. Default mode: "replace" is reserved for whole-tree rewrites, including every unchanged file. Keep public API ranges and honestly declared capabilities. Every change clears tests and any earlier review. Do not write drafts to `.agh/plugins`, user plugins or Skill discovery directories.
4. Extend observable Node tests (`*.test.mjs` or `*.test.ts`). The Host supplies the public author SDK and `@agnes/host/author-testkit`: use `createPluginTestHost(plugin)` with its real Host registration, `scriptedModel(replies)` or `driveLoop(factory, { replies, tools })`. Supply `options.context` only for explicit invocation I/O ports. A hand-made ctx mock is not install verification. Use the controlled runner; do not pipe Node test output to tail, which hides its exit status. No paid model is needed. Do not fake test results or remove meaningful assertions. The fixed runner compiles tests and runs Node’s test runner; arbitrary npm lifecycle scripts are not run.
5. Call `plugin_test` with candidateId and expectedHash. One exact-hash confirmation authorizes test execution. Full access automatically allows it on every platform, retaining OS isolation where available; Windows remains unisolated. A refused/cancelled/failed test cannot authorize publication. Tests run a private copy, and both that copy and the draft must retain the same hash afterward.
6. Call `plugin_install_local` with candidateId and expectedHash. Submission binds baseline hash, file diffs, capability delta, exact-hash tests and Host-stamped provenance. Full access automatically installs, trusts and enables that candidate; other presets submit for human review.
7. Under other presets, ask the user to open Settings → Plugins → Candidates. They inspect the diff, permissions, tests and provenance, then approve and publish or reject. Any candidate change invalidates the old review; retest and resubmit. Full access authorizes automatic publication through the same transaction and records the system decision.
8. Publication uses the normal package install/update, trust, enable and generation path. Verify the actual package status and try the capability in a new session. Existing sessions retain their pinned generation. Failed/interrupted publication is reported honestly and is not resumed automatically from old approval.

Candidate author tests use the Host OS sandbox on macOS/Linux: only the disposable candidate directory is writable, protected/private paths are denied, and network follows session isolation rules. A missing POSIX sandbox refuses execution. Windows runs unisolated; full access automatically allows the exact-hash decision, while other presets require confirmation. Published backend plugins remain trusted in-process Node code. Review source before approving tests or publication. Skill text is read as data, never interpreted as shell; running its scripts still requires normal tool approval.

Build large packages in separate replies, with at most 8 KiB of new file text per reply. Read first, then use `mode: "merge"` with only changed files and explicit `remove` paths. Preserve inherited tests. The resulting complete tree has the same limits and every edit clears earlier tests/review. Use public author APIs and the version-matched reference; never search Host/installed source, other workspaces, environment variables or credentials. If `run_code` is actually offered in this request, it can automate reading/editing. A catalog entry alone does not prove availability. Direct merge calls work without it.

Only if `run_code` is offered, this optional example can automate a merge edit. Minimal TypeScript cell pattern (replace the candidate ID and use a path/unique marker observed in the current candidate):

```ts
const candidateId = 'CANDIDATE_ID';
const unpack = (result) => {
  const value = typeof result === 'string' ? JSON.parse(result) : result;
  if (!value || value.isError || ['failed', 'interrupted', 'cancelled', 'rejected'].includes(value.state) || value.tests?.state === 'failed') throw new Error('Candidate operation refused');
  return value;
};
let current = unpack(await tools.plugin_candidate_read({candidateId}));
if (current.kind === 'candidate-source-page') {
  const hash = current.candidateHash, total = current.totalBytes;
  let offset = 0, chunks = [], calls = 0;
  while (true) {
    if (++calls > 128 || current.kind !== 'candidate-source-page' || current.candidateId !== candidateId || current.candidateHash !== hash || current.totalBytes !== total || current.offset !== offset || typeof current.data !== 'string') throw new Error('Incomplete or changed candidate');
    const next = offset + new TextEncoder().encode(current.data).length;
    if (next > total || (current.nextOffset === null ? next !== total : current.nextOffset !== next || next <= offset)) throw new Error('Invalid source page');
    chunks.push(current.data);
    if (current.nextOffset === null) break;
    offset = next;
    current = unpack(await tools.plugin_candidate_read({candidateId, offset, expectedHash: hash}));
  }
  current = JSON.parse(chunks.join(''));
  if (current.candidateId !== candidateId || current.candidateHash !== hash) throw new Error('Candidate identity changed');
}
if (current.candidateId !== candidateId || !Array.isArray(current.sourceFiles) || current.sourceFiles.length < 1 || current.sourceFiles.length > 64) throw new Error('Incomplete candidate files');
const path = 'skills/example/SKILL.md', marker = '<!-- next-section -->';
const target = current.sourceFiles.find((file) => file.path === path);
if (!target || target.content.split(marker).length !== 2) throw new Error('Read the current path/marker again');
const files = [{path, content: target.content.replace(marker, 'A complete small section.')}];
const write = {candidateId, expectedHash: current.candidateHash, mode: 'merge', files};
if (new TextEncoder().encode(JSON.stringify(write)).length > 1000000) throw new Error('Full write exceeds the bridge frame budget; simplify the candidate before editing');
const updated = unpack(await tools.plugin_candidate_write(write));
return {candidateId, candidateHash: updated.candidateHash};
```

Source pages bind only the source ID/hash/files, not independently changing test or review metadata. Each page is authorized again. At most 128 page calls leave room within the 256-call code budget; missing pages, cancellation, stale hashes or oversized writes must stop before writing. Model text contains a short status; when offered, `run_code` receives the complete object or source page. Use the returned `artifact://` path with `read`/`grep` for human inspection. A preview storage failure does not undo a successful action. Use merge deltas for editing; do not switch to shell to bypass these limits.

After OUTPUT_LIMIT, the unfinished tool call was discarded. Read and continue the same candidate; inspect which sections persisted, add smaller complete pieces, then run tests on the final hash and submit review. Do not scaffold a duplicate, assume the discarded call wrote anything, or claim tests/review succeeded.
