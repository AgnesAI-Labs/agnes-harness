import { type Disposer, defineExtension, type ToolDef } from '@agnes/extension-api'
import { editTool } from './tools/edit.js'
import { readTool } from './tools/read.js'
import { shellTool } from './tools/shell.js'
import { todoTool } from './tools/todo.js'
import { writeTool } from './tools/write.js'

// The tools this extension actually registers, in the order the manifest names them. The manifest
// is what grants the authority and it already names all five; this list is what claims it. The
// search tools (grep/find/ls) moved to the sibling `tools-search` extension — this package was at
// its line-count ceiling, and they shared a walker nothing else here imports. Registering fewer
// than the manifest allows is safe in the direction that matters — a name nobody registers is a
// name nobody can call.
export const TOOLS_CORE: readonly ToolDef[] = [readTool, writeTool, editTool, shellTool, todoTool]

// The module the manifest's `entry` points at. Registration is the whole of it: a factory reaching
// for anything else would be taking authority this manifest does not declare.
// The placeholder the shell tool puts at the head of its argv, re-exported so the deployment's
// sandbox implementation can substitute an interpreter for it without importing a tool module.
export { SHELL_SENTINEL } from './tools/shell.js'

export default defineExtension((agnes) => {
  const disposers = TOOLS_CORE.map((t) => agnes.registerTool(t))
  const dispose: Disposer = () => {
    for (const d of disposers) d()
  }
  return dispose
})
