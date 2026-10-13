import type { LoopFactory, ToolPolicy, WebhookTriggerProvider } from '../src/index.js'
import { loopKind, toolPolicyKind, webhookTriggerKind } from '../src/index.js'
import { defineKind, type ProviderRegistrationPort } from '../src/provider-kind.js'
import type { ServiceInstance, ServicePorts } from '../src/service-provider.js'

function providerTypes(
  port: ProviderRegistrationPort,
  loop: LoopFactory,
  policy: ToolPolicy,
  webhook: WebhookTriggerProvider,
) {
  port.register(webhookTriggerKind, webhook)
  const trigger: WebhookTriggerProvider = port.resolve(webhookTriggerKind, 'test')
  void trigger
  // @ts-expect-error Webhook providers do not expose Loop authority.
  port.register(webhookTriggerKind, loop)
  port.register(loopKind, loop)
  const result: ToolPolicy = port.resolve(toolPolicyKind, 'test')
  void result
  // @ts-expect-error A kind token cannot choose an unrelated provider type.
  port.register(loopKind, policy)
  // @ts-expect-error Resolution has the type associated with the kind.
  const incorrect: LoopFactory = port.resolve(toolPolicyKind, 'test')
  void incorrect
  const token = defineKind<ToolPolicy>({ kind: 'custom-policy', validate() {} })
  port.register(token, policy)
  // @ts-expect-error Tokens are invariant in their provider type.
  port.register(token, loop)
}
function serviceBinding(port: ProviderRegistrationPort, loop: LoopFactory) {
  const kind = defineKind<ServiceInstance & { ready(): boolean }, ServicePorts>({
    kind: 'sample-service',
    bind: { cardinality: 'single', instanceScope: 'request', ports: ['ledger'] },
  })
  const dispose: () => Promise<void> = port.register(kind, {
    id: 'one',
    version: '1.0.0',
    open: () => ({ ready: () => true }),
  })
  const bound: Promise<ServiceInstance & { ready(): boolean }> = port.bindOwn(kind)
  void [dispose, bound]
  // @ts-expect-error A service token does not accept an unrelated provider.
  port.register(kind, loop)
}
void providerTypes
void serviceBinding
