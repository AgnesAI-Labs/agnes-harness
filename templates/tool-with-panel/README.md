# __PACKAGE_NAME__

AGH tool-with-panel starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Use `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.

After activation, ask a new session to call __TOOL_NAME__ with {"message":"hello"}. Inspect the tool record for the structured result. Update effect and replay metadata when adding I/O.

Open the printed AGH Web URL, create a new session after activation, and find the sidebar text starting with `__PACKAGE_NAME__:`. Existing sessions retain their previous frontend generation. Backend status does not prove the panel rendered; check it in the browser.
