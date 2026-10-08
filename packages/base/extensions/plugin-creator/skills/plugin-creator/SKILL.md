---
name: plugin-creator
description: Draft, test and submit an Agnes plugin or Skill for human review.
---

# Grow a capability under human review

1. Describe observable inputs, outputs, errors and side effects. Prefer the `tool` template; choose `skill` for reusable Markdown instructions.
2. Call `plugin_scaffold` with `template` and lowercase package `name`. It returns a Host-owned candidateId and candidateHash. The candidate stays outside discovery roots and is never automatically installed or activated. The legacy directory hint does not select a filesystem destination.
3. Use `plugin_candidate_read`, then `plugin_candidate_write` with candidateId, expectedHash and the complete files array. Keep public API ranges and honestly declared capabilities. Every change clears tests and any earlier review. Do not write drafts to `.agh/plugins`, user plugins or Skill discovery directories.
4. Extend observable Node tests (`*.test.mjs` or `*.test.ts`). The Host supplies the public author SDK and `@agnes/plugin-runtime/testkit`: use `createPluginTestHost`, `scriptedModel(replies)` or `driveLoop(factory, { replies, tools })`. No paid model is needed. Do not fake test results or remove meaningful assertions. The fixed runner compiles tests and runs Node’s test runner; arbitrary npm lifecycle scripts are not run.
5. Call `plugin_test` with candidateId and expectedHash. The local user must approve test code execution. A refused/cancelled/failed test cannot authorize publication. Tests run a private copy, and both that copy and the draft must retain the same hash afterward.
6. Call `plugin_install_local` with candidateId and expectedHash. Despite its legacy name it only submits an immutable review, including baseline hash, file diffs, capability delta, exact-hash tests and Host-stamped session/tool provenance. It never installs or enables code.
7. Ask the user to open Settings → Plugins → Candidates. They inspect the diff, permissions, tests and provenance, then approve and publish or reject. Any candidate change invalidates the old review; retest and resubmit. Only human administration can publish; the agent authoring port cannot approve its own work.
8. Publication uses the normal package install/update, trust, enable and generation path. Verify the actual package status and try the capability in a new session. Existing sessions retain their pinned generation. Failed/interrupted publication is reported honestly and is not resumed automatically from old approval.

Ordinary author tests and backend plugins execute trusted Node code on this machine; this workflow does not sandbox arbitrary code. Review source before approving tests or publication. Skill text is read as data, never interpreted as shell; running its scripts still requires normal tool approval.
