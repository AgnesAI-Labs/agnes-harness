# Architecture: from a request to recoverable execution

English | [简体中文](architecture.zh-CN.md)

<a id="架构从请求到可恢复执行"></a>

[Documentation](../README.md) · [Source map](source-map.md)

AGH runs tasks in a shared backend so CLI, Web, and SDK work with the same session state. Business tools and interfaces use distinct extension entry points and can be developed separately, then composed into an application. This guide follows a request through that architecture.

Clients present state, the daemon manages sessions and the control plane, Host assembles the runtime, and Core advances the model/tool loop. Models propose actions; model text does not decide tool authorization, execution, or persistent state.

## Brain, cerebellum, memory and body

**LLM is the brain, Jev is the cerebellum, Harness is the memory, and MHS is the body.** This is a role metaphor for the product vision, and the overview shows the target architecture; the request diagram below follows the existing software implementation.

![AGH architecture and deployment paths: the four roles in one runtime that serves enterprise FDE delivery and MHS device integration](../assets/architecture.svg)

| Concept | Responsibility and implementation boundary |
| --- | --- |
| **LLM / brain** | The [AI provider layer](../../packages/ai/src) supplies model inference. Core consumes proposed actions through the controlled execution flow. |
| **Jev / cerebellum** | A planned structured-decision integration for routing, scoring, and execution coordination. Main uses the built-in [Core loop](../../packages/core/src/step/session.ts); it has no Jev adapter or Jev-driven loop. [TypeSafe's Jev guide](https://docs.typesafe.ai/introduction/coding-agents) explains its structured-decision role. AGH's integration contract still needs implementation and validation. |
| **Harness / memory** | [Core event records](../../packages/core-ledger/src/log), task state, shared sessions, and recovery preserve task context. [Skills](../guide/skills.md) capture reusable methods. Harness also owns execution and governance; these memory mechanisms preserve facts and methods under their existing contracts. |
| **MHS / body** | A planned device capability interface, built on MCP (Model Context Protocol) rather than a vendor-specific SDK or a ROS bridge: AGH would organize state reads, action requests, and receipts through MCP-based adapters. The physical body consists of devices and their controllers; AGH's [MHS integration](../guide/mhs.md) is exploratory. |

Jev decisions and LLM proposals would still pass through backend authorization and execution controls. Session records and Skills contribute context; authority comes from the configured policy and approval flow.

## Runtime request path

```mermaid
flowchart LR
  CLI[CLI / TUI] --> SDK[SDK]
  Web[Browser Web Context] --> BrowserSDK["@agnes/sdk/browser"]
  BrowserSDK <-->|WebSocket session traffic| D[Daemon]
  Web -->|Same-origin HTTP management / plugin services| BFF[Local Web BFF]
  BFF -->|Node SDK local connection| D
  SDK --> D
  D --> W[Session / Service Worker]
  W --> H[Host / backend Cordis Context]
  H --> K[Core Kernel]
  K --> AI[AI Provider]
  K --> T[Controlled tool execution]
  K --> L[Event ledger and storage]
  H --> R[Plugin and resource snapshots]
```

<a id="web-的两条通信路径"></a>

## The two Web communication paths

The session path is `@agnes/sdk/browser` → WebSocket → daemon. `app.ts` reads the address from the page's `agnes-config` `data-ws` attribute and creates a client with `transport.kind: 'ws'`, protocol `agnes-v1`, and `auth.kind: 'local'`. Session creation/loading, prompts, events, and approvals use this connection without HTTP BFF forwarding. `local` does not waive server-side loopback, Origin, or permission checks.

Management and constrained plugin services use a same-origin HTTP BFF. Resource management uses `/admin/resources/api/...`; client plugin queries/effects use `/api/client-modules/service` and `/api/client-modules/effect`. The local Web process then calls the daemon through the Node SDK's local connection. Direct browser session connectivity does not give browser plugins Node management capabilities. `ClientContext` service relay remains constrained by the current session, row identity, and allow-list.

Code: [browser session client](../../packages/web/src/app.ts), [browser SDK exports and management restrictions](../../packages/sdk/src/index.browser.ts), [resource-management BFF](../../packages/resource-control-cli/src/admin-bff.ts), [plugin-service BFF](../../packages/cli/launch/package-admin.ts), [Web server](../../packages/web-server/src/server.ts).

<a id="状态归属"></a>

## State ownership

| Layer | Main responsibilities |
| --- | --- |
| CLI/Web | User input, approval interaction, sessions, and result presentation |
| SDK | Protocol, transport, session handles, cursors, and request journal |
| daemon / worker | Shared instance and session directory, control plane, and approval routing; workers host execution environments |
| Host | Profiles, credentials, platform adapters, plugin assembly, and Kernel creation |
| Core | Execution state machine, event facts, and required capability seams |
| AI/Base/Code | Provider protocols, standard capabilities, and programmable workflows |

A prompt reaches the daemon through the SDK and is routed to a session worker. Host supplies model, tool, approval, sandbox, storage, and other seams for that session. Core generates the next step, records state, and consumes model or tool results. Clients read events or derived projections. Backend state determines cancellation, failure, parking, and recovery.

<a id="接缝与扩展"></a>

## Seams and extensions

A seam supplies a required part of execution, such as approval, ledger, or sandbox behavior. Missing seams must be refused according to the contract rather than silently skipped. Extensions contribute optional features such as tools, observation hooks, or client slots. Both can be assembled through Cordis, but they have different permission surfaces.

Trusted backend Cordis rows may contribute tools, hooks, and constrained services. A browser module is a separate runtime surface bound to a row; see [plugin boundaries](plugins.md). Frontend and backend Contexts do not share memory. Ordinary `ctx.provide()` is not a cross-process proxy. Browsers call row services through declared relays without obtaining Host management objects.

<a id="runtime-target-与热更新"></a>

## Runtime targets and hot updates

PackageManager produces verified snapshots and governance state. A runtime target combines ordinary rows, resource rows, and platform-synthesized client rows. `web:` rows do not execute in Host's ordinary tree. Host reconciles mutable rows, dependencies, and actual state in constrained transactions, applying eligible changes incrementally. Static boundaries, failed compensation, or tainted state may require a rebuild.

This supports incremental updates for eligible changes. Transactions do not cover external business effects. The frontend also reconciles its own roster and cleans up fibers, so inspect both backend actual state and page loading.

<a id="mcp-与-skills"></a>

## MCP and Skills

The MCP control plane stores definitions, trust, and enablement. Session workers mount a Host `ext:` row per eligible server from resource snapshots. Startup and turn-boundary reloads use the same apply path; the dedicated resource-management service worker uses the manager. The session path currently skips OAuth bindings; see [MCP runtime behavior](../guide/mcp.md#runtime-behavior-and-versions) for the call chain and limits.

Skills combine disk/package resource governance with runtime Cordis contributions. The shared worker handles Skill scan/deletion commands, and Host's Skills row can refresh incrementally after resource changes. The session workspace determines visible disk Skills. This lifecycle differs from per-server MCP rows; do not assume each Skill source has its own Host row.

<a id="app-server-与客户端"></a>

## App Server and clients

Each `AGH_HOME` has one authenticated daemon endpoint. The [App Server v1 contract](../reference/app-server.md) publishes generated JSON Schema and method-specific TypeScript types. `agh app-server --stdio` and ACP are connection bridges to that daemon. Management HTTP paths adapt the same RPC methods; composition, search, context, history and plan state are owned by the daemon. Errors retain numeric codes and carry safe localized message keys, allowlisted causes and diagnostic ids.

AGH's App Server provides shared task execution: the daemon manages sessions and the control plane, workers execute tasks, and the SDK provides communication entry points. Choose an integration path from the repository's [API contracts](../reference/api.md) when building a client.

<a id="可复用场景的范围"></a>

## Scope of reusable applications

FDE is a delivery approach; MHS is a device integration direction. An FDE deployment can use AGH's existing extension paths for enterprise software and can later include device integrations. Knowledge retrieval, database connectors, business systems, and specialized interfaces require implementation and validation for each environment.

| Module and source ownership | FDE use through current software paths | Reusable foundation for a future MHS integration |
| --- | --- | --- |
| App Server: [SDK](../../packages/sdk/src), [daemon](../../packages/daemon/src), [worker](../../packages/worker-runtime/src) | Shared sessions, task submission, events, approval routing, and client integration | Task entry points, human confirmation, and status presentation |
| Agent Loop: [Host assembly](../../packages/host-runtime/src/assemble.ts), [Core](../../packages/core/src), [AI](../../packages/ai/src) | Model/tool execution, task state, interruption handling, and recovery | High-level device task orchestration; device controllers perform actual motion |
| Memory: [event records](../../packages/core-ledger/src/log), [resource governance](../../packages/resource-control-runtime/src) | Preserve task history and results; reuse methods through Skills | Preserve observations and adapter receipts under task-record contracts; device truth needs device-side verification |
| Execution constraints: [controlled tool execution](../../packages/core/src/step/tools.ts), [sandbox](../../packages/base/src/sandbox-shell.ts), [workspace policy](../../packages/host-common/src/workspace-policy.ts) | Tool approvals and applicable software execution constraints | Software-side control points; device interlocks, emergency stops, and local takeover remain device responsibilities |
| Plugins: [Cordis](../../packages/cordis/src), [plugin runtime](../../packages/plugin-runtime/src), [package manager](../../packages/package-manager/src), [Web client modules](../../packages/web-client/src) | Backend tools/services, hooks, Skills, MCP connections, and business panels | Extension points for adapters and device-facing interfaces; no verified general-purpose MHS adapter exists in this repository |

Ordinary backend plugins execute as trusted in-process code. A tool approval or available command sandbox does not isolate arbitrary plugin code. Approvals, sandbox behavior, and other required seams are selected by trusted deployment configuration; ordinary extensions do not acquire the right to replace them by registering a tool or hook. See [security and trust](../guide/security.md).

MHS adapters are the device branch in the overview, built on MCP (Model Context Protocol) rather than a vendor-specific SDK or a ROS bridge. Integration guides and examples are [coming soon](../guide/mhs.md); a bare MCP connection alone does not establish MHS compatibility, since no public MHS specification is open for certification. Task cancellation does not establish that a physical device stopped safely. Enterprise deployment, audit, isolation, and device actions each need validation in their actual environment.

Source: [Host](../../packages/host-runtime/src/assemble.ts), [Worker](../../packages/worker-runtime/src/main.ts), [Core](../../packages/core/src), [Daemon](../../packages/daemon-supervisor/src/supervisor/supervisor.ts), [runtime-target publication](../../packages/host-providers/src/runtime-target-publisher.ts), [Web Context](../../packages/web/src/client-modules/boot.ts).
