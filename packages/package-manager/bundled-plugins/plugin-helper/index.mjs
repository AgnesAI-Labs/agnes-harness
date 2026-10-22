import { authoringGuidance, toolSafetyGuidance, verification } from './src/authoring.mjs'
import { panelFiles } from './src/panel.generated.mjs'
import { array, enumeration, object, optional, string } from './src/schema.mjs'
import { skinFiles, skinGuidance } from './src/skin.mjs'
import { skinTest } from './src/skin-test.mjs'
import { toolSource } from './src/templates.mjs'

const result = (value, action) => {
  const { files, sourceFiles, preview, ...receipt } = value
  const data =
    value.candidateId && value.candidateHash
      ? {
          ...receipt,
          operation: action,
          stage: 'result',
          verification: verification(value),
          browserCheck:
            '未验证：请检查亮暗模式、禁用及默认外观恢复。 / Not verified: check light/dark mode, disable and restore default appearance.',
        }
      : value
  const repairHint =
    value.tests?.state === 'failed' &&
    /E_TOOLDEF_META|Test port not configured/.test(value.tests.output ?? '')
      ? toolSafetyGuidance
      : ''
  return {
    ...(action !== 'candidate.show' &&
    (['failed', 'interrupted', 'cancelled', 'rejected'].includes(data.state) ||
      data.tests?.state === 'failed')
      ? { isError: true }
      : {}),
    content: [
      {
        type: 'text',
        text:
          JSON.stringify(
            value.candidateId
              ? {
                  ...data,
                  tests: data.tests && {
                    ...data.tests,
                    output: data.tests.state === 'failed' ? data.tests.output?.slice(0, 8192) : undefined,
                  },
                }
              : data,
          ) + (repairHint ? `\nRepair hint / 修复提示: ${repairHint}` : ''),
      },
    ],
    structured: data,
  }
}
// The Host already sanitizes RPC diagnostics; project only merge refusal codes and relative paths.
const writeDiagnostics = (error) => {
  const hints = {
    'conflicting-write-path': 'A path cannot be in both files and remove. / 同一路径不能同时写入和删除。',
    'missing-remove-path': 'Remove only an existing candidate path. / 只能删除候选中的已有路径。',
  }
  const items = error?.data?.diagnostics ?? error?.diagnostics
  return Array.isArray(items)
    ? items
        .slice(0, 16)
        .flatMap(({ code, path }) =>
          Object.hasOwn(hints, code) &&
          typeof path === 'string' &&
          path.length <= 240 &&
          /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) &&
          !path.split('/').includes('..')
            ? [{ code, path, field: 'remove', name: path, hint: hints[code] }]
            : [],
        )
    : []
}
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
  if (!ctx?.pluginManage) throw new Error('PLUGIN_PORT_UNAVAILABLE')
  if (ctx.session.depth !== 0) throw new Error('PLUGIN_LOCAL_MAIN_SESSION_REQUIRED')
  ctx.signal.throwIfAborted()
  return ctx.pluginManage
}
export const pluginHelper = {
  inject: ['tools'],
  apply(ctx) {
    const api = {
      register(definition) {
        const execute = definition.execute
        ctx.tools.register({
          ...definition,
          async execute(args, context) {
            try {
              return await execute(args, context)
            } catch (error) {
              const code =
                [error?.data?.reason, error?.data?.code, error?.code, error?.message].find(
                  (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value),
                ) ?? 'PLUGIN_HELPER_FAILED'
              return {
                isError: true,
                ...result({
                  state: 'failed',
                  code,
                  diagnostics: writeDiagnostics(error),
                  operation:
                    definition.name === 'plugin_helper_create'
                      ? 'candidate.create'
                      : definition.name === 'plugin_helper_write'
                        ? 'candidate.write'
                        : { test: 'candidate.test', commit: 'candidate.submit', status: 'candidate.show' }[
                            args.action
                          ],
                  stage: context?.pluginManage ? 'request' : 'host-capability',
                  candidateId: args.candidateId ?? args.proposalId ?? null,
                  message:
                    '操作未完成；复述 operation、stage、candidateId，保留同一草稿，不编造设置开关。 / Report operation, stage and candidateId; keep the same draft, never invent settings/switches. Do not bypass denial with shell/config edits.',
                }),
              }
            }
          },
        })
      },
    }
    api.register({
      name: 'plugin_helper_guide',
      description:
        'Before creating an Agnes Harness (AGH) plugin, read this version-matched authoring guide and runnable template. The default target for “write a plugin” in this app is AGH. Use kind: skill for authored Skill packages; connecting an existing MCP server uses mcp-helper. This helper authors ordinary tool, tool with panel, Skill or pure CSS skin plugin rows; follow the shared recommended path returned by the guide.',
      parameters: object({ kind: enumeration('tool', 'tool-with-panel', 'skill', 'skin') }),
      meta: meta(true),
      async execute({ kind }, ctx) {
        const authoringCapability = ctx?.pluginManage
          ? 'supplied-authorization-checked-per-call'
          : 'unavailable-host-capability'
        if (kind === 'tool-with-panel') {
          const guide = {
            host: 'Agnes Harness',
            apiVersion: '5.0.0',
            authoringCapability,
            authoringPath: authoringGuidance,
            guidance:
              'To-do tool and React ESM page share an owner store via profile services. Rename all IDs together. Extend the same candidate using the author reference, never private Host/install source. Tests cover DOM/recovery/restart; verify installation/browser appearance separately. / 工具与 React ESM 页面通过 profile query/effect 共享 owner store；包、行、工具、服务与客户端 ID 一起改。在同一候选扩展，使用作者参考，不翻查私有宿主或安装源码。测试覆盖 DOM、操作恢复及 Host 重建；安装和浏览器外观另验。',
            initialCandidate:
              'Do not reconstruct the template from previewFiles. If plugin_scaffold is in the current catalog, call plugin_scaffold({template:"tool-with-panel",name:"my-agh-plugin"}) ONCE to save the complete canonical tree, including manifest, client and tests. Otherwise, ONLY IF run_code is offered in this request, use it: const guide = await tools.plugin_helper_guide({kind:"tool-with-panel"}); const created = await tools.plugin_helper_create({files:guide.files}); return {candidateId:created.candidateId,candidateHash:created.candidateHash}; Then read that SAME candidate and use mode: merge with changed files only. / 不要从预览手抄或重建模板；优先调用现有 plugin_scaffold 一次保存完整模板（包含清单、客户端和测试），之后读取同一候选，用 mode: merge 只写改动文件。',
            files: panelFiles,
          }
          // Keep the model-visible guide valid JSON within the default 32 KiB output budget.
          // The structured receipt retains the complete canonical template, including its tests.
          const { files, ...info } = guide
          return {
            ...result(guide),
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...info,
                  templateFiles: files.map((file) => file.path),
                  previewFiles: files
                    .filter((file) =>
                      ['src/index.ts', 'client/index.js', 'client/agnes.client.json'].includes(file.path),
                    )
                    .map((file) => ({
                      path: file.path,
                      content: file.content.slice(0, 2048),
                      truncated: file.content.length > 2048,
                    })),
                  templateRead:
                    'Preview only, not a complete candidate tree. Full files are in structured.files. Use plugin_helper_create once, then plugin_candidate_read to read the current hash, then mode: merge with changed files only. / 此处仅预览，不能当作完整候选写回。完整模板在 structured.files；创建一次后用 plugin_candidate_read 读取当前摘要，再用 mode: merge 只写变化文件。',
                }),
              },
            ],
          }
        }
        if (kind === 'skin')
          return result({
            host: 'Agnes Harness',
            apiVersion: '5.0.0',
            authoringCapability,
            authoringPath: authoringGuidance,
            guidance: skinGuidance,
            files: [
              ...skinFiles(),
              {
                path: 'test/skin.test.mjs',
                content: skinTest,
              },
            ],
            nextAction:
              'Use plugin_helper_create once, then plugin_candidate_read/write, plugin_test and plugin_install_local on the same candidate. Compatibility plugin_helper_install test/commit/status uses the same ID; full-access sessions publish automatically; other presets require human administration.',
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
                apiRange: '^5.0.0',
                id: 'ext:my-agh-plugin/main',
                export: 'main',
                inject: kind === 'tool' ? ['tools'] : ['skills'],
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
          apiVersion: '5.0.0',
          authoringCapability,
          authoringPath: authoringGuidance,
          guidance:
            'Understand the requested behavior, select the minimum capabilities and implement it using the template. Rename the package, row and tool/Skill. agnes.plugins named exports and inject must match the exported plugin object. Tool schemas require TypeBox Kind symbols, with explicit ToolMeta safety fields; optional fields have defaults. Use invocation ctx.fs/net/exec for user operations; never use ambient Node access to bypass AGH policy. Install executes generated JavaScript with local process privileges; inspection does not prove safety or correctness. This helper supplies self-contained tool/Skill/skin files or the existing tool-with-panel scaffold; no arbitrary dependencies/lifecycle scripts; replacement must review the installed base hash. For Node tests, import createPluginTestHost from @agnes/host/author-testkit and call createPluginTestHost(main); the registration bridge is automatic. Advanced services/client UI follow the public import map and the standard package manager. Follow authoringPath: save once via plugin_helper_create, edit the same candidate with plugin_candidate_read/write, test with plugin_test, submit with plugin_install_local. Compatibility plugin_helper_install test/commit/status acts on the same ID; commit submits the exact candidate. Under full-access it installs, trusts and enables automatically; other presets require human publication in Settings → Plugins; status reads the durable candidate, and publication affects only new sessions. Do not claim UI effects were verified from backend status. Never bypass denial with shell/config edits.',
          documentation: 'https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md',
          files: [
            { path: 'package.json', content: JSON.stringify(manifest, null, 2) },
            { path: 'index.mjs', content: source },
            {
              path: 'test/plugin.test.mjs',
              content:
                kind === 'tool'
                  ? 'import {test} from "node:test";import assert from "node:assert/strict";import {createPluginTestHost} from "@agnes/host/author-testkit";import {main} from "../index.mjs";test("counts words",async()=>{const host=await createPluginTestHost(main);try{assert.deepEqual((await host.invoke("my_text_stats",{text:"hello world"})).structured,{characters:11,words:2})}finally{await host.dispose()}})\n'
                  : 'import {test} from "node:test";import assert from "node:assert/strict";import {createPluginTestHost} from "@agnes/host/author-testkit";import {main} from "../index.mjs";test("registers Skill data through the Host with an explicit skills service",async()=>{let skill;const host=await createPluginTestHost(main,{services:{skills:{register(value){skill=value;return()=>{}}}}});try{assert.equal(skill.name,"my-workflow");assert.ok(skill.body)}finally{await host.dispose()}})\n',
            },
          ],
        })
      },
    })
    api.register({
      name: 'plugin_helper_create',
      description:
        'Save newly authored AGH plugin files only in the Host candidate area outside discovery roots. Read plugin_helper_guide first. Initial creation only; after any later-stage failure keep the same candidate. Returns draft with candidateId and candidateHash; does not install or execute code. Stop on policy rejection; do not bypass using shell.',
      parameters: object({ files: array(object({ path: string(240), content: string(128 * 1024, 0) }), 32) }),
      meta: meta(false, 'always'),
      async execute({ files }, ctx) {
        if (
          files.some((file) => Buffer.byteLength(file.content) > 128 * 1024) ||
          files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 256 * 1024
        )
          throw new Error('PLUGIN_FILES_INVALID')
        const value = await port(ctx).request({ action: 'candidate.create', files })
        return result({ ...value, proposalId: value.candidateId }, 'candidate.create')
      },
    })
    api.register({
      name: 'plugin_helper_write',
      description:
        'Alias of plugin_candidate_write: read the same candidate, then mode: merge with changed files and optional remove paths. Untouched files remain; default replace rewrites the entire tree. expectedHash is required. Every edit invalidates tests and review.',
      parameters: object({
        candidateId: string(80),
        expectedHash: string(71),
        files: array(object({ path: string(240), content: string(128 * 1024, 0) }), 64),
        mode: optional(enumeration('replace', 'merge')),
        remove: optional(array(string(240), 64)),
      }),
      meta: meta(false, 'always'),
      async execute(input, ctx) {
        return result(await port(ctx).request({ action: 'candidate.write', ...input }), 'candidate.write')
      },
    })
    api.register({
      name: 'plugin_helper_install',
      description:
        'Compatibility aliases for plugin_test / plugin_install_local / plugin_candidate_read on the same candidateId (as proposalId). Run Node author tests bound to the exact hash, submit a passing candidate, or inspect its status. Full-access automatically allows tests on every platform and commit installs, trusts and enables; other presets require test confirmation and human publication in Settings → Plugins. Passing tests do not verify installation or browser appearance. Denial and failure must not be bypassed.',
      parameters: object({ action: enumeration('test', 'commit', 'status'), proposalId: string(80) }),
      meta: meta(false, 'always'),
      policyVersion: 'candidate-test-v2',
      classify(input) {
        return {
          isReadOnly: false,
          isDestructive: false,
          replay: 'never',
          requiresApproval: input.action === 'test' ? 'never' : 'always',
          approvalScopes: [],
        }
      },
      async execute(input, ctx) {
        return result(
          await port(ctx).request(input),
          { test: 'candidate.test', commit: 'candidate.submit', status: 'candidate.show' }[input.action],
        )
      },
    })
  },
}
