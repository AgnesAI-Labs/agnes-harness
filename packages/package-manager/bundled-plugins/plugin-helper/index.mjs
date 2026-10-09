import { array, enumeration, object, string } from './src/schema.mjs'
import { skinFiles, skinGuidance } from './src/skin.mjs'
import { toolSource } from './src/templates.mjs'

const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const meta = (readOnly, approval = 'never') => ({
  isReadOnly: readOnly,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: readOnly ? 'safe' : 'never',
  costHint: {},
  deferLoading: false,
  requiresApproval: approval,
})
const port = (ctx) => {
  if (!ctx.pluginManage) throw new Error('PLUGIN_PORT_UNAVAILABLE')
  if (ctx.session.depth !== 0) throw new Error('PLUGIN_LOCAL_MAIN_SESSION_REQUIRED')
  ctx.signal.throwIfAborted()
  return ctx.pluginManage
}
export const pluginHelper = {
  inject: ['extension'],
  apply(ctx) {
    const extension = ctx.extension()
    const api = {
      registerTool(definition) {
        const execute = definition.execute
        extension.registerTool({
          ...definition,
          async execute(args, context) {
            try {
              return await execute(args, context)
            } catch (error) {
              const code =
                [error?.code, error?.message].find(
                  (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value),
                ) ?? 'PLUGIN_HELPER_FAILED'
              return {
                isError: true,
                ...result({
                  state: 'failed',
                  code,
                  message:
                    '操作未完成。请报告错误并检查 AGH 设置中的实际状态；不要自动重试，也不要用 shell 绕过拒绝或失败。',
                }),
              }
            }
          },
        })
      },
    }
    api.registerTool({
      name: 'plugin_helper_guide',
      description:
        'Before creating an Agnes Harness (AGH) plugin, read this version-matched authoring guide and runnable template. The default target for “write a plugin” in this app is AGH. Skill content alone uses skill-helper; connecting an MCP server uses mcp-helper. This helper authors ordinary tool, Skill or pure CSS skin plugin rows.',
      parameters: object({ kind: enumeration('tool', 'skill', 'skin') }),
      meta: meta(true),
      async execute({ kind }) {
        if (kind === 'skin')
          return result({
            host: 'Agnes Harness',
            apiVersion: '1.4.0',
            guidance: skinGuidance,
            files: [
              ...skinFiles(),
              {
                path: 'test/skin.test.mjs',
                content:
                  'import {test} from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";test("skin declares stylesheet",()=>{const pkg=JSON.parse(readFileSync("package.json","utf8"));assert.ok(pkg.agnes.plugins.length>0)})\n',
              },
            ],
            nextAction:
              'Use plugin_helper_create, plugin_helper_install test, then commit to submit a human review. Only Settings → Plugins or the candidate CLI can publish the reviewed hash.',
          })
        const manifest = {
          name: 'my-agh-plugin',
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          exports: './index.mjs',
          agnes: {
            plugins: [
              {
                apiRange: '^1.4.0',
                id: 'ext:my-agh-plugin/main',
                export: 'main',
                inject: [kind === 'tool' ? 'extension' : 'skills'],
              },
            ],
          },
        }
        const source =
          kind === 'tool'
            ? toolSource
            : "export const main = { inject: ['skills'], apply(ctx) { ctx.skills.register({ name: 'my-workflow', description: 'Use when the user requests this workflow.', body: 'Describe the concrete workflow here.' }) } }\n"
        return result({
          host: 'Agnes Harness',
          apiVersion: '1.4.0',
          guidance:
            'Understand the requested behavior, select the minimum capabilities and implement it using the template. Rename the package, row and tool/Skill. agnes.plugins named exports and inject must match the exported plugin object. Tool schemas require TypeBox Kind symbols, with all ToolMeta fields shown. Use invocation ctx.fs/net/shell for user operations; never use ambient Node access to bypass AGH policy. Install executes generated JavaScript with local process privileges; inspection does not prove safety or correctness. This first helper accepts text-only self-contained ESM, tool/Skill rows or the skin guide template, no dependencies/scripts; replacement must review the installed base hash. Advanced services/client UI follow the public author guide and the standard package manager. Save only in the Host private candidate area via plugin_helper_create; plugin_helper_install test asks permission to run Node tests, commit submits the passing hash for human review. The human must publish in Settings → Plugins; status reads the durable candidate, and publication affects only new sessions. Do not claim UI effects were verified from backend status. Never bypass denial with shell/config edits.',
          documentation: 'https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/develop/plugins.md',
          files: [
            { path: 'package.json', content: JSON.stringify(manifest, null, 2) },
            { path: 'index.mjs', content: source },
            {
              path: 'test/plugin.test.mjs',
              content:
                kind === 'tool'
                  ? 'import {test} from "node:test";import assert from "node:assert/strict";import {createPluginTestHost} from "@agnes/plugin-runtime/testkit";import {createPluginTestRegistration} from "@agnes/host/testkit";import {main} from "../index.mjs";test("counts words",async()=>{const host=await createPluginTestHost(main,{registration:createPluginTestRegistration()});try{assert.deepEqual((await host.invoke("my_text_stats",{text:"hello world"})).structured,{characters:11,words:2})}finally{await host.dispose()}})\n'
                  : 'import {test} from "node:test";import assert from "node:assert/strict";import {main} from "../index.mjs";test("registers Skill data",()=>{let skill;main.apply({skills:{register(value){skill=value}}});assert.equal(skill.name,"my-workflow");assert.ok(skill.body)})\n',
            },
          ],
        })
      },
    })
    api.registerTool({
      name: 'plugin_helper_create',
      description:
        'Save newly authored AGH plugin files only in the Host candidate area outside discovery roots. Read plugin_helper_guide first. Returns draft with candidateId and candidateHash; does not install or execute code. Stop on policy rejection; do not bypass using shell.',
      parameters: object({ files: array(object({ path: string(240), content: string(256 * 1024, 0) }), 32) }),
      meta: meta(false, 'always'),
      async execute({ files }, ctx) {
        return result(await port(ctx).request({ action: 'prepare', files }))
      },
    })
    api.registerTool({
      name: 'plugin_helper_install',
      description:
        'Run Node tests with explicit permission, submit a passing candidate for human review, or inspect its status. commit never installs/trusts/enables. Only a human can publish the exact reviewed hash in Settings → Plugins. Denial and failure must not be bypassed.',
      parameters: object({ action: enumeration('test', 'commit', 'status'), proposalId: string(80) }),
      meta: meta(false, 'always'),
      async execute(input, ctx) {
        return result(await port(ctx).request(input))
      },
    })
  },
}
