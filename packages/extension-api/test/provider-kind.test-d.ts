import type { LoopFactory, ToolPolicy, WebhookTriggerProvider } from '../src/index.js'
import { defineProviderKind, type ProviderRegistrationPort } from '../src/provider-kind.js'
import { defineServiceKind, type ServiceInstance, type ServicePorts } from '../src/service-provider.js'

function providerTypes(
  port: ProviderRegistrationPort,
  loop: LoopFactory,
  policy: ToolPolicy,
  webhook: WebhookTriggerProvider,
) {
  port.register('webhook-trigger', 'test', webhook)
  const trigger: WebhookTriggerProvider = port.resolve('webhook-trigger', 'test')
  void trigger
  // @ts-expect-error Webhook providers do not expose Loop authority.
  port.register('webhook-trigger', 'test', loop)
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
function serviceBinding(port: ProviderRegistrationPort, loop: LoopFactory) {
  const kind = defineServiceKind<ServiceInstance & { ready(): boolean }, ServicePorts>({
    kind: 'sample-service',
    cardinality: 'single',
    instanceScope: 'request',
    ports: ['ledger'],
  })
  const dispose: () => Promise<void> = port.register(kind, 'test', {
    id: 'one',
    version: '1.0.0',
    open: () => ({ ready: () => true }),
  })
  const bound: Promise<ServiceInstance & { ready(): boolean }> = port.bindOwn(kind)
  void [dispose, bound]
  // @ts-expect-error A service token does not accept an unrelated provider.
  port.register(kind, 'test', loop)
}
void providerTypes
void serviceBinding
