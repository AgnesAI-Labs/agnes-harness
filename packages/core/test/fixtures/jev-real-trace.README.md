# Real Jev/Flash projection capture

`jev-real-trace.json` comes from a completed remote Jev and DeepSeek V4 Flash run
on 2026-10-02 through the Agnes SDK, daemon, worker, Host and actual filesystem
tools. The input files and task were created specifically for this test. The
original private capture stays outside the repository; its SHA-256 is recorded
in the fixture provenance. No credentials are retained.

The run read `source.txt`, wrote `copy.txt`, read it back and produced a final
answer. The destination **lost the trailing newline**, although the answer
claimed equality. `observedFiles` records the filesystem bytes independently of
the model's claim. Successful dispatch and turn completion do not prove task
correctness.

Session identity, private endpoint and absolute paths are replaced consistently.
Non-user context, language request bodies and duplicated model response snapshots
are omitted as listed in `provenance`. Event sequences, causal references,
decisions, candidate manifests, tool calls/results, model outputs and usage are
preserved. This is a presentation/trace regression fixture, not a full runtime
recovery fixture or evidence that future live model calls will choose identically.

The capture predates the Host root observation/candidate fix: all three tool calls
used LLM parameters. Keep this historical behavior observable rather than editing
the captured choices to describe the repaired implementation.

`jev-real-cancel.json` records a second real run. A permission request was held
before approval; the first marker file did not exist while it was pending.
After approval, the shell wrote that marker and began a 30-second sleep. The SDK
cancelled the session, the second marker was absent, and the committed runtime
settlement retained `effect: unknown` with the session parked. The fixture keeps
the approval/dispatch/settlement ordering; cancellation is not proof that an
already dispatched mutation had no effect. It uses the same redaction rules.

`comparison-real-cancel.json` records an actual Native/Jev comparison. Both
lanes accepted the same input before running. The SDK cancelled only Native
after receiving its first real thinking preview; Jev continued to completion.
The persisted result is partial, with left cancelled and right finished. Both
complete lane event sequences are retained. `replayProjections` are computed by
Core `projectUI` over these sanitized events at the stated inclusive sequence
boundaries. They are derived test inputs, not additional provider observations.
No historical ordering between the independent lane ledgers is invented.

`jev-real-answer-preview.json` preserves a pre-fix direct-answer regression:
the SDK received 719 real provider preview frames, but the first committed UI
projection had no streaming assistant anchor to receive them. The run read the
test file and completed through the actual `answer` path, not arbitration.
Preview frames are transient observations, stored separately from the durable
events. Identity/path redactions and omitted duplicate context are listed in
provenance. Do not rewrite this historical capture to pretend the anchor existed.

`comparison-real-journal.json` captures the actual daemon publication order from
a later real Native-cancelled/Jev-finished run. Its 225 global entries include
55 lane references and an explicit baseline checkpoint at local cuts 3/3;
the final frozen cuts are 24/37. Checkpoint-internal interleaving is unknown.
The original event digests were checked against the captured source ledger before
redaction; fixture digests are recomputed over the sanitized events, as declared
in provenance. Repeated coordinator reconciliation facts remain in this capture.

`jev-real-answer-accepted.json` is the later successful real-provider capture:
623 SDK preview frames matched the durable started anchor and the final ledger
adopted one assistant message. Core checks the actual recorded prefix and final
single-node projection; the earlier missing-anchor fixture remains unchanged.

`native-real-cancel-followup.json` records a real Flash cancellation during the
first thinking frame followed by a new prompt in the same Native session. The
second turn completed with one short answer to the new prompt. The fixture
retains durable interrupted content and the actual follow-up user message;
request derivation tests verify that the interrupted assistant prefix survives
replay before that message. Machine runtime context is omitted, as declared
in provenance. This verifies one real continuation, not universal model compliance.

`comparison-real-accounting.json` records two completed Native/Jev rounds, followed
by Native-only synthetic history and real compaction. The first manual compaction
was refused because a 2048-token context could not fit the fixed instructions;
that refusal remains in the ledger. With a valid 16384-token context, compaction
completed. The Native ledger contains five inference calls, one title call and
three compaction calls, including two concurrent segments under one parent effect.
The Jev ledger contains two decisions, one arbitration, one answer and one title.
Actual provider-call records and per-call costs are retained; expected comparisons
derive from the sanitized events. Reported amounts are estimates, not gateway
charges, and no historical token price is inferred. This capture does not attest
hidden HTTP retries, a live tree-budget hold or auxiliary vision coverage.

`comparison-real-pricing.json` records three real browser form submissions to
Native/Jev with DeepSeek V4 Flash. Native has three inference calls and one title;
Jev has three decisions, three language arbitrations and one title. Eight language
calls contain their actual frozen USD catalog quotes. Their historical estimates
are USD 0.003294528 and USD 0.003516618; separately reported estimated amounts are
3295 and 3516 microdollars. These are estimates, not gateway charges. Jev decision
prices and unattested input buckets remain unknown. A concurrent SDK input was
refused with the bound pre-admission marker and never entered the rounds. Full
private captures and browser observations remain local; this fixture retains
sanitized source events and quotes for accounting regression, not runtime replay.
