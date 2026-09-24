import { type Disposer, defineExtension, type ToolDef } from '@agnes/extension-api'
import { findTool } from './tools/find.js'
import { grepTool } from './tools/grep.js'
import { lsTool } from './tools/ls.js'

// The tools this extension actually registers, in the order the manifest names them. The manifest
// is what grants the authority and it already names all three; this list is what claims it. These
// three (plus the walker they share) moved here from `tools-core`, which was at its 800-line
// ceiling — splitting them into a sibling extension was the fix the package's own plan chose over
// raising that cap. Registering fewer than the manifest allows is safe in the direction that
// matters — a name nobody registers is a name nobody can call.
export const TOOLS_SEARCH: readonly ToolDef[] = [grepTool, findTool, lsTool]

// The module the manifest's `entry` points at. Registration is the whole of it: a factory reaching
// for anything else would be taking authority this manifest does not declare.
export default defineExtension((agnes) => {
  const disposers = TOOLS_SEARCH.map((t) => agnes.registerTool(t))
  const dispose: Disposer = () => {
    for (const d of disposers) d()
  }
  return dispose
})
