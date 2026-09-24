import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
            files: skinFiles(),
            nextAction:
              'Use plugin_helper_create, review the preview, then plugin_helper_install commit for native approval. End the turn after submitted and verify status on a later turn.',
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
            'Understand the requested behavior, select the minimum capabilities and implement it using the template. Rename the package, row and tool/Skill. agnes.plugins named exports and inject must match the exported plugin object. Tool schemas require TypeBox Kind symbols, with all ToolMeta fields shown. Use invocation ctx.fs/net/shell for user operations; never use ambient Node access to bypass AGH policy. Install executes generated JavaScript with local process privileges; inspection does not prove safety or correctness. This first helper accepts text-only self-contained ESM, tool/Skill rows or the skin guide template, no dependencies/scripts or same-name replacement. Advanced services/client UI follow the public author guide and the standard package manager. Save via plugin_helper_create; review the preview before plugin_helper_install commit requests native approval. After submitted, end this turn; verify status and use actual tools on the next turn. Do not claim UI effects were verified from backend status. Never bypass denial with shell/config edits.',
          documentation: 'https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/develop/plugins.md',
          files: [
            { path: 'package.json', content: JSON.stringify(manifest, null, 2) },
            { path: 'index.mjs', content: source },
          ],
        })
      },
    })
    api.registerTool({
      name: 'plugin_helper_create',
      description:
        'Save newly authored AGH plugin files in a fresh workspace directory and inspect an exact content bundle. Read plugin_helper_guide first. Returns prepared with capabilities and integrity; does not install or execute candidate code. No imports of existing directories. Stop on policy rejection; do not bypass using shell.',
      parameters: object({ files: array(object({ path: string(240), content: string(256 * 1024, 0) }), 32) }),
      meta: meta(false, 'always'),
      async execute({ files }, ctx) {
        const management = port(ctx)
        // Daemon validates the full manifest and every path before any workspace write.
        const prepared = await management.request({ action: 'prepare', files })
        const directory = join(ctx.cwd, '.plugin-helper', randomUUID())
        try {
          for (const file of files) {
            ctx.signal.throwIfAborted()
            await ctx.fs.write(join(directory, ...file.path.split('/')), file.content)
          }
        } catch (error) {
          await management.request({ action: 'cancel', proposalId: prepared.proposalId }).catch(() => {})
          throw error
        }
        return result({
          ...prepared,
          directory,
          message:
            'Source saved and checked, not installed. Review the files and preview. commit asks the local user to approve installation into AGH.',
        })
      },
    })
    api.registerTool({
      name: 'plugin_helper_install',
      description:
        'Request native confirmation to install, trust and enable the exact prepared AGH plugin, or query/cancel its proposal. Creating a plugin does not authorize installation. submitted means pending activation: end this turn, then status checks actual running state; new tools appear on later turns. Denial/cancellation must not be retried or bypassed automatically.',
      parameters: object({ action: enumeration('commit', 'status', 'cancel'), proposalId: string(80) }),
      meta: meta(false),
      async execute(input, ctx) {
        return result(await port(ctx).request(input))
      },
    })
  },
}
