import type { Disposer, ToolDef } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { type ShellJobs, standaloneShellJobs } from '../../jobs/src/registry.js'
import { type LspSessions, standaloneLsp } from '../../lsp/src/registry.js'
import { type FileChangeRecorder, fileChangeReceipt } from './file-change.js'
import { createEditTool, editTool } from './tools/edit.js'
import { readTool } from './tools/read.js'
import { createShellTool, shellTool } from './tools/shell.js'
import { todoTool } from './tools/todo.js'
import { createWriteTool, writeTool } from './tools/write.js'

// The tools this extension actually registers, in the order the manifest names them. The manifest
// is what grants the authority and it already names all five; this list is what claims it. The
// search tools (grep/find/ls) moved to the sibling `tools-search` extension — this package was at
// its line-count ceiling, and they shared a walker nothing else here imports. Registering fewer
// than the manifest allows is safe in the direction that matters — a name nobody registers is a
// name nobody can call.
export const TOOLS_CORE: readonly ToolDef[] = [readTool, writeTool, editTool, shellTool, todoTool]

// The placeholder the shell tool puts at the head of its argv, re-exported so the deployment's
// sandbox implementation can substitute an interpreter for it without importing a tool module.
export { SHELL_SENTINEL } from './tools/shell.js'

export function createToolsCoreExtension(
  jobs: ShellJobs = standaloneShellJobs,
  lsp: LspSessions = standaloneLsp,
  preset: Record<string, unknown> = {},
) {
  const logicalChanges = (preset.tools as { logical_changes?: boolean } | undefined)?.logical_changes ?? false
  const observationMs = (preset.tools as { shell_observation_ms?: number } | undefined)?.shell_observation_ms
  return defineAgnesPlugin({
    inject: ['tools', 'hooks', 'eventLog'],
    apply(plugin: Context) {
      const record: FileChangeRecorder = async (input, context) => {
        const receipt = fileChangeReceipt(input, context)
        if (receipt) await plugin.eventLog.append('file-change', receipt)
      }
      const tools = [
        readTool,
        createWriteTool(record, lsp),
        createEditTool(record, lsp, logicalChanges),
        createShellTool(jobs, observationMs),
        todoTool,
      ]
      const disposers = tools.map((t) => plugin.tools.register(t))
      disposers.push(
        plugin.hooks.register('shutdown', async (_payload, ctx) => {
          await jobs.closeSession(ctx.session.key, ctx.session.lane)
        }),
      )
      const dispose: Disposer = async () => {
        for (const d of disposers) d()
        await jobs.dispose()
      }
      return dispose
    },
  })
}
export default createToolsCoreExtension()
