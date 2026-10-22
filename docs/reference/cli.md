# CLI command reference

English | [简体中文](cli.zh-CN.md)

<a id="cli-命令参考"></a>

[Documentation](../README.md) · [Usage guide](../guide/cli.md)

Find commands by session execution, administration, or extensions. For an end-to-end sequence, read the [CLI / TUI guide](../guide/cli.md).

`agh` below is shorthand. In a source distribution, run `node agnes.mjs` instead. All entries assume this distribution method.

<a id="会话与运行"></a>

## Sessions and execution

| Syntax | Purpose / notes |
| --- | --- |
| `agh run --bundle ID_OR_PATH --input FILE_OR_DASH --json [--batch]` | Fresh headless sessions and versioned JSONL; see [headless runs](../guide/headless.md) |
| `agh [prompt]` | TUI in a TTY; print outside a TTY |
| `agh -p [prompt]` | One-shot task with piped input support |
| `agh -p --output-schema FILE` | Ask for a final reply that is one JSON value matching the JSON Schema (2020-12) in `FILE` (up to 64 KiB) and check it; exit code 6 when it does not match, 2 when the file is unusable |
| `agh --mode text\|json\|stream-json` | Selects print automatically (`stream-json`: one event line per event, then the result line); ACP is separate |
| `agh --model main=ROUTE/MODEL` | Explicit slot and route/model from the runtime catalog |
| `agh --profile NAME --preset NAME --permission LEVEL --cwd DIR` | Ordinary run options; not all forwarded subcommands accept them. `LEVEL` is `read-only`, `workspace-write`, `full-access` or `default` (the deployment default) and applies to a new session only |
| `agh --continue` / `agh --resume ID` | Mutually exclusive; resume recent/specified session. `--continue` prefers the session last used in this terminal pane (same directory, not archived); see the [CLI guide](../guide/cli.md) |
| `agh --no-alt-screen` | Interactive only: keep the shell screen and write finished turns into the terminal's own scrollback; see the [CLI guide](../guide/cli.md) for limits |
| `agh (--ephemeral\|--standalone) --ignore-rules` / `--safe-mode` | Private host only (refused with exit 2 on the shared daemon or `--connect`): skip custom slash commands / also switch off non-built-in plugins and mark the TUI status bar. Instruction files, hooks and MCP servers are not skipped yet; see the [CLI guide](../guide/cli.md) |
| `agh resume ID [-p prompt]` | Resume entry point |
| `agh sessions [list --cwd DIR] [--archived] [--limit N] [--all] [--last] --json` / `agh sessions show ID` | List, one tab-separated row per session: id, last sequence, preset, `pinned` or `-`, last activity (last message, else creation time), cwd, title (text columns may change, scripts use `--json`); one page of 50 unless `--limit N` (1-500) sets the page size, `--all` follows every page (`--limit` then caps the total), `--last` prints only the most recently active session, and a stderr hint says when more exist; `--archived` keeps archived ones; `--json` is the machine contract / details |
| `agh sessions pin\|unpin\|archive\|unarchive ID` / `rename ID TITLE...` | Session preferences; `--json` prints the stored preferences |
| `agh sessions deliverables ID [--json]` / `--save N\|ID [--out PATH] [--force]` | List the files a session delivered / download one: sha256 and size are checked, only the name's last path segment is used, an existing file is refused without `--force` |
| `agh sessions undo KEY [--turn N] [--yes] [--json]` | Print what undoing the last file-changing turn (or turn N) would do; with `--yes` apply it. Refused whole when a file changed after the turn, while a turn runs, for a non-owner or a read-only session; exits 1 when it refuses or a file could not be restored. |
| `agh approvals grants SESSION [--json]` / `agh approvals revoke SESSION GRANT [--json]` | List the approval grants in force for a session / revoke one (admin connection; a refusal is printed as the daemon sends it) |
| `agh approvals suggest [--days N] [--min-count N] [--limit N] [--json]` | Read past sessions and propose command prefixes you approved often (default 90 days, at least 2 times, 20 shown). Read-only: adopt a prefix on the approval card. Credentials are masked; without an admin connection it says it did not compare with existing grants |
| `agh schedules [list [--session KEY] [--archived]] / show ID [--json]` | List scheduled tasks (all by default) / one task with its recent runs |
| `agh schedules add --prompt TEXT (--every 30m\|--cron EXPR\|--at ISO\|--daily HH:MM\|--weekly mon,wed@HH:MM) [--tz ZONE] [--title T] [--session KEY \| --new-session [--cwd DIR]] [--unattended notify\|refuse]` / `edit ID [same flags]` | Create or change a task; `--every` runs from 60s to 366d, a task with neither `--session` nor `--new-session` opens a new session in the current directory, and `edit` changes only the flags given |
| `agh schedules pause\|resume\|run\|archive ID [--json]` | Pause, resume, run now, or archive a task (admin connection; a refusal prints its code and exits 1) |
| `agh triggers [list] [--json]` / `agh triggers remove RULE` | List webhook trigger rules and the listener configuration / delete a rule |
| `agh triggers add --file RULE.json\|-` / `edit RULE --file RULE.json\|-` / `configure --file CONFIG.json\|-` | Save a rule or the configuration from JSON (`-` reads stdin); the JSON is checked against the protocol schema before anything is sent |
| `agh triggers test RULE [--payload FILE\|-]` | Run a synthetic delivery through a rule; a delivery that is not accepted prints its status and exits 1. `deliver` is webhook-only and not offered |
| `agh settings [--json]` | List the settings sections with a one-line description |
| `agh settings SECTION [get] [--json]` | Print one section (`model-slots`, `child-engines`, `auto-review`, `system-prompt`, `memory`, `observability`, `search`, `session-defaults`) as one line per value, or the daemon result with `--json`; `memory` uses `--cwd` |
| `agh settings SECTION set --file FILE\|-` | Save a section from JSON (`-` reads stdin); checked against the protocol schema before anything is sent. `system-prompt` also takes `--text TEXT` (replaces the whole prompt and needs `--yes`; empty removes it) |
| `agh settings search test --text QUERY [PROVIDER]` | Run one search on a provider (default: the default provider); a failed test prints the reason and exits 1 |
| `agh credentials [list] [--json]` / `agh credentials rename ID NAME...` | List generic credentials (id, name, kind, creation time, references; never a secret) / rename one |
| `agh credentials delete ID [--yes] [--force]` | Without `--yes`, show what would be deleted and send nothing; a credential still in use also needs `--force` |
| `agh agents [--all] [--json]` | Sessions with state (`paused`, `queued`, `open`, `closed`, `unknown`), queued inputs and last activity; the 50 most recent unarchived sessions unless `--all`; one read-only `session.controls` per session |
| `agh queue KEY [--steer] [--json] TEXT...\|-` | Send a follow-up (default, runs after the current turn) or, with `--steer`, a steer into an existing session through the SDK command path; `-` reads stdin; a refusal prints `refused: CODE: message` (exit 1); an unconfirmed outcome is reported and never resent |
| `agh api METHOD [--params JSON\|-] [--json]` | Call one protocol method with local params-schema checks; `agh api --help` lists callable methods and tiers; streaming, attach and command-class methods are refused (use `agh queue`); a daemon refusal goes to stderr (exit 1) |
| `agh sessions search QUERY... [--cwd DIR] --json` / `agh sessions groups` | Search history by session (admin connection; a refusal is printed as the daemon sends it) / session groups |
| `agh sessions verify ID [--json]` | Run a fresh full history audit; reports verified sequence/time or the failing sequence and exits nonzero on failure. |
| `agh export ID --format agnes\|sharegpt\|claude-code [-o FILE]` | Export; also supports `--html` and `--raw` |
| `agh import FILE --from claude-code\|codex\|pi\|auto [--key KEY]` | Convert and import |
| `agh --connect TARGET` | Connect only to that target; no fallback on failure |
| `agh --standalone` / `agh --ephemeral` | Embedded / temporary execution |
| `agh acp` / `agh --mode acp` | ACP protocol entry point |

