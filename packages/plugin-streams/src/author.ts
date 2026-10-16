import type { PluginStreamsPort, StreamHandler } from '@agnes/extension-api'
import { type Capabilities, type JsonValue, transportCapabilityProblems } from '@agnes/protocol'
import type { PluginStreamBroker } from './broker.js'

/** The daemon loader supplies this identity and declarations after current-authority admission. */
export function bindPluginStreams(
  broker: PluginStreamBroker,
  authority: {
    owner: string
    profileId: string
    activationId: string
    signal: AbortSignal
    capabilities: Pick<Capabilities, 'streams' | 'services'>
    assertCurrent(): void
    compileInput(
      schema: NonNullable<Capabilities['streams']>[number]['inputSchema'],
    ): (value: JsonValue) => boolean
  },
): PluginStreamsPort {
  if (transportCapabilityProblems(authority.capabilities).length)
    throw new Error('invalid stream capabilities')
  const declarations = new Map(structuredClone(authority.capabilities.streams ?? []).map((d) => [d.name, d]))
  return Object.freeze({
    register(name: string, handler: StreamHandler) {
      authority.assertCurrent()
      authority.signal.throwIfAborted()
      const declaration = declarations.get(name)
      if (!declaration || typeof handler !== 'function') throw new Error('stream is not declared')
      const validate = authority.compileInput(declaration.inputSchema)
      return broker.register({
        owner: authority.owner,
        profileId: authority.profileId,
        activationId: authority.activationId,
        signal: authority.signal,
        declaration,
        validateInput(input) {
          authority.assertCurrent()
          return validate(input)
        },
        handler,
      })
    },
  })
}
