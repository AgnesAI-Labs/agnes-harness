// Generated from templates/tool-with-panel by plugin-creator/gen-assets.mjs; do not edit.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: canonical template source contains literal placeholders
// biome-ignore format: preserve generator output
export const panelFiles = [
  {
    "path": ".gitignore",
    "content": "node_modules/\ndist/\n"
  },
  {
    "path": "README.md",
    "content": "# my-agh-plugin\n\nAGH tool-with-panel starter. Requires Node.js 24.10 or later and matching AGH package builds.\n\nTest the final candidate hash and submit human review.\n\nUse `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.\n\nAfter activation, ask a new session to call plugin_my_agh_plugin with {\"message\":\"hello\"}. Inspect the tool record for the structured result. Update effect and replay metadata when adding I/O.\n\nOpen the printed AGH Web URL, create a new session after activation, and open the additional `my-agh-plugin` page from the sidebar. The page follows current profile activation and leaves the host navigation available; session renderers retain their session generation. Backend status does not prove the panel rendered; check it in the browser.\n"
  },
  {
    "path": "client/agnes.client.json",
    "content": "{\n  \"client\": {\n    \"entry\": \"./index.js\",\n    \"styles\": [],\n    \"slots\": [],\n    \"publicConfig\": {\n      \"label\": \"my-agh-plugin\"\n    },\n    \"services\": [],\n    \"projections\": [],\n    \"id\": \"my-agh-plugin\",\n    \"lifetime\": \"profile\",\n    \"homeEntries\": [\n      {\n        \"id\": \"my-agh-plugin\",\n        \"placement\": \"secondary\",\n        \"navigation\": {\n          \"title\": \"my-agh-plugin\",\n          \"titles\": {\n            \"zh-CN\": \"my-agh-plugin\"\n          },\n          \"icon\": \"plugin\",\n          \"order\": 50\n        }\n      }\n    ]\n  }\n}\n"
  },
  {
    "path": "client/index.js",
    "content": "export function apply(ctx, config) {\n  ctx.homeEntries.register({\n    id: 'my-agh-plugin',\n    icon: 'plugin',\n    titleKey: 'my-agh-plugin',\n    order: 50,\n    placement: 'secondary',\n    component: function PluginPage() {\n      const zh = ctx.locale.locale === 'zh-CN'\n      return (\n        (config?.publicConfig?.label ?? 'my-agh-plugin') +\n        (zh ? '：请智能体调用 plugin_my_agh_plugin' : ': ask the agent to call plugin_my_agh_plugin')\n      )\n    },\n  })\n}\n"
  },
  {
    "path": "package.json",
    "content": "{\n  \"name\": \"my-agh-plugin\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"license\": \"Apache-2.0\",\n  \"engines\": {\n    \"node\": \">=24.10\"\n  },\n  \"exports\": \"./src/index.ts\",\n  \"files\": [\n    \"src\",\n    \"client\",\n    \"skills\",\n    \"mcp.json\"\n  ],\n  \"scripts\": {\n    \"test\": \"node --test test/*.test.mjs\"\n  },\n  \"agnes\": {\n    \"plugins\": [\n      {\n        \"export\": \"main\",\n        \"apiRange\": \"^4.0.0\",\n        \"id\": \"ext:my-agh-plugin/main\",\n        \"inject\": [\n          \"tools\"\n        ],\n        \"capabilities\": {\n          \"ui\": true\n        }\n      }\n    ],\n    \"clientDescriptors\": [\n      {\n        \"rowId\": \"ext:my-agh-plugin/main\",\n        \"path\": \"./client/agnes.client.json\"\n      }\n    ],\n    \"hostProvidedExternals\": {\n      \"@agnes/plugin-runtime\": \"0.0.0\",\n      \"@agnes/extension-api\": \"^4.0.0\",\n      \"@sinclair/typebox\": \"0.34.33\"\n    },\n    \"provides\": [\n      \"tool\",\n      \"ui\"\n    ]\n  }\n}\n"
  },
  {
    "path": "src/index.ts",
    "content": "import { type Context, defineAgnesPlugin, defineTool, readOnlyTool, toolError } from '@agnes/plugin-runtime'\nimport { Type } from '@sinclair/typebox'\n\nexport const echo = defineTool({\n  name: 'plugin_my_agh_plugin',\n  description: 'Echo a nonempty message.',\n  parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),\n  result: Type.Object({ message: Type.String() }, { additionalProperties: false }),\n  meta: readOnlyTool,\n  async execute({ message }, ctx) {\n    ctx.signal.throwIfAborted()\n    if (!message.trim()) return toolError('A nonempty message is required')\n    // Pass ctx.signal to asynchronous work you add; release per-call resources in finally.\n    return { content: [{ type: 'text', text: message }], structured: { message } }\n  },\n})\n\nexport const main = defineAgnesPlugin({\n  apply(ctx: Context) {\n    ctx.tools.register(echo)\n  },\n})\n"
  },
  {
    "path": "test/panel.test.mjs",
    "content": "import assert from 'node:assert/strict'\nimport { readFile } from 'node:fs/promises'\nimport { test } from 'node:test'\nimport { apply } from '../client/index.js'\n\ntest('page matches its descriptor and renders localized public configuration', async () => {\n  const { client } = JSON.parse(\n    await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'),\n  )\n  let page\n  const locale = { locale: 'en' }\n  apply(\n    {\n      locale,\n      homeEntries: {\n        register(entry) {\n          page = entry\n        },\n      },\n    },\n    { publicConfig: { label: 'My tool' } },\n  )\n  assert.equal(page.id, client.homeEntries[0].id)\n  assert.equal(client.lifetime, 'profile')\n  assert.deepEqual(client.slots, [])\n  assert.match(page.component(), /My tool: ask/)\n  locale.locale = 'zh-CN'\n  assert.match(page.component(), /请智能体调用/)\n})\n"
  },
  {
    "path": "test/plugin.test.mjs",
    "content": "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { fileURLToPath } from 'node:url'\nimport { createPluginTestHost } from '@agnes/host/author-testkit'\nimport { echo, main } from '../src/index.ts'\n\ntest('register, invoke, reject invalid inputs and unload', async () => {\n  const host = await createPluginTestHost(main, {\n    packageDir: fileURLToPath(new URL('../', import.meta.url)),\n  })\n  try {\n    assert.deepEqual((await host.invoke(echo.name, { message: 'hello' })).structured, { message: 'hello' })\n    assert.equal((await host.invoke(echo.name, { message: '' })).isError, true)\n    await assert.rejects(host.invoke(echo.name, { message: 1 }), /Invalid arguments/)\n    const cancelled = new AbortController()\n    cancelled.abort(new DOMException('Stopped', 'AbortError'))\n    await assert.rejects(host.invoke(echo.name, { message: 'hello' }, cancelled.signal), /Stopped/)\n  } finally {\n    await host.dispose()\n  }\n  assert.equal(host.tools.size, 0)\n})\n"
  },
  {
    "path": "tsconfig.json",
    "content": "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"module\": \"NodeNext\",\n    \"moduleResolution\": \"NodeNext\",\n    \"strict\": true,\n    \"declaration\": true,\n    \"outDir\": \"dist\",\n    \"rootDir\": \"src\",\n    \"skipLibCheck\": true,\n    \"types\": [\"node\"]\n  },\n  \"include\": [\"src/**/*.ts\"]\n}\n"
  }
]
