import type { LoopFactory, ToolPolicy } from '../src/index.js'
import { defineProviderKind, type ProviderRegistrationPort } from '../src/provider-kind.js'

function providerTypes(port: ProviderRegistrationPort, loop: LoopFactory, policy: ToolPolicy) {
  port.register('loop', 'test', loop)
  const result: ToolPolicy = port.resolve('tool-policy', 'test')
  void result
  // @ts-expect-error A string kind cannot choose an unrelated provider type.
  port.register('loop', 'test', policy)
  // @ts-expect-error Resolution has the type associated with the kind.
  const incorrect: LoopFactory = port.resolve('tool-policy', 'test')
  void incorrect
  const token = defineProviderKind<ToolPolicy>({ kind: 'custom-policy', validate() {} })
  port.register(token, 'test', policy)
  // @ts-expect-error Tokens are invariant in their provider type.
  port.register(token, 'test', loop)
}
void providerTypes
