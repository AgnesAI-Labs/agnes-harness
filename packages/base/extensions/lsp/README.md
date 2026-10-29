# LSP diagnostics

Starts language servers (TypeScript/JavaScript, Python, Go, Rust) lazily, one per session and project root, through `ctx.sandbox.openProcess`, so they run under the same session policy as shell commands. The `lsp_diagnostics` tool reports their errors on request; `write` and `edit` (in `tools-core`) call `LspSessions.diagnosticsFor` and append errors for the file they just changed.

The registry is a module-level object shared with `tools-core` the way the shell jobs registry is. It stays inactive until this extension applies, so a preset without `agnes/lsp` starts no process. Servers are found on `PATH` only; workspace-local binaries (`node_modules/.bin`, `.venv/bin`) are not used because a tool context carries no workspace-trust signal. Servers get an allowlisted environment (no credentials). Caps: 3 per session, 4 per worker, closed after 10 idle minutes; a server that fails to start or exits is not retried for 3 minutes.

See the [LSP diagnostics guide](../../../../docs/guide/lsp.md).
