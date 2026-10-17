# Backend plugins: give an agent a new capability

English | [简体中文](backend.zh-CN.md)

<a id="后端插件给-agent-增加一项能力"></a>

[Documentation](../README.md) · Prerequisite: [Cordis boundaries](plugins.md)

Plugins are fully trusted code running with the user's rights. Capability declarations are reviewed at admission; they do not restrict arbitrary JavaScript or enforce a hook allowlist. `ctx.hooks.register` accepts the supported observe, transform and intercept hooks regardless of the declared `hooks` list. Use only code you intend to authorize.

Build an installable text-statistics tool and check its inputs and results in the tool record. This is a small starting point for connecting a business function to AGH.

Reuse the installable [hot-tool-plugin](../../examples/packages/hot-tool-plugin/package.json). It does not access networks, files, or paid models. `demo_text_stats` accepts text and returns character and whitespace-separated word counts. Character counting uses JavaScript `text.length`, not Unicode grapheme clusters.

<a id="入口与工具"></a>

## Workspace identity and execution directory

`cwd` is the execution directory snapshot at the start of a call. It may differ from
`workspaceRoot` in a future version. Session defaults currently satisfy `cwd === workspaceRoot`;
an explicit process directory only affects that operation. Locate workspace-owned state,
policy and config (for example `.agh/plan-mode.json`) using the trusted identity:
`ToolContext.session.workspaceRoot`, `ToolPolicyInput.workspaceRoot`, or
`LoopContext.session.workspaceRoot`. A session-bound `ServiceContext` exposes
`session.workspaceRoot`; when `session` is absent, refuse operations that require workspace
identity. Host/Core derive identity from the authoritative workspace binding, never tool
arguments or service input. A root string grants no filesystem authority; use the granted ports.
There is no session directory-change feature in this contract change.

## Entry point and tool

The package points `agnes.plugins` at `textStatsTool`. Both manifest and exported object declare `inject: ['tools', 'hooks', 'self']`. The core registration is:

```js
export const textStatsTool = {
  inject: ['tools', 'hooks', 'self'],
  apply(ctx) {
    ctx.tools.register({
      name: 'demo_text_stats',
      description: 'Count characters and words in text.',
      parameters,
      meta,
      async execute({ text }) {
        const structured = {
          characters: text.length,
          words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        }
        return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
      },
    })
  },
}
```

This excerpt focuses on registration. The complete runnable file and `parameters/meta` are in [index.mjs](../../examples/packages/hot-tool-plugin/index.mjs). Use that file instead of saving the excerpt and guessing the missing fields.

Parameters use a schema with TypeBox kind markers. The example writes `Symbol.for('TypeBox.Kind')` directly to avoid an external import. A plain JSON Schema object is not automatically a valid TypeBox value for every tool-definition API. With an installed TypeBox dependency, use `Type.Object` and bundle the dependency before distribution.

`structured` reaches loops, exports and the trace inspector, never the model. Give it a `schema` field of your own when other code may read it: the built-in `ls`, `find` and `grep` mark theirs `agh.path-references/1`, and a reader tells payloads apart by that field. A `run_code` script gets the text of a result whose `structured` has that schema, whichever tool returns it, and any other `structured` as it is.

Metadata declares read-only, nondestructive, concurrency-safe, closed-world behavior, `replay: 'safe'`, and no approval requirement. If you change the tool to write files or call an external system, redefine effects, approvals, and replay semantics instead of retaining these declarations.

<a id="安装和运行"></a>

## Install and run

Follow [plugin management](../guide/packages.md) to inspect, install, trust, and enable `file:./examples/packages/hot-tool-plugin`. In a new session with a configured model, ask:

> Call demo_text_stats on hello world and return the tool result.

The expected structure is `{"characters":11,"words":2}`. Whether a real model selects the tool requires real-model verification. A plain-text answer with the same numbers is not proof of a tool call; inspect the tool record.

<a id="无模型验证与失败路径"></a>

## Verify without a model and check failures

```sh
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host-extensions/test/ext-host/row-extension-host.test.ts --maxWorkers=1
```

Example tests load the actual backend module, capture its registered definition, and check schema, arguments, and results. Frontend examples use a real Cordis Context to test mounting and unloading. The additional Host tests cover row APIs, expired leases, reserved tool names, and restricted APIs. These checks do not establish OS isolation of malicious in-process code or correct tool selection by a real model.

<a id="把示例变成你的业务能力"></a>

## Adapt the example to your business

Keep package structure and registration first, then replace the business logic. Update input validation, permissions, approvals, and replay declarations for actual side effects. Add connections and listeners to the Cordis lifecycle so disabling the plugin cleans them up. To show results in an interface, continue with [frontend panels](frontend.md) and [full-stack integration](fullstack.md).

See [cordis-greeting](../../examples/packages/cordis-greeting/greeting.test.ts) for configured services, and the [hot-service](../../examples/packages/hot-service/README.md) family for updates, failed candidates, and fallback. Avoid copying a backend entry solely from the old `hot-tool` `agnes.extensions` format.

### Scheduled tasks from tools

Tools can bind the fixed daemon scheduling service through `ctx.providers.bindOwn(schedulingKind)`
inside an admitted callback. Declare the exact six `schedulingServiceCapabilities` in the package
manifest's `capabilities.services` and obtain their service lease grants. Official and third-party
tools use the same checks, session ownership and workspace restrictions. The interface provides
list/get/upsert/control/archive/runs; it does not replace the scheduling engine. See the
[scheduling service contract](../../packages/base/extensions/schedule/README.md#scheduling-service).
