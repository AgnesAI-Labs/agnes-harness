# Backend plugins: give an agent a new capability

English | [简体中文](backend.zh-CN.md)

<a id="后端插件给-agent-增加一项能力"></a>

[Documentation](../README.md) · Prerequisite: [Cordis boundaries](plugins.md)

Build an installable text-statistics tool and check its inputs and results in the tool record. This is a small starting point for connecting a business function to AGH.

Reuse the installable [hot-tool-plugin](../../examples/packages/hot-tool-plugin/package.json). It does not access networks, files, or paid models. `demo_text_stats` accepts text and returns character and whitespace-separated word counts. Character counting uses JavaScript `text.length`, not Unicode grapheme clusters.

<a id="入口与工具"></a>

## Entry point and tool

The package points `agnes.plugins` at `textStatsTool`. Both manifest and exported object declare `inject: ['extension']`. The core registration is:

```js
export const textStatsTool = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
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
pnpm exec vitest run tools/public-docs/examples.test.ts packages/host/test/ext-host/row-extension-host.test.ts --maxWorkers=1
```

Example tests load the actual backend module, capture its registered definition, and check schema, arguments, and results. Frontend examples use a real Cordis Context to test mounting and unloading. The additional Host tests cover row APIs, expired leases, reserved tool names, and restricted APIs. These checks do not establish OS isolation of malicious in-process code or correct tool selection by a real model.

<a id="把示例变成你的业务能力"></a>

## Adapt the example to your business

Keep package structure and registration first, then replace the business logic. Update input validation, permissions, approvals, and replay declarations for actual side effects. Add connections and listeners to the Cordis lifecycle so disabling the plugin cleans them up. To show results in an interface, continue with [frontend panels](frontend.md) and [full-stack integration](fullstack.md).

See [cordis-greeting](../../examples/packages/cordis-greeting/greeting.test.ts) for configured services, and the [hot-service](../../examples/packages/hot-service/README.md) family for updates, failed candidates, and fallback. Avoid copying a backend entry solely from the old `hot-tool` `agnes.extensions` format.
