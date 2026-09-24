import type { HarnessSeam } from '@agnes/core'
import { type Disposer, defineExtension } from '@agnes/extension-api'
import { createProposeTool } from './propose-tool.js'

/** Production factory: the tool and compact trigger share the assembly's durable session log. */
export function createRefineExtension(seam: Pick<HarnessSeam, 'propose'>) {
  return defineExtension((agnes) => {
    const disposers: Disposer[] = [
      agnes.registerTool(createProposeTool(seam)),
      agnes.registerHook('compact', async () => {
        await agnes.events.append('compact-trigger', {})
      }),
    ]
    return () => {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
    }
  })
}

// Host replaces this default through the package ecosystem factory. Keeping a non-accepting
// fallback means a loader that ignores that trusted assembly path cannot claim it queued work.
export default createRefineExtension({
  async propose() {
    return 'rejected'
  },
})