`--preset` selects the recipe (`standard`, `minimal`, `ptc` or another allowed preset) and `--permission` what the session may do; any allowed pair combines, for example `agh --preset ptc --permission read-only` or just `agh --permission read-only`. Retired permission-as-preset aliases (`read-only`, `workspace-write`, `full-access`) are refused; use an explicit recipe and permission. Omitting permission or choosing `default` follows the deployment default. See [permissions and presets](../guide/security.md#permissions-and-presets).

Print output is chosen with `--mode text|json|stream-json`. Waiting for approval is a profile setting (`limits."approval.park"`), not a flag. See [CLI usage](../guide/cli.md) for exit codes. There is no `--session` or plaintext API-key flag.

<a id="控制面"></a>

## Control plane

| Syntax | Purpose |
| --- | --- |
| `agh config` | Interactive model/account configuration |
| `agh daemon start\|status\|stop` | Explicit daemon lifecycle |
| `agh serve [--home DIR] [--profile NAME] [--cwd DIR] [--port N]` | Local Web |
| `agh profile list` / `inspect NAME --resolved` / `trust DEPLOY_DIR` | Configuration inspection and deployment trust |
| `agh doctor [platform\|network\|provider\|storage\|credentials\|profile\|extensions\|daemon\|binary\|code-runtime] --json` | Diagnostics |
| `agh doctor credentials --json` | Read-only file metadata (target, mode and safety checks); never reads credential contents or changes permissions |
| `agh doctor provider --probe` | Explicit minimal inference; may incur charges |
| `agh doctor subagents [--repair] --json` | Subagent checks; repair changes state |
| `agh consent DISABLED\|LOCAL\|ANON\|FULL` | Save a telemetry consent level; does not establish all external collection has been verified |
| `agh completion bash\|zsh\|fish` | Print a shell completion script to stdout (see the [CLI guide](../guide/cli.md#shell-completion)); the hidden `agh __complete sessions [PREFIX]` is its helper and never starts a daemon |
| `agh stats deviation --json` | Deviation statistics |
| `agh conformance gateway --json` | Gateway conformance entry point |

`daemon/mcp/resources/skills/serve` forward remaining arguments to their own parsers. Do not freely mix ordinary run options into them. In the ordinary parser, `--data-dir` is available only to `computer-use rescue`, rather than as a general daemon-selection shortcut.

<a id="包资源与-computer-use"></a>

## Packages, resources, and Computer Use

Packages: `package status|list|catalog|inspect|add|trust|enable|disable|rollback|remove|operation|cancel|source-policy` (the last prints the allowed package sources); `install SOURCE` aliases add, and `packages pins inspect|release` manages retained references. Updates use Web, TUI `/package update ID SOURCE INTEGRITY`, or SDK. The TUI update submits the specified hash directly: inspect first, without assuming an extra preview/confirmation wizard.

Resources: `resources list|get|operation|cancel|enable|disable`; `skills refresh|trust`; `mcp list|get|add|update|remove|test|trust|enable|disable|status|reconnect|tools`. Writes commonly need expected revision and interactive confirmation. See [Skills](../guide/skills.md) and [MCP](../guide/mcp.md).

Permanent Skill deletion and priority actions use Web or the Node SDK. Shell/TUI Skills syntax remains the existing refresh/trust commands. Guessed `skills remove` and `skills priority` commands are invalid; see [Skills](../guide/skills.md).

Computer Use: `status`, `install [--upgrade]`, `restart`, `operation [ID]`, `cancel ID`, `permissions status|grant`, and `rescue status|install|repair`. Diagnostics use `doctor computer-use [--include CHECK] [--skip CHECK] --json`. Commands with write, installation, or permission effects must not be run automatically as read-only diagnostics.

Authoritative syntax: [args/usage](../../packages/cli/src/args.ts), [package](../../packages/cli/src/commands/package.ts), [resources](../../packages/resource-control-cli/src/resources.ts), [TUI package](../../packages/cli-tui/src/package-controller.ts).

## Diagnostics

`agh diagnostics export [--session SESSION_ID] --out diagnostics.json` writes a redacted support bundle through the local owner connection. See [observability](../guide/observability.md) for its contents and limits.

## Plugin authoring and shared App Server

| Syntax | Purpose |
| --- | --- |
| `agh --new -p PROMPT` | Fresh session with current plugins; ordinary print mode may reuse the workspace session |
| `agh tools [--session KEY] [--json]` | Inspect admitted tools and capability provenance |
| `agh plugins add SOURCE [--yes]` / `pack FOLDER [OUTPUT]` | Reviewed acquisition; pack a distributable without executing its code |
| `agh dev FOLDER` / `plugins reload [ID]` | Authorize local development / publish changed local code for new sessions |
| `agh plugins candidates list\|show\|approve\|reject` | Read and review agent-authored candidates; approval/rejection binds candidate and review hashes |
| `agh plugins provenance ID [--json]` | Read installation origin and trust evidence |
| `agh plugins config get ID [--json]` | Show a plugin's configuration rows: value, schema summary and validity. Secret and credential fields print as `[redacted]`, also in `--json` |
| `agh plugins config validate ID [ROW] --file VALUE.json\|-` / `set ID [ROW] --file VALUE.json\|-` | Validate a row value without saving / validate then save; an invalid value is listed and not saved (exit 1). ROW may be omitted when the plugin has one row |
| `agh plugins tree [list]` / `tree show` / `plugins generations [--json]` | Read the plugin tree (`show --json` includes the artifact) / the runtime generations |
| `agh plugins tree apply --file ARTIFACT.json\|- [--yes]` / `tree rollback [--yes]` | Apply a tree artifact / roll back to the previous one; without `--yes` only print what would happen and send nothing |
| `agh plugins publication-status [--json]` | Read per-container convergence results |
| `agh sessions migrate KEY [--json]` | Explicitly migrate a closed compatible session; refuses an open session |
| `agh app show [--json]` / `app preview PACKAGE#APP` | Show the current application and candidates / the consent preview before adopting |
| `agh app adopt PACKAGE#APP [--yes]` | Adopt an application; without `--yes` prints the preview and sends nothing |
| `agh app clear [--profile NAME] [--json]` | Clear the application and all explicit interface role choices before plugin boot; uses the shared configuration CAS |
| `agh app-server --stdio` / `schema --out DIR` | Bridge to the shared daemon / export its generated contract without starting it |
| `agh doctor --json` / `doctor --probe --json` | Local checks / explicit account probes, which may incur charges |

See [candidate review](../extend/agent-built-plugins.md), [hot reload](../extend/hot-reload.md), [App Server](app-server.md) and [first run](../guide/getting-started.md) for complete flags and authority boundaries.

## Create a session from an agent

`node agnes.mjs --agent '@acme/kit#review' -p 'Inspect this workspace'` asks the backend to resolve that Bundle's own `launch`, selecting an exact Loop, session Bundle and explicit preset. `--agent` cannot be combined with `--loop`, `--preset`, `--permission` or resume options. Loop-only plugins can still use `--loop id@version`.

The target must be trusted, enabled and launch-ready. Invalid references, missing dependencies and unsatisfiable strict model/permission requirements refuse creation. Draft launch prompts are never sent automatically.
