# Agnes Harness

**A pluggable agent harness for Forward Deployed Engineering (FDE).**

### Built for trust. Made for the real world.

**Bring AI into real workflows. Turn each deployment into capabilities you can reuse.**

Agnes Harness (AGH) connects models, tools, task state, and business interfaces. Start working through CLI and Web, integrate business systems with plugins, capture task methods in Skills, and combine them into your own agent application.

English | [简体中文](README.zh-CN.md)

[Quickstart](docs/guide/quickstart.md) · [Architecture](#architecture) · [Try the examples](docs/guide/demo.md) · [Build a plugin](docs/develop/plugins.md) · [Documentation](docs/README.md) · [MHS (coming soon)](docs/guide/mhs.md)

Developer preview (pre-alpha) · [Source build](#run-from-source) · [Apache-2.0](LICENSE)

## Why AGH

From a business tool to a workbench for a particular role, AGH provides a shared runtime that you can build on throughout a deployment.

| What you want to build | What AGH provides | Explore |
| --- | --- | --- |
| **Business capabilities an agent can use** | Register tools through backend plugins or connect existing services through MCP, with inputs, calls, and results in the task flow | [Backend plugins](docs/develop/backend.md) · [MCP](docs/guide/mcp.md) |
| **An interface that fits the work** | Add panels to the Web workbench and connect them to the backend through controlled service calls | [Frontend panels](docs/develop/frontend.md) · [Full-stack plugins](docs/develop/fullstack.md) |
| **Experience you can reuse** | Capture task methods in Skills and package reusable business logic as plugins | [Skills](docs/guide/skills.md) · [Plugin lifecycle](docs/guide/packages.md) |
| **Work that continues across entry points** | CLI, Web, and SDK share backend sessions for reading history, continuing tasks, and handling interruptions | [Sessions and recovery](docs/guide/sessions.md) |
| **Authorization and results within the execution flow** | Package trust, tool approvals, execution constraints, and session records provide explicit points of control | [Security and trust](docs/guide/security.md) |

AGH is built for Forward Deployed Engineering (FDE): working in users' environments to turn systems integration, a usable interface, and ongoing iteration into delivered software. **Put the differences into plugins. Let the harness handle execution. Reuse validated capabilities in the next deployment.** [Explore FDE and application scenarios →](docs/guide/why-agh.md)

<a id="architecture"></a>
<a id="a-runtime-built-to-extend"></a>

## Architecture: brain, cerebellum, memory and body

**LLM is the brain. Jev is the cerebellum. Harness is the memory. MHS is the body.**

These roles describe AGH's vision: combine reasoning, structured decisions, persistent task context, and physical capabilities. The diagram separates existing software paths from planned integrations.

![AGH architecture: LLM as brain, Jev as cerebellum, Harness as memory, and MHS as body; dashed boxes show planned Jev and device integration](docs/assets/architecture.svg)

| Role | What it means in AGH | Current scope |
| --- | --- | --- |
| **LLM / brain** | Understand requests, reason about the task, and propose actions | Model integration through AI providers |
| **Jev / cerebellum** | Structured decisions such as routing and scoring to help coordinate execution | Planned integration; main currently uses the built-in Core loop |
| **Harness / memory** | Retain session history, task state, execution records, and reusable methods in Skills | Existing task context and recovery mechanisms; Harness also runs and governs execution |
| **MHS / body** | Connect device capabilities so tasks can read physical state and request actions | Planned device integration; AGH guides and examples are coming soon |

FDE is a delivery approach; MHS is a device integration direction. Both build on the same foundation, and an FDE deployment can include devices.

| Shared module | Supports FDE today | What a future MHS integration can reuse |
| --- | --- | --- |
| **App Server** | Shared sessions, task submission, event delivery, and approval routing for CLI, Web, and SDK clients | Task entry points, human confirmation, and status presentation |
| **Agent Loop** | Model/tool execution, task state, event records, interruption handling, and recovery | High-level device task orchestration and result records |
| **Sandbox / execution constraints** | Tool authorization and applicable command, file, network, and process constraints | Software execution boundaries; device controllers retain motion control, interlocks, and emergency stops |
| **Plugins** | Backend tools/services, Web panels, Skills, hooks, and MCP connections, organized with Cordis and package governance | An extension path for device adapters and device-facing interfaces; adapters still require implementation and validation |

Business connectors and workbenches are built through these extension paths for each deployment. The current repository has no verified general-purpose MHS adapter or end-to-end device example. Ordinary backend plugins run as trusted in-process code; sandbox constraints apply to the supported execution paths.

Follow the actual request path and source ownership in the [architecture guide](docs/develop/architecture.md), explore the [source map](docs/develop/source-map.md), or read [security and trust](docs/guide/security.md).

## Three examples to start building

The repository includes runnable examples for backend capabilities, custom interfaces, and full-stack integration. Each tutorial includes source code, steps, and expected results.

| Example | What you will see | What you can build from it |
| --- | --- | --- |
| [A tool](docs/develop/backend.md) | Invoke `demo_text_stats` and receive character and word counts | Connect order lookup, data retrieval, or another business function |
| [A panel](docs/develop/frontend.md) | Load your own sidebar panel and update its version | Show task information and business state for a particular role |
| [A full-stack plugin](docs/develop/fullstack.md) | Read a backend result from a panel, then inspect updates and rollback | Package a business service together with its interface |

**Choose an example, then add your business logic.** [Open the demo guide →](docs/guide/demo.md)

## Run from source

AGH is a **developer preview (pre-alpha)**, available through a source build. You need Node.js 24.10+, pnpm 10.34.5, and the native build tools for your platform. See [getting the source and installation](docs/guide/install.md). APIs, configuration, and plugin interfaces are evolving and may introduce breaking changes.

Before running AGH, read [security and trust](docs/guide/security.md) and choose the working directory and permissions. From the source repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs serve
```

Open the printed loopback URL, configure a model, create a task, and confirm its working directory. Try your first request:

> Read this project and explain the problem it solves and how its main directories are organized. Do not modify files.

Leave the Web server running and open a second terminal in the same source directory. The CLI uses the same backend and configuration; if you set `AGH_HOME` or `AGNES_PROFILE`, use the same values in this terminal:

```sh
node packages/cli/dist/local/agnes.mjs -p "Briefly explain what this project does"
```

Follow the [quickstart](docs/guide/quickstart.md) to inspect results, find the session, and continue working. Without a model account, you can try the [local simulated-model demo](docs/guide/demo.md#run-locally-without-a-model-account) to explore plugins and task execution.

The full documentation is available in [English](docs/README.md) and [简体中文](docs/README.zh-CN.md). Each page links to the same topic in the other language.

## MHS: extending into the physical world

AGH plans to explore physical device integration through the Model Hardware Standard (MHS), bringing device state, human confirmation, and execution receipts into task workflows. The goal is to make integrations reusable across inspection, instrument coordination, and field operations.

**MHS integration documentation and examples are coming soon.** [Explore the device integration direction →](docs/guide/mhs.md)

## Follow AGH and bring your use case

If you are exploring AI deployment in the field, **Star the project**, use **Watch to follow updates**, and share AGH with developers building agent applications and business integrations.

- **Try it and give feedback:** Run an example and share your experience. Use Issues for ordinary bug reports and use-case suggestions.
- **Build and reuse:** Develop plugins, connect tools, and create a workbench in your own project under the applicable licenses.
- **Develop with the team:** Code and documentation pull requests are currently limited to invited internal developers. External PRs are not accepted for now. See the [feedback and development policy](CONTRIBUTING.md).

Report vulnerabilities privately under the [security policy](SECURITY.md).

## Status and license

AGH is a developer preview. Use [supported scope and known limitations](docs/reference/limitations.md) to choose your trial environment, and the [verification guide](docs/maintainers/verification.md) for reproducible checks and their scope.

Project-authored code is licensed under the [Apache License 2.0](LICENSE). Third-party components, adapted files, and some examples retain their own license terms; see [NOTICE](NOTICE) and [licensing details](docs/maintainers/provenance.md).
