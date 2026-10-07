# Model adapters

Optional adapters registered through `modelAdaptersPlugin` (`inject: ["modelAdapters"]`). No network or credentials are needed for `scripted` and `replay`.

- `scriptedAdapter.create(config)` reads an absolute `route.compat.file` containing `{ "schemaVersion": 1, "replies": [[{ "type": "text_delta", "delta": "Hello" }, { "type": "usage", "tokens": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0 }, "creditSource": "estimated" }, { "type": "done", "reason": "stop" }]] }`.
- `recordModelResponses(instance, absoluteFile)` wraps any model adapter instance. It exclusively creates a mode-0600 JSONL file of v1 model response records. Requests contain prompts, never adapter credentials; keep traces private. Dispose the wrapper to close its file and upstream instance.
- `replayAdapter.create(config)` reads `route.compat.file`. Default `match: "strict"` compares kind, slot, system, messages, tools and sampling, ignoring routing, session id and derived hashes. Explicit `match: "sequence"` supplies the same responses to changed loops/compaction prompts. Exhaustion and incomplete records fail; nothing falls through to a paid model.

Each new session gets its own response cursor. One trace must contain one model route; set `compat.recordedSession` when a file contains several recorded sessions. Concurrent invocations in one session route are refused. Replies must end in one `done` or `error`; aborted invocations consume their cursor. There is no timing simulation. Token and tool-call events are preserved.

These are real adapters, usable in profile package rows and registry catalogs. `defineModelAdapter` is consumed from the public plugin runtime. Host profile composition owns route/model selection.
