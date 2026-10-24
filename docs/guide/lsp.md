# Code diagnostics (LSP)

English | [简体中文](lsp.zh-CN.md)

After the agent writes or edits a TypeScript, JavaScript, Python, Go or Rust file, Agnes asks a language server for that file's errors and appends them to the `write`/`edit` result, so the model sees a type error in the same step that caused it. The `lsp_diagnostics` tool does the same on request for other files. The `agnes/lsp` extension is on by default.

## Install the language servers

Agnes never downloads a language server. Install the ones you need and put them on `PATH`; a language without its server is silently skipped. The `PATH` a server is resolved against and started with is filtered: absolute entries only, no duplicates, and nothing inside the workspace or session directory, so the server's own children (`node`, `go`, `cargo`) cannot be repository binaries. Each server is resolved once, the first match counts, and it is launched by its absolute real path; a script with a `#!` line is launched as `[interpreter, script]` with the interpreter resolved the same way, and the server is unavailable if that interpreter cannot be found outside the workspace.

| Language | Server (first found wins) |
| --- | --- |
| TypeScript, JavaScript | `typescript-language-server` (installed together with `typescript`) |
| Python | `pyright-langserver`, then `basedpyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` (trusted workspaces only, see below) |

A server starts the first time a file of its language is edited, once per session and project root (the nearest `tsconfig.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` and similar marker, never above the workspace). The first edit while it starts shows nothing; later edits do. At most 3 servers run per session and 4 per worker; the least recently used idle one is closed when a cap is reached, and any server idle for 10 minutes is closed. A server that fails to start or exits is not retried for 3 minutes.

## What the model sees

- After `write` or `edit`: only errors of the changed file, at most 20 lines and 4 KB, as `LSP found N errors in <path>:` followed by `line:column message (source code)`. Nothing is added when there are no errors. The wait is at most 2 seconds; a slower server adds nothing.
- `lsp_diagnostics`: `{"paths":["src/a.ts","src/b.ts"],"severity":"error"}` with up to 20 paths and `severity` of `error` (default), `warning` or `all`. It returns a summary and up to 50 entries per file, and says why a file could not be checked (server not installed, still starting, remote sandbox).
- Subagent sessions do not get automatic errors on `write`/`edit` (to keep memory down when many run), but can call `lsp_diagnostics`.

## Safety

- Servers run through the session sandbox, under the same policy as shell commands: workspace and admitted extra directories only, `.git` and key directories refused, network per session policy. They get an allowlisted environment (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR` and the Go, Rust and Python location variables) and never model or provider credentials.
- **Static analysis only.** Starting a language server must not be a way to run workspace code without command approval, so every server is started in a mode that executes none, and workspace-local binaries (`node_modules/.bin`, `.venv/bin`) are not used because no workspace-trust signal reaches the tool. TypeScript uses the `tsserver` installed beside the `typescript-language-server` on `PATH` and loads no plugins and does no automatic type acquisition (no `npm`), so a project's own TypeScript version and tsserver plugins are not applied; if no such `tsserver` is found, TypeScript is reported as unavailable. rust-analyzer runs Cargo, and workspace `.cargo/config.toml` (rustc wrappers, build overrides), `rust-analyzer.toml` and `rust-toolchain.toml` can run or select code, so it is not started at all unless the workspace is trusted; since no trust signal reaches the tool yet, the tool reports "Rust analysis needs a trusted workspace (it runs Cargo)". Once available it will run without build scripts, procedural macros, `cargo check` or a `RUSTC_WRAPPER`. gopls runs with `GOTOOLCHAIN=local`, `GOPROXY=off` and `GOFLAGS=-mod=readonly`: it downloads nothing and does not rewrite `go.mod`. Pyright is static already. Full project plugins for untrusted workspaces are not offered; a trusted-workspace mode needs a Host trust signal that does not exist yet.
- Go and Rust servers read module caches outside the workspace (`~/go/pkg/mod`, `~/.cargo`). If the sandbox refuses that, they report nothing or incomplete errors; the sandbox is not loosened for them. Dependencies that are not already cached are not fetched.
- With a remote sandbox there is no long-running process, so the feature is unavailable: the tool says so and `write`/`edit` add nothing.

## Turning it off

Remove `agnes/lsp` from the preset's extensions to stop the tool and the automatic errors; without it no server is ever started. The built-in thresholds (caps, waits, whether subagents attach errors) are defaults of the extension; a bundled extension currently receives no per-plugin configuration and custom server commands are not supported.
