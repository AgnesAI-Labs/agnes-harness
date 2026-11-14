// Captures the hooks the plugin row registers, so tests call them the way the kernel does.
import { createHookStateCell } from '../../src/runtime/hook-state.js'
import { registerHooks } from '../../src/runtime/hooks.js'

type Handler = (payload: unknown, ctx: unknown) => unknown
export function hookHarness() {
  const handlers = new Map<string, Handler>()
  const plugin = {
    hooks: {
      register: (event: string, handler: Handler) => {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
    },
  }
  const cell = createHookStateCell()
  const disposers = registerHooks(plugin as never, cell)
  const ctx = (key: string) => ({ session: { key, lane: 'main', workspaceRoot: '/' } })
  return {
    cell,
    disposers,
    context: (key: string) =>
      handlers.get('context')!({ sections: [], surfaceDigest: { nodes: 0, tokensEstimate: 0 } }, ctx(key)),
    toolCall: (key: string, name: string, args: unknown = {}) =>
      handlers.get('tool_call')!({ name, args }, ctx(key)),
  }
}
