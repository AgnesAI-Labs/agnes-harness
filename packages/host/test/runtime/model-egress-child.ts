import { join } from 'node:path'
import { createReferenceModelEgress } from '../../../../examples/runtime-reference/src/providers/model-egress.js'
import { createSecretsFile } from '../../src/adapters/secrets.js'
import { createModelEgress, type ModelEgressOptions } from '../../src/runtime/model/model-egress.js'
import { CONSUMER } from './model-egress-fixture.js'
import { boundary, loopback, rule, scope, secrets } from './network-secrets-fixture.js'

const [kind, root, portText, handleText] = process.argv.slice(2)
if ((kind !== 'default' && kind !== 'reference') || !root || !portText || !handleText)
  throw new Error('Invalid cold fixture')
const auth = boundary(),
  port = Number(portText)
const binding = {
  contract: 'agh.model-adapter',
  logicalName: 'model',
  providerId: 'agh.default/model-adapter',
  bindingId: 'model-binding',
}
const call = auth.call({ bindingId: binding.bindingId })
const broker = secrets(kind, join(root, 'broker'), auth, {
  source: createSecretsFile({ dir: join(root, 'home', 'secrets') }),
  entries: [{ secretId: 'credential', versions: [{ version: 'v1', ref: 'secret://model/key' }] }],
  grants: [{ principalRef: call.principalRef, scope, binding: CONSUMER }],
})
const options: ModelEgressOptions = {
  installation: {
    binding,
    route: 'local-model',
    api: 'openai-completions',
    endpointRef: 'model-endpoint',
    consumer: CONSUMER,
    handle: JSON.parse(handleText),
  },
  endpoints: [
    {
      endpointRef: 'model-endpoint',
      method: 'POST',
      target: {
        targetId: 'model-peer',
        scheme: 'http',
        host: 'localhost',
        port,
        path: '/v1/chat/completions',
      },
    },
  ],
  current: (input) => input === call,
  network: {
    identity: auth.identity,
    tenantId: 'tenant',
    authorize: () => true,
    rules: [rule(port, { targetId: 'model-peer' })],
    resolver: loopback,
  },
  secrets: broker,
}
const transport =
  kind === 'default' ? createModelEgress(options, call) : createReferenceModelEgress(options, call)
try {
  const reply = await transport.fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  })
  process.stdout.write(JSON.stringify({ status: reply.status }))
} catch (problem) {
  const issue = problem as { code: string; detailCode: string }
  process.stdout.write(JSON.stringify({ code: issue.code, detailCode: issue.detailCode }))
} finally {
  await transport.close()
  await broker.close()
}
