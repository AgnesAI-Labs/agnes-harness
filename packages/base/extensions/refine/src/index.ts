import type { HarnessSeam } from '@agnes/core'
import type { Disposer } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createProposeTool } from './propose-tool.js'
import { createRefineHarness } from './seam.js'

/** Production factory: the tool and compact trigger share the assembly's durable session log. */
export function createRefineExtension(seam: Pick<HarnessSeam, 'propose'>) {
  return defineAgnesPlugin({
    inject: ['tools', 'hooks', 'eventLog'],
    apply(ctx: Context) {
      const disposers: Disposer[] = [
        ctx.tools.register(createProposeTool(seam)),
        ctx.hooks.register('compact', async () => {
          await ctx.eventLog.append('compact-trigger', {})
        }),
      ]
      return () => {
        for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
      }
    },
  })
}

export default createRefineExtension(createRefineHarness())
