# Agnes Harness

English | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/assets/readme/banner.png" alt="Agnes Harness, a pluggable agent harness for Forward Deployed Engineering. LLM is the brain, Jev is the cerebellum, Harness is the memory, MHS is the body." width="100%" />
</p>

<div align="center">

### Built for trust. Made for the real world.

**Bring AI into real workflows. Turn each deployment into capabilities you can reuse.**

<img src="https://img.shields.io/badge/status-developer%20preview%20(pre--alpha)-f59e0b" alt="Status: developer preview (pre-alpha)" />
<img src="https://img.shields.io/badge/license-Apache--2.0-2F4F4F" alt="License: Apache-2.0" />
<img src="https://img.shields.io/badge/node-%E2%89%A5%2024.10-339933" alt="Node.js 24.10 or later" />
<img src="https://img.shields.io/badge/local%20checks-macOS-3b8fff" alt="Recorded local checks: macOS" />

[Quickstart](docs/guide/quickstart.md) · [Architecture](#architecture) · [Try the examples](docs/guide/demo.md) · [Build a plugin](docs/develop/plugins.md) · [Documentation](docs/README.md) · [MHS (coming soon)](docs/guide/mhs.md)

Developer preview (pre-alpha) · [Source build](#run-from-source) · [Apache-2.0](LICENSE)

</div>

<p align="center">
  <img src="docs/assets/readme/trailer.webp" alt="Animated introduction: the brain (LLM), the cerebellum (Jev, planned), the memory (Harness) and the body (MHS, planned, connected through MCP) come together as Agnes Harness, one execution foundation for enterprise FDE delivery and, as a planned direction, physical-world MHS integration" width="100%" />
</p>

<p align="center">
  <b>LLM is the brain. Jev is the cerebellum. Harness is the memory. MHS is the body.</b><br />
  <sub>Jev and MHS are planned integrations, and MHS builds on MCP. <a href="#architecture">See the architecture</a></sub>
</p>

Taking AI into a real deployment is rarely about the model alone. It is about the customer's systems, the people who approve the work, and the details that differ at every site. Agnes Harness (AGH) connects models, tools, task state, and business interfaces: **put the differences into plugins, let the harness run and record the work, and carry what you validated into the next deployment.**

<p align="center">
  <img src="docs/assets/readme/hero.gif" alt="AGH working in a real project: the agent reads the refund rules and order data, asks for approval before running a command, verifies the result, returns a checkable table, and records every step in the trajectory view" width="100%" />
</p>

<p align="center"><sub>Read the code, ask before running a command, verify, answer, and record every step. The Web interface currently ships in Chinese, so captions are bilingual.</sub></p>

<details>
<summary><kbd>Contents</kbd></summary>

- [What AGH is, and what it is not](#what-agh-is-and-what-it-is-not)
- [Architecture: brain, cerebellum, memory and body](#architecture)
- [What AGH does for a deployment team](#what-agh-does-for-a-deployment-team)
- [Public benchmark](#public-benchmark)
- [Who it is for](#who-it-is-for)
- [Start from an example](#start-from-an-example)
- [Run from source](#run-from-source)
- [Current status](#current-status)
- [FAQ](#faq)
- [Follow AGH and bring your use case](#follow-agh-and-bring-your-use-case)
- [License](#license)

</details>

## What AGH is, and what it is not

AGH is built for Forward Deployed Engineering (FDE): working in users' environments to turn systems integration, a usable interface, and ongoing iteration into delivered software. Start through CLI and Web, integrate business systems with plugins, capture task methods in Skills, and combine them into your own agent application. [Explore FDE and application scenarios →](docs/guide/why-agh.md)

What it is not, so you can choose the right trial:

- **Not a hosted service.** AGH is a developer preview that you build from source and run in your own environment.
- **Not a sandbox for arbitrary plugin code.** Ordinary backend plugins run as trusted in-process code; approvals and the command sandbox apply to the supported execution paths. See [security and trust](docs/guide/security.md).
- **Not a certified device driver.** MHS device integration builds on MCP and is coming soon. No public MHS specification is open for certification, and device controllers keep real-time control and physical safety.
- **Not finished.** APIs, configuration, and plugin interfaces are evolving and may change.

<a id="architecture"></a>
<a id="a-runtime-built-to-extend"></a>

## Architecture: brain, cerebellum, memory and body

The brain, cerebellum, memory and body describe AGH's vision: combine reasoning, structured decisions, persistent task context, and physical capabilities. The diagram separates existing software paths from planned integrations.

![AGH architecture: LLM as brain, Jev as cerebellum, Harness as memory, and MHS as body; dashed boxes show planned Jev and device integration](docs/assets/architecture.svg)

| Role | What it means in AGH | Current scope |
| --- | --- | --- |
| **LLM / brain** | Understand requests, reason about the task, and propose actions | Model integration through AI providers |
| **Jev / cerebellum** | Structured decisions such as routing and scoring to help coordinate execution | Planned integration; main currently uses the built-in Core loop |
| **Harness / memory** | Retain session history, task state, execution records, and reusable methods in Skills | Existing task context and recovery mechanisms; Harness also runs and governs execution |
| **MHS / body** | Connect device capabilities so tasks can read physical state and request actions | Planned device integration via MCP-based adapters; AGH guides and examples are coming soon |

FDE is a delivery approach; MHS is a device integration direction. Both build on the same foundation, and an FDE deployment can include devices.

| Shared module | Supports FDE today | What a future MHS integration can reuse |
| --- | --- | --- |
| **App Server** | Shared sessions, task submission, event delivery, and approval routing for CLI, Web, and SDK clients | Task entry points, human confirmation, and status presentation |
| **Agent Loop** | Model/tool execution, task state, event records, interruption handling, and recovery | High-level device task orchestration and result records |
| **Sandbox / execution constraints** | Tool authorization and applicable command, file, network, and process constraints | Software execution boundaries; device controllers retain motion control, interlocks, and emergency stops |
| **Plugins** | Backend tools/services, Web panels, Skills, hooks, and MCP connections, organized with Cordis and package governance | An extension path for MCP-based device adapters and device-facing interfaces; adapters still require implementation and validation |

Business connectors and workbenches are built through these extension paths for each deployment. The current repository has no verified general-purpose MHS adapter or end-to-end device example.

Follow the actual request path and source ownership in the [architecture guide](docs/develop/architecture.md), or explore the [source map](docs/develop/source-map.md).

## What AGH does for a deployment team

### 1. Every customer's systems are different

The agent needs your order lookup, your knowledge base, your internal API. Writing that into the agent itself means forking it for every customer.

In AGH, a business capability is a plugin: register a tool through a [backend plugin](docs/develop/backend.md) or connect an existing service through [MCP](docs/guide/mcp.md). Installing one shows its version, source, integrity digest, capability hash, and license before anything runs; enabling it binds and verifies those hashes. The agent can then call it, and every call keeps its inputs and structured output.

<p align="center">
  <img src="docs/assets/readme/plugins.gif" alt="Installing a plugin in the Web workbench: inspect the source, review integrity, capabilities and license, confirm enabling, then the agent calls the new demo_text_stats tool and its inputs and structured output are recorded" width="100%" />
</p>

### 2. Work starts on the Web and continues in the terminal

The analyst starts a task in the browser; the engineer picks it up from a terminal. Copying context between tools loses history and decisions.

CLI, Web, and SDK share the same backend sessions. Resume a Web session in the terminal with `/resume <id>` and the history, tool records, and results are already there; whatever you add in the terminal shows up in the Web thread. See [sessions and recovery](docs/guide/sessions.md).

<p align="center">
  <img src="docs/assets/readme/terminal.gif" alt="The terminal UI resumes a session started on the Web, shows its history, tool records and result table, answers a follow-up, and the same thread is up to date back on the Web" width="100%" />
</p>

### 3. "What did the AI change, and who approved it?"

In a customer environment, a result is not enough: you need to show how it was produced.

Running a command waits for your approval by default: allow once, allow for the session, or deny. The trajectory view keeps a timeline of model calls, tools, and approvals, step by step. Package trust, tool approvals, execution constraints, and session records give the integration explicit points of control. See [security and trust](docs/guide/security.md).

<p align="center">
  <img src="docs/assets/readme/trajectory.png" alt="The trajectory view: a timeline of input, model and tool activity, followed by step records that include the user request, file reads, the shell command and its approval record, and the final answer" width="100%" />
</p>

### 4. Each role needs its own screen

A support lead and a warehouse operator do not want the same interface. Add [frontend panels](docs/develop/frontend.md) to the Web workbench and connect them to backend services through controlled calls with [full-stack plugins](docs/develop/fullstack.md).

### 5. The next deployment should start from the last one

Capture task methods in [Skills](docs/guide/skills.md) and package reusable business logic as plugins with a governed [lifecycle](docs/guide/packages.md): install, enable, update, roll back, and remove.

### 6. The site also has devices

From inspection to instrument coordination, field work connects device state, human judgment, and business workflows. AGH's device integration direction builds on MCP (Model Context Protocol) rather than a vendor-specific SDK, bringing state reads, action requests, and execution receipts into the same task flow. **MHS integration documentation and examples are coming soon.** [Explore the device integration direction →](docs/guide/mhs.md)

## Public benchmark

On the public [Agents' Last Exam (ALE) leaderboard](https://agents-last-exam.org/leaderboard), which evaluates complete agent systems (model, harness, and tools) on professional tasks, Agnes Harness with Agnes 2.5 Pro Beta reaches a 21.7% overall pass rate, level with OpenClaw + GPT-5.5.

<p align="center">
  <img src="docs/assets/readme/ale-leaderboard.png" alt="Agents' Last Exam results for Agnes Harness with Agnes 2.5 Pro Beta: 21.7% overall pass rate, 42.7% overall score, 31.3% near-term pass rate, 23.6% full-spectrum pass rate, 25.7% ALE-CLI pass rate and 50.2% ALE-CLI score, beside an excerpt of nearby leaderboard entries whose models and settings differ" width="100%" />
</p>

<p align="center"><sub>Results depend on model versions, settings, and tool configurations. See the leaderboard for current figures.</sub></p>

## Who it is for

- **FDE and solution engineers** delivering agents into customer systems and workflows
- **Plugin developers** packaging business tools, services, and interfaces for reuse
- **Teams that need oversight**: approvals before commands, records of every step, and explicit package trust
- **Field and lab teams** preparing for device scenarios as MHS integration opens up

Not a fit yet if you need a hosted service, signed installers, or a production commitment today: AGH is a developer preview.

## Start from an example

The repository includes runnable examples for backend capabilities, custom interfaces, and full-stack integration. Each tutorial includes source code, steps, and expected results.

| Example | What you will see | What you can build from it |
| --- | --- | --- |
| [A tool](docs/develop/backend.md) | Invoke `demo_text_stats` and receive character and word counts | Connect order lookup, data retrieval, or another business function |
| [A panel](docs/develop/frontend.md) | Load your own sidebar panel and update its version | Show task information and business state for a particular role |
| [A full-stack plugin](docs/develop/fullstack.md) | Read a backend result from a panel, then inspect updates and rollback | Package a business service together with its interface |

**Choose an example, then add your business logic.** [Open the demo guide →](docs/guide/demo.md)

## Run from source

AGH is a **developer preview (pre-alpha)**, available through a source build. You need Node.js 24.10+, pnpm 10.34.5, and the native build tools for your platform. See [getting the source and installation](docs/guide/install.md).

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

## Current status

AGH is a developer preview.

| Area | State |
| --- | --- |
| Web workbench, CLI and terminal UI, SDK on shared sessions | Available in the developer preview |
| Agent loop, tool approvals, trajectory records, recovery | Available |
| Plugins: backend tools and services, Web panels, Skills, hooks, MCP | Available, with documented constraints |
| Command sandbox and execution constraints | Platform-dependent |
| Platforms | Recorded local checks on macOS with Node 24; Linux and Windows need separate acceptance |
| Jev structured decisions | Planned |
| MHS device integration (MCP-based) | Coming soon |

Use [supported scope and known limitations](docs/reference/limitations.md) to choose your trial environment, and the [verification guide](docs/maintainers/verification.md) for reproducible checks and their scope.

## FAQ

**Can I use AGH in production?**
Not yet. AGH is a developer preview without a public package release, installer, or upgrade commitment. Validate deployment, audit, and isolation requirements in your own environment.

**Are plugins sandboxed?**
Ordinary backend plugins run as trusted in-process code, so install only packages you trust. Approvals and the command sandbox apply to the supported execution paths; they do not isolate arbitrary plugin code.

**Which models can I use?**
Models connect through AI providers, and each provider's catalog determines the available capabilities. The demos on this page were recorded with Agnes AI `agnes-3.0-flash`; quality and tool selection vary by model.

**Can MHS control devices today?**
No. MHS documentation and examples are coming soon, built on MCP. Canceling an AGH task does not establish that a device stopped safely; device controllers keep interlocks and emergency stops.

**Do you accept pull requests?**
Code and documentation pull requests are currently limited to invited internal developers. Issues for bug reports and use-case suggestions are welcome; see the [feedback and development policy](CONTRIBUTING.md).

## Follow AGH and bring your use case

If you are exploring AI deployment in the field, **Star the project**, use **Watch to follow updates**, and share AGH with developers building agent applications and business integrations.

- **Try it and give feedback:** Run an example and share your experience. Use Issues for ordinary bug reports and use-case suggestions.
- **Build and reuse:** Develop plugins, connect tools, and create a workbench in your own project under the applicable licenses.

Report vulnerabilities privately under the [security policy](SECURITY.md).

## License

Project-authored code is licensed under the [Apache License 2.0](LICENSE). Third-party components, adapted files, and some examples retain their own license terms; see [NOTICE](NOTICE) and [licensing details](docs/maintainers/provenance.md).
