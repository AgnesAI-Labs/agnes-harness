# Agnes Harness documentation

English | [简体中文](README.zh-CN.md)

<a id="agnes-harness-文档"></a>

**AGH delivers business capabilities as installable plugins, launchable agents and adoptable applications.**

- A **plugin** is the installation, distribution and trust unit. It can provide tools, Loops, models, UI, skills, connections or services.
- An **agent** is a Bundle with its own explicit `launch`, referenced as `package#bundle`. It selects a Loop and preset to start a task.
- An **application** declares identity, presentation defaults and default/visible agents inside a plugin. A deployment administrator previews and explicitly adopts it; installation never switches applications.

**FDE (forward-deployed engineering) means building an application for an enterprise**: deliver business tools, agents and a workbench for the people doing the work. Existing backend modules still own execution and authorization.

Minimal tool plugin: from a built source checkout, add an echo tool in an isolated home. No agent or application declaration is required.

```sh
export AGH_SOURCE="$PWD"
export AGH_HOME="$(mktemp -d /tmp/agh-hello.XXXXXX)"
export AGH_HOME="$(cd "$AGH_HOME" && pwd -P)"
export AGNES_PROFILE=local-dev
AGH_WORKSPACE="$(mktemp -d /tmp/agh-hello-workspace.XXXXXX)"
cd "$AGH_WORKSPACE"
mkdir -p .agh/plugins
node "$AGH_SOURCE/templates/create-agh-plugin.mjs" tool hello-tool .agh/plugins/hello-tool --local
node "$AGH_SOURCE/agnes.mjs" dev .agh/plugins/hello-tool
node "$AGH_SOURCE/agnes.mjs" --new -p 'call plugin_hello_tool {"message":"hello"}'
```

[Five-step tool tutorial](extend/quickstart.md) · [Four-step Loop tutorial](extend/first-loop.md) · [Acme reference application](../examples/acme/README.md)

<a id="选择你的起点"></a>


[Product demos](guide/demos.md)
## Choose your starting point

| Role | Start here | Outcome |
| --- | --- | --- |
| **User** | [Install](guide/install.md) → [First run](guide/getting-started.md) → [Sessions](guide/sessions.md) | Choose an agent, complete tasks and inspect records |
| **Deployment administrator** | [Deployment](guide/deployment.md) · [Security](guide/security.md) · [Plugins](guide/packages.md) · [Applications](extend/applications.md) | Review capabilities, configure models, adopt and recover applications |
| **Plugin author** | [First tool](extend/quickstart.md) → [First Loop](extend/first-loop.md) → [Choose capabilities](extend/choose-a-plugin-type.md) | Deliver installable capabilities through public contracts |
| **Application builder** | [Acme](../examples/acme/README.md) → [Application contract](extend/applications.md) → [UI author guide](develop/ui-author-guide.md) | Combine agents, identity, pages and navigation |

<a id="使用-agh"></a>

<a id="use-agh"></a>

## User

