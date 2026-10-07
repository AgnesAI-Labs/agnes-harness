# MCP and Skills support

English | [简体中文](mcp-skills-support.zh-CN.md)

[Documentation](../README.md) · [MCP](mcp.md) · [Skills](skills.md)

This page lists what the current session path implements. A management screen that can store a definition is not the same as a model being able to call it.

## MCP

| Behavior | Session path |
| --- | --- |
| stdio transport | Supported |
| Streamable HTTP transport | Supported |
| Legacy SSE transport | Supported, for servers that still speak only SSE |
| `tools/list` and `tools/call` | Supported. Each remote tool is registered under a per-server prefix |
| `resources/list`, `resources/templates/list`, and `resources/read` | Supported when the server advertises the `resources` capability. Each connected server gains up to three read-only tools, named with that server's prefix plus `res_list`, `res_tpls`, and `res_read` |
| `notifications/tools/list_changed` and `notifications/resources/list_changed` | Supported. The row re-syncs on the same connection |
| Cancellation | Supported. The tool signal is forwarded to the in-flight list or read |
| Reconnect | Supported. The existing supervisor reconnects and registers tools again |
| Secret redaction and the shared output guard | Supported for tool and resource text |
| Name conflict between a remote tool and a resource bridge tool | The remote tool is kept. That one resource bridge tool is omitted |
| Resource pages | One page per call. Pass `nextCursor` back as `cursor`. A page over 256 entries is an error |
| Resource images as model image blocks | Not supported. Text is returned as text. Binary content is bounded base64 |
| Prompt templates (`prompts/list`, `prompts/get`) | Not supported |
| OAuth on the session row | Not supported. A definition whose secret binding is `oauth` is skipped. A successful check in the management UI does not make that server available in the session |

## Skills

| Behavior | Session path |
| --- | --- |
| Directory skill (`<name>/SKILL.md`) | Supported |
| Flat file (`<name>.md` directly in a skill root) | Supported without frontmatter: filename supplies the name and the first nonempty heading/line supplies the description. Empty files or invalid explicit frontmatter are rejected. A directory of the same name wins over the flat file. An earlier directory wins over a later one |
| Fixed roots | Supported: workspace `.agh/skills`, `AGH_HOME/skills`, and, with `AGNES_SKILLS_IMPORT_USER=1`, `.agents/skills`, `.claude/skills`, and `.codex/skills` under the operating-system home. Workspace `.agents/skills` and `.claude/skills` are scanned with the workspace root |
| Custom skill roots | Supported through installation `context.json` → `customSkillRoots` or Settings → Context. Absolute paths only; scanned after the Agnes home root with the same trust and refresh rules |
| Relative resource paths | Supported inside the skill directory, through `skill_read_file` and ordinary file tools against the directory named by `skill_read`. Paths must stay inside that directory |
| Same-name precedence | Higher priority wins. Ties break by `sourceId`. A higher-priority skill that is untrusted, disabled, or hidden from the model does not hand the name to a lower-priority skill |
| `disable-model-invocation` | Supported. `true` hides the skill from the model catalog, `skill_read`, `skill_read_file`, and `tool_search`. The host can still read it |
| `user-invocable` | Supported. `false` refuses explicit invocation while leaving the skill model-visible. Web and TUI accept `/skill invoke NAME ARGUMENTS`; the Context page has an invocation form |
| `disable` | Supported. `true` hides the skill from both the model and the host read |
| Omitted flags | Both model and user use are permitted |
| Invalid flag value | That document is skipped |
| Content refresh | The daemon watches `SKILL.md` and relative resource files. `skills refresh --yes` requests an immediate rescan |
| Flag or body edits | A flag edit changes the capability hash. A body edit changes the content revision. Recorded trust/rejection and enable/disable decisions follow edits; new filesystem Skills are automatically trusted/enabled |
| Management descriptors | Do not carry invocation flags |

Invocation flags accept a YAML boolean or a case-insensitive `true`/`false`, `yes`/`no`, `on`/`off`, or `1`/`0`.
