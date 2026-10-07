# User questions

`ask_user_question` registers a durable request through public extension events and projections. `timeoutMs` defaults to zero (immediate continuation) and accepts up to 60000 ms. Positive waits use the persisted deadline and end on an answer, timeout or cancellation; sibling calls remain allowed. Late answers enter as ordinary input. The projection reconstructs answers from ledger events. The additive `tool_call` inline-slot trigger exposes the question while the tool is waiting. Web and TUI consume the typed `tool.card.inline` question payload. See [default tools](../../../../docs/reference/default-tools.md) for single-choice, multiple-choice and free-text inputs.

No approval grant or filesystem authority is created by answering a question. Invalid replies leave the request pending. `@agnes/protocol` exports `answerPrefix` and `parseAnswer` for clients implementing the same answer envelope.
