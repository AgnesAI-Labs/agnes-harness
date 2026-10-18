import { authoringGuidance, verification } from './src/authoring.mjs'
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
  return {
    ...(action !== 'candidate.show' &&
    (['failed', 'interrupted', 'cancelled', 'rejected'].includes(data.state) ||
      data.tests?.state === 'failed')
      ? { isError: true }
      : {}),
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          value.candidateId ? { ...data, tests: data.tests && { ...data.tests, output: undefined } } : data,
        ),
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
            apiVersion: '4.0.0',
            authoringCapability,
            authoringPath: authoringGuidance,
            guidance:
              'Working tool-with-panel scaffold: a shared to-do tool/owner store, profile list query and add/toggle effect, and a React ESM page calling ctx.profile.services. Rename package, row, tool, service and client IDs together. Extend this SAME candidate using the author reference, not Host/installed source searches; private install dirs are denied by design. Inherited tests exercise DOM interactions/errors and Host restart retention; real-browser appearance and installation still need verification. / 可读写待办模板：工具与 profile query/effect 共享 owner store，页面从 react 导入 React 并调用 ctx.profile.services。在同一候选扩展，保持服务等名称一致，使用作者参考，不翻查私有安装源码猜 API。继承测试覆盖 DOM 交互、错误及 Host 重建后的数据保留；安装与真实浏览器外观仍须验证。',
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
                  previewFiles: files.filter((file) =>
                    ['src/index.ts', 'client/index.js', 'client/agnes.client.json'].includes(file.path),
                  ),
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
            apiVersion: '4.0.0',
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
              'Use plugin_helper_create once, then plugin_candidate_read/write, plugin_test and plugin_install_local on the same candidate. Compatibility plugin_helper_install test/commit/status uses the same ID; only human administration publishes.',
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
                apiRange: '^4.0.0',
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
          apiVersion: '4.0.0',
          authoringCapability,
          authoringPath: authoringGuidance,
          guidance:
            'Understand the requested behavior, select the minimum capabilities and implement it using the template. Rename the package, row and tool/Skill. agnes.plugins named exports and inject must match the exported plugin object. Tool schemas require TypeBox Kind symbols, with explicit ToolMeta safety fields; optional fields have defaults. Use invocation ctx.fs/net/exec for user operations; never use ambient Node access to bypass AGH policy. Install executes generated JavaScript with local process privileges; inspection does not prove safety or correctness. This helper supplies self-contained tool/Skill/skin files or the existing tool-with-panel scaffold; no arbitrary dependencies/lifecycle scripts; replacement must review the installed base hash. For Node tests, import createPluginTestHost from @agnes/host/author-testkit and call createPluginTestHost(main); the registration bridge is automatic. Advanced services/client UI follow the public import map and the standard package manager. Follow authoringPath: save once via plugin_helper_create, edit the same candidate with plugin_candidate_read/write, test with plugin_test, submit with plugin_install_local. Compatibility plugin_helper_install test/commit/status acts on the same ID; commit only submits review. The human must publish in Settings → Plugins; status reads the durable candidate, and publication affects only new sessions. Do not claim UI effects were verified from backend status. Never bypass denial with shell/config edits.',
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
        'Compatibility aliases for plugin_test / plugin_install_local / plugin_candidate_read on the same candidateId (as proposalId). Run Node author tests with one exact-hash confirmation (full-access skips it only with OS isolation), submit a passing candidate for human review, or inspect its status. commit never installs/trusts/enables. Passing tests do not verify installation or browser appearance. Only a human can publish the exact reviewed hash in Settings → Plugins. Denial and failure must not be bypassed.',
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
