# User questions

`ask_user_question` registers a durable request through public extension events and projections. The public `before_step` park directive pauses inference; an ordinary validated user message wakes it. The projection reconstructs answers from ledger events. Web and TUI consume the typed `tool.card.inline` question payload. See [default tools](../../../../docs/reference/default-tools.md) for single-choice, multiple-choice and free-text inputs.

No approval grant or filesystem authority is created by answering a question. Invalid replies leave the request pending. `@agnes/protocol` exports `answerPrefix` and `parseAnswer` for clients implementing the same answer envelope.
