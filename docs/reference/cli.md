# CLI command reference

English | [简体中文](cli.zh-CN.md)

<a id="cli-命令参考"></a>

[Documentation](../README.md) · [Usage guide](../guide/cli.md)

Find commands by session execution, administration, or extensions. For an end-to-end sequence, read the [CLI / TUI guide](../guide/cli.md).

`agh` below is shorthand. In a source distribution, run `node packages/cli/dist/local/agnes.mjs` instead. All entries assume this distribution method.

<a id="会话与运行"></a>

## Sessions and execution

| Syntax | Purpose / notes |
| --- | --- |
| `agh [prompt]` | TUI in a TTY; print outside a TTY |
| `agh -p [prompt]` | One-shot task with piped input support |
| `agh --mode text\|json` | Selects print automatically; ACP is separate |
| `agh --model main=ROUTE/MODEL` | Explicit slot and route/model from the runtime catalog |
| `agh --profile NAME --preset NAME --cwd DIR` | Ordinary run options; not all forwarded subcommands accept them |
| `agh --continue` / `agh --resume ID` | Mutually exclusive; resume recent/specified session |
| `agh resume ID [-p prompt]` | Resume entry point |
| `agh sessions [list --cwd DIR] --json` / `agh sessions show ID` | List/details |
| `agh export ID --format agnes\|sharegpt\|claude-code [-o FILE]` | Export; also supports `--html` and `--raw` |
| `agh import FILE --from claude-code\|codex\|pi\|auto [--key KEY]` | Convert and import |
| `agh --connect TARGET` | Connect only to that target; no fallback on failure |
| `agh --standalone` / `agh --ephemeral` | Embedded / temporary execution |
| `agh acp` / `agh --mode acp` | ACP protocol entry point |

Print options `--park`, `--chunks`, and `--meta` control waiting and output. See [CLI usage](../guide/cli.md) for exit codes. There is no `--session` or plaintext API-key flag.

<a id="控制面"></a>

## Control plane

| Syntax | Purpose |
| --- | --- |
| `agh config` | Interactive model/account configuration |
| `agh daemon start\|status\|stop` | Explicit daemon lifecycle |
| `agh serve [--home DIR] [--profile NAME] [--cwd DIR] [--port N]` | Local Web |
| `agh profile list` / `inspect NAME --resolved` / `trust DEPLOY_DIR` | Configuration inspection and deployment trust |
| `agh doctor [platform\|provider\|storage\|profile\|extensions\|daemon\|binary\|code-runtime] --json` | Diagnostics |
| `agh doctor provider --probe` | Explicit minimal inference; may incur charges |
| `agh doctor subagents [--repair] --json` | Subagent checks; repair changes state |
| `agh consent DISABLED\|LOCAL\|ANON\|FULL` | Save a telemetry consent level; does not establish all external collection has been verified |
| `agh stats deviation --json` | Deviation statistics |
| `agh conformance gateway --json` | Gateway conformance entry point |

`daemon/ext/mcp/resources/skills/serve` forward remaining arguments to their own parsers. Do not freely mix ordinary run options into them. In the ordinary parser, `--data-dir` is available only to `computer-use rescue`, rather than as a general daemon-selection shortcut.

<a id="包资源与-computer-use"></a>

## Packages, resources, and Computer Use

Packages: `package status|list|catalog|inspect|add|trust|enable|disable|rollback|remove|operation|cancel`; `install SOURCE` aliases add, and `packages pins inspect|release` manages retained references. Updates use Web, TUI `/package update ID SOURCE INTEGRITY`, or SDK. The TUI update submits the specified hash directly: inspect first, without assuming an extra preview/confirmation wizard.

Resources: `resources list|get|operation|cancel|enable|disable`; `skills refresh|trust`; `mcp list|get|add|update|remove|test|trust|enable|disable|status|reconnect|tools`. Writes commonly need expected revision and interactive confirmation. See [Skills](../guide/skills.md) and [MCP](../guide/mcp.md).

Permanent Skill deletion and priority actions use Web or the Node SDK. Shell/TUI Skills syntax remains the existing refresh/trust commands. Guessed `skills remove` and `skills priority` commands are invalid; see [Skills](../guide/skills.md).

Computer Use: `status`, `install [--upgrade]`, `restart`, `operation [ID]`, `cancel ID`, `permissions status|grant`, and `rescue status|install|repair`. Diagnostics use `doctor computer-use [--include CHECK] [--skip CHECK] --json`. Commands with write, installation, or permission effects must not be run automatically as read-only diagnostics.

Low-level `ext`, `mcp serve`, and `serve model-api` are specialized integration surfaces. They do not replace the local workbench commands or establish a verified public service.

Authoritative syntax: [args/usage](../../packages/cli/src/args.ts), [package](../../packages/cli/src/commands/package.ts), [resources](../../packages/resource-control-cli/src/resources.ts), [TUI package](../../packages/cli-tui/src/package-controller.ts).
