# Inspect execution evidence

English | [简体中文](fact-chain.zh-CN.md)

[Documentation](../README.md) · [Request traces](system-prompt-trace.md) · [Recovery](sessions.md)

When checking an answer or a deliverable, follow the recorded facts rather than relying on an agent's description of its own work.

## Open the evidence panel

Select **View execution evidence** on a model trace, **View execution record** on a tool, **View source** on a deliverable, or **View drafting session** in plugin provenance. These entries open one workspace panel. Review the recorded request, returned result and linked artifact or candidate; expand **Technical details** for identifiers and hashes. Escape closes the panel and returns focus.

The panel is read only. It never runs a tool, imports old plugin code, changes trust or migrates a session. Reads use the authenticated session owner and exact anchor. A request uses its captured plugin generation, even if the session was later migrated. See [capture privacy and retention](system-prompt-trace.md).

## Read gaps honestly

| Evidence | What it proves |
| --- | --- |
| Recorded request | The retained logical request or supported final transport body; typed unavailability distinguishes a missing transport tap |
| Tool result | Returned content, a refusal/recovery record, or acceptance of a background job; these are different outcomes |
| Artifact reference | A call returned that reference; it does not establish who created a mutable workspace file |
| Candidate provenance | The recorded drafting session, tested/reviewed hashes and publication state |
| External completion | Unknown without a real external receipt; a model's claim is insufficient |

Missing history, expired captures, unavailable code versions and unproven model-to-tool links are displayed as gaps. Reads fix a ledger watermark and are bounded; a partial graph is labelled incomplete, not filled with invented links. No external exactly-once guarantee follows from the graph.

For SDK access, use `client.factChain(params)` or `session.factChain(anchor, laneId)`. Exact bounds, ownership checks and frontend linking contracts are maintained in [request traces → Execution evidence](system-prompt-trace.md#execution-evidence) and the [App Server schema](../reference/app-server.md).
