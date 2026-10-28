# Choose a plugin type by role

English | [简体中文](choose-a-plugin-type.zh-CN.md)

[Plugin author kit](README.md) · [Five-minute quickstart](quickstart.md) · [Plugin purpose metadata](plugin-metadata.md)

A plugin is one package. It is the only unit a person installs, upgrades, trusts and removes. What the package contains is its type, declared in `package.json` as `agnes.provides`; one package may declare several. Start from what you want to deliver and pick the smallest type that owns it.

| You are | Declare | You write | Where people meet it |
| --- | --- | --- | --- |
| A tool author | `tool` | Operations the agent can call, with input and result schemas | Plugins → Plugins and Marketplace (type “Tools”); the tool appears in the conversation when the agent calls it |
| A skill author | `skills`, or no package at all | `SKILL.md` instructions, shipped in a package or dropped into a skills folder | Plugins → Skills, each row labelled “From <plugin>” or “Added by me” |
| An integration author | `mcp` | A connection to an external system through MCP | Plugins → Connections (MCP), each row labelled with its source |
| An agent architecture researcher | `loop`, `model-adapter`, or a provider | How a turn is scheduled, how a model is called, or one runtime service such as compaction or memory | Settings → Models → Run configuration for supported Loop/model choices; profile or preset contracts for other providers |
| An agent author | `bundle` | A Bundle with its own launch: Loop, tools, skills and an explicit preset | Agents page; Plugins shows capabilities and status |
| An interface author | `ui` | Panels, skins or browser-side controls | The workbench slot the panel declares, Settings → General for skins, and Plugins → Marketplace (type “UI and skins”) |
| An application builder | Existing capability labels plus `agnes.application` | Brand, presentation defaults, pages and default/visible agents; providers only where needed | Administrator previews and adopts it in Settings → Application |

## What each choice means

**Tool.** Use a tool when the agent needs one more operation and the existing loop can decide when to call it. Start from the [tool template](../../templates/tool/) and read [Tool runtime and policies](tool-runtime.md). Add `ui` and start from [tool-with-panel](../../templates/tool-with-panel/) when the result deserves its own panel.

**Skills.** A skill is written instruction, not code: it tells the agent how your team does a task. For your own use, a folder is enough; see [Skills](../guide/skills.md). Package it with the [mcp-skills template](../../templates/mcp-skills/) when other people should install it and receive updates.

**MCP.** Use MCP when the capability already lives in another system or process. A package can carry the connection definition; a person can also add a server by hand. Neither starts or trusts an external server automatically; see [MCP management](../guide/mcp.md).

**Loop, model adapter and providers.** These replace part of the runtime rather than add to it. A loop owns scheduling and state for a turn ([Business workflows](workflow-loops.md), [Loop events](loop-events.md)). A model adapter translates one wire protocol ([model-adapter template](../../templates/model-adapter/)). Other providers fill one slot each: [compaction](compaction-engines.md), [persistence](persistence.md), [memory](memory.md), [child agents](child-agents.md), the sandbox, the tool runtime and the tool policy. Installation registers a candidate; it does not switch a running session. Run configuration exposes supported Loop/model choices. Other provider selections use their profile or preset contracts; inspect registered kinds under Settings → Advanced → Run diagnostics → Technical details.

**Bundle.** A Bundle is a reusable configuration. Add its own complete `launch` block with an explicit preset to offer an agent; a Loop-only plugin needs no Bundle. See [Bundles and profiles](bundles-and-profiles.md) and [plugin metadata](plugin-metadata.md).

**UI.** Browser code has its own lifecycle and never runs in the agent process. Declare panels and skins through a client descriptor; see [Workbench panels](workbench-panels.md) and [Configuration UI](configuration-ui.md).

**Enterprise solutions.** There is no “enterprise” type. Register providers for the [seams](seams.md) your rules need, and register a page through the [home entry registry](../develop/ui-extension-registries.md). Seam providers that enforce security are pinned for the life of a session, so a rule cannot change under a running task. A reporting solution can combine review rules with its own report page.

## One declared capability set

`agnes.provides` says what a package contains and drives the marketplace type filter and the “Includes” labels on each row.

Capability filters use author-declared `agnes.provides`. Runtime registration is separate evidence; labels never grant authority:

| Capability | provides label |
| --- | --- |
| Reusable configuration (not necessarily launchable) | `bundle` |
| Tools | `tool` |
| Skill packs | `skills` |
| MCP connections | `mcp` |
| Interface and skins | `ui` |
| Execution and providers | `loop`, `model-adapter` |

“Includes” labels use `PackagePresentation.includes`, which the backend derives without running your code. To have a number shown next to a kind, state it in package data: list tool names under a plugin's `capabilities.tools.names`, declare skills as `skill` contributions, and declare bundles under `agnes.bundles`. A kind with no stated number is shown by name alone. See [Plugin purpose metadata](plugin-metadata.md#what-a-package-includes).

“Built-in” has one meaning: shipped with the product and not removable. A package you publish is never built-in, whatever it contains.

Application builders declare brand and presentation defaults through [application](applications.md); see [Acme](../../examples/acme/README.md).
