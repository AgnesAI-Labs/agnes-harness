# Interaction

`ask_user_question` preserves its single/multiple/free-text parameters and durable `timeoutMs` deadline (0–60000 ms). It invokes the ordinary `ui_render` tool to publish a preset form in the conversation and workbench. Answers use authenticated `ui.action` and the ordinary deferred `ui_submit` tool; direct model calls cannot produce a human reply. The successful action closes the form. Late answers are delivered through the existing SC1 queued-input path with the authenticated actor and untrusted content. An answer never grants tool permission.

The question projection records durable requests and successful surface actions. Text clients use numbered choices with the same action request, or the authenticated Web link when their transport cannot submit actions. No special slot payload or answer-message prefix is involved. See [default tools](../../../../docs/reference/default-tools.md).
