# Agnes Harness documentation

English | [简体中文](README.zh-CN.md)

<a id="agnes-harness-文档"></a>

**From your first task to your own agent application.**

Run tasks through CLI and Web, connect business capabilities with plugins, capture methods in Skills, and build interfaces for the people doing the work. Choose a path below to get started.

[Project home](../README.md) · [Why AGH](guide/why-agh.md) · [Try the examples](guide/demo.md) · [MHS (coming soon)](guide/mhs.md)

<a id="选择你的起点"></a>

## Choose your starting point

| Your goal | Recommended path | What you will achieve |
| --- | --- | --- |
| **Try AGH** | [Install](guide/install.md) → [First run](guide/quickstart.md) → [Continue a session](guide/sessions.md) | Run a task and find its record in both Web and CLI |
| **Give agents business capabilities** | [Backend plugins](develop/backend.md) · [MCP](guide/mcp.md) · [Skills](guide/skills.md) | Connect tools, external services, or your team's methods |
| **Build a business workbench** | [Frontend panels](develop/frontend.md) → [Full-stack integration](develop/fullstack.md) | Add an interface and read results from a backend service |
| **Explore and extend the runtime** | [Architecture](develop/architecture.md) → [Source map](develop/source-map.md) → [API](reference/api.md) | Understand requests, extensions, and persistent state |

Still choosing? Try the [three examples](guide/demo.md), then use the [extension guide](develop/plugins.md) to choose an integration path.

<a id="使用-agh"></a>

## Use AGH

| Topic | What you will learn |
| --- | --- |
| [CLI and TUI](guide/cli.md) | Run terminal tasks, hold interactive conversations, and handle approvals |
| [Web workbench](guide/web.md) | Create tasks, inspect history, and manage models and extensions |
| [Sessions and recovery](guide/sessions.md) | Continue tasks, export records, and handle interruptions |
| [Plugin lifecycle](guide/packages.md) | Install, trust, enable, update, and remove plugins |
| [Security and trust](guide/security.md) | Choose a working directory and understand authorization and execution boundaries |
| [Troubleshooting](guide/troubleshooting.md) | Use error codes and runtime state to choose the next diagnostic step |

<a id="构建与深入了解"></a>

## Build and explore

- **Scenarios and methods:** [FDE and use cases](guide/why-agh.md) · [MHS and device integration](guide/mhs.md).
- **Exact interfaces:** [CLI reference](reference/cli.md) · [Configuration](reference/configuration.md) · [API and schemas](reference/api.md).
- **Support and feedback:** [Supported scope](reference/limitations.md) · [Feedback and development](develop/contributing.md) · [Security reports](../SECURITY.md).
- **More development topics:** [Skins](develop/skins.md) · [Build recovery](guide/build-recovery.md) · [Capability matrix](reference/capabilities.md).

<a id="阅读约定"></a>

## Reading conventions

AGH is a pre-alpha source preview. Unless stated otherwise, run commands from the source repository root using `node packages/cli/dist/local/agnes.mjs`. Replace uppercase placeholders such as `SESSION_ID` and `REVISION` with values returned by your instance. Versions such as `1.0.0` and `2.0.0` refer to example packages.

Documentation is maintained alongside the code. Choose the version that matches your runtime. Tutorials state prerequisites, steps, and expected results. See [verification and reproduction](maintainers/verification.md) for commands and coverage; record each release's actual results with its release notes.

Every page under `docs/` has English and Simplified Chinese editions. Use the language switch at the top of a page to open the same topic in the other language. Source files and generated package references are shared across editions.

<a id="维护与许可"></a>

## Maintenance and licensing

[Documentation maintenance](maintainers/maintenance.md) · [Release checks](maintainers/release.md) · [Versioning](maintainers/versioning.md) · [Verification](maintainers/verification.md) · [Licensing](maintainers/provenance.md) · [Apache-2.0](../LICENSE) · [NOTICE](../NOTICE)