| Topic | What you will learn |
| --- | --- |
| [CLI and TUI](guide/cli.md) | Run terminal tasks, hold interactive conversations, and handle approvals |
| [Composer references](extend/references.md) | Pick workspace files and readable sessions as bounded context |
| [Default context](guide/context.md) | Inspect live repository rules, time context and custom Skill roots |
| [Feedback and reviewed growth](guide/feedback.md) | Rate messages and draft Skills for human review |
| [Learned memory](guide/memory.md) | Control learned file preferences, approvals and privacy |
| [Official default tools](reference/default-tools.md) | Search, ask questions, present files, manage background jobs, and edit observed files |
| [Web workbench](guide/web.md) | Create tasks, inspect history, and manage models and extensions |
| [Built-in browser](guide/browser.md) | Share a web page with AGH, test local projects and take control |
| [Programmatic tools and workflows](guide/code-workflows.md) | Run TypeScript cells and durable parallel child workflows |
| [Code diagnostics (LSP)](guide/lsp.md) | Language-server errors after edits; which servers to install and the safety limits |
| [Sessions and recovery](guide/sessions.md) | Continue tasks, export records, and handle interruptions |
| [Plugin lifecycle](guide/packages.md) | Install, trust, enable, update, and remove plugins |
| [Generic credentials](guide/credentials.md) | Save write-only API keys and manage their references |
| [Webhook triggers](guide/webhooks.md) | Start normal business-agent sessions from authenticated business events |
| [Headless runs and replay](guide/headless.md) | Stream JSONL events, compare fixed model replies and run batches |
| [Use a local model](guide/local-model.md) | Configure local OpenAI-compatible endpoints and discovery |
| [Use TypeSafe Jev for side model calls](guide/typesafe-jev.md) | Configure the built-in payload-only adapter that loop plugins call outside the conversation |
| [Use the Jev agent loop](guide/jev-loop.md) | Install and configure the optional loop that lets TypeSafe Jev choose each step |
| [Security and trust](guide/security.md) | Choose a working directory and understand authorization and execution boundaries |
| [Sandbox providers](guide/sandbox-providers.md) | Select the process sandbox at startup and read declared capabilities |
| [Observability and diagnostics](guide/observability.md) | Enable OTLP telemetry and export a redacted issue bundle |
| [System prompts and request traces](guide/system-prompt-trace.md) | Customize a persona and inspect the local model request |
| [Execution evidence](guide/fact-chain.md) | Follow requests, tools, artifacts and authoring sources, including gaps |
| [Session workbench](guide/workbench.md) | File panels, workflow receipts and docks |
| [Candidate review](extend/agent-built-plugins.md) | Review agent drafts, tests and permissions before publication |
| [Provenance and MCP isolation](guide/security.md#package-provenance-and-source-policy) | Package sources, integrity and local MCP process boundaries |
| [Network deployment and Linux](guide/deployment.md) | Outbound proxies, timeouts and Linux preparation |
| [App Server stdio](reference/app-server.md) | Build a client on the shared backend |
| [Troubleshooting](guide/troubleshooting.md) | Use error codes and runtime state to choose the next diagnostic step |

## Deployment administrator

[Data-format recovery](guide/install.md#data-format-and-upgrade) · [Application and interface choices](extend/applications.md) · [Stateful author tests](extend/testing.md)

[Plugin lifecycle](guide/packages.md) · [Models and accounts](guide/getting-started.md) · [Network deployment](guide/deployment.md) · [Security and trust](guide/security.md) · [Application adoption and recovery](extend/applications.md)

## Plugin author

[Five-step tool](extend/quickstart.md) → [Four-step Loop](extend/first-loop.md) → [Author kit](extend/README.md) · [Testing](extend/testing.md) · [Public imports](extend/imports.md)

## Application builder

[Acme reference application](../examples/acme/README.md) → [Application contract](extend/applications.md) · [Agents and composition](extend/bundles-and-profiles.md) · [UI author guide](develop/ui-author-guide.md) · [Workbench panels](extend/workbench-panels.md)

<a id="构建与深入了解"></a>

## Build and explore

- **Scenarios and methods:** [FDE and use cases](guide/why-agh.md).
- **Exact interfaces:** [CLI reference](reference/cli.md) · [Configuration](reference/configuration.md) · [API and schemas](reference/api.md).
- **Side model calls:** [TypeSafe Jev adapter](guide/typesafe-jev.md) · [Jev agent loop](guide/jev-loop.md) · [Write a loop plugin](develop/plugins.md).
- **Support and feedback:** [Supported scope](reference/limitations.md) · [Feedback and development](develop/contributing.md) · [Security reports](../SECURITY.md).
- **More development topics:** [Skins](develop/skins.md) · [Theme](develop/ui-theme.md) · [Build recovery](guide/build-recovery.md) · [Capability matrix](reference/capabilities.md).

<a id="阅读约定"></a>

## Reading conventions

AGH is a pre-alpha source preview. Unless stated otherwise, run commands from the source repository root using `node agnes.mjs`. Replace uppercase placeholders such as `SESSION_ID` and `REVISION` with values returned by your instance. Versions such as `1.0.0` and `2.0.0` refer to example packages.

Documentation is maintained alongside the code. Choose the version that matches your runtime. Tutorials state prerequisites, steps, and expected results. See [verification and reproduction](maintainers/verification.md) for commands and coverage; record each release's actual results with its release notes.

Every page under `docs/` has English and Simplified Chinese editions. Use the language switch at the top of a page to open the same topic in the other language. Source files and generated package references are shared across editions.

<a id="维护与许可"></a>

## Maintenance and licensing

[Documentation maintenance](maintainers/maintenance.md) · [Release checks](maintainers/release.md) · [Versioning](maintainers/versioning.md) · [Verification](maintainers/verification.md) · [Licensing](maintainers/provenance.md) · [Apache-2.0](../LICENSE) · [NOTICE](../NOTICE)

Frontend maintainers: [UI consistency](develop/ui-consistency.md), [UI registry APIs](develop/ui-extension-registries.md), [UI coverage](develop/ui-coverage.md), [terminology](develop/ui-glossary.md).

Developer contract (proposed): [Intelligent UI contract](develop/intelligent-ui.md), including [UI data sources](develop/ui-data-source.md).
