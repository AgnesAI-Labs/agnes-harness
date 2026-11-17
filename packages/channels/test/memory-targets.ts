// The Host pairing port as the channel bridge tests stand it in.
/** An in-memory stand-in for the Host pairing port: one live code, recorded calls. */
export function memoryTargets() {
  const pairings: { id: string; accountId: string; chatId: string; userId: string; instance: string }[] = []
  const delivered: import('@agnes/extension-api').ChannelTargetEvent[] = []
  const links = new Map<string, Parameters<import('../src/targets.js').ChannelTargetsPort['attach']>[1]>()
  const state = { code: 'ABCD-EFGH' as string | undefined, fail: 0, retained: [] as unknown[] }
  const port: import('../src/targets.js').ChannelTargetsPort = {
    retain: (instances) => state.retained.push(instances),
    attach: (instanceId, link) => {
      links.set(instanceId, link)
      return () => links.delete(instanceId)
    },
    pending: () => !!state.code,
    expectsCode: (_instanceId, text) => !!state.code && /^[A-Z2-9]{8}$/i.test(text.replace(/[\s-]/g, '')),
    confirm: (instance, text, chat) => {
      if (text.replace(/[\s-]/g, '').toUpperCase() !== state.code?.replace('-', '')) return undefined
      state.code = undefined
      pairings.push({ ...chat, instance })
      return { label: 'Desk' }
    },
    find: (instance, chatId) => pairings.find((p) => p.instance === instance && p.chatId === chatId),
    deliver: async (_pairing, event) => {
      if (state.fail-- > 0) throw new Error('service stopped')
      delivered.push(event)
    },
    drop: (id) => {
      pairings.splice(
        pairings.findIndex((p) => p.id === id),
        1,
      )
    },
    paired: (instance, id) => pairings.some((p) => p.instance === instance && p.id === id),
    pairings: (instance) => pairings.filter((p) => p.instance === instance).map((p) => ({ id: p.id })),
  }
  return { port, pairings, delivered, links, state }
}
