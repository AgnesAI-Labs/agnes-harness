import { expectTypeOf } from 'vitest'
import type { ExtensionAPI, SlotContext, SlotFill, SlotName, SlotPayloadMap } from '../src/index.js'

expectTypeOf<keyof SlotPayloadMap>().toEqualTypeOf<SlotName>()
expectTypeOf<SlotContext['session']>().not.toHaveProperty('toolUseId')
export function slotRegistrationProbes(api: ExtensionAPI) {
  api.registerSlot('notification', async (ctx) =>
    ctx.trigger.kind === 'turn_end' ? { title: 'x', body: 'y' } : null,
  )
  api.registerSlot('tool.card.inline', (ctx) => {
    if (ctx.trigger.kind === 'tool_result') expectTypeOf(ctx.trigger.toolUseId).toEqualTypeOf<string>()
    return { title: 'chart', chart: { kind: 'bar', series: [{ name: 'a', points: [{ x: 'q', y: 1 }] }] } }
  })
  // @ts-expect-error slot name is closed
  api.registerSlot('fake', () => null)
  // @ts-expect-error status line has its own payload
  const bad: SlotFill<'status.line'> = () => ({ title: 'x' })
  void bad
}
