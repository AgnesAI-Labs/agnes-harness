import type { McpCallRequest } from '@agnes/protocol/runtime'
import { fixture, type Kind, type Transport } from '../mcp-fixture.js'

const [kind, transport, root, rawPort] = process.argv.slice(2)
if (
  !root ||
  !['default', 'reference'].includes(kind ?? '') ||
  !['stdio', 'streamable-http'].includes(transport ?? '')
)
  throw new Error('Invalid provider fixture arguments')
const subject = await fixture(
  kind as Kind,
  transport as Transport,
  root,
  rawPort ? Number(rawPort) : undefined,
)
process.send?.({ ready: true })
process.on(
  'message',
  (message: { id: string; op: 'connect' | 'call'; request?: McpCallRequest; invocationId: string }) => {
    const call = subject.auth.call({ invocationId: message.invocationId })
    const pending =
      message.op === 'connect' ? subject.connect(call) : subject.service.call(message.request, call)
    void pending.then(
      (result) => process.send?.({ id: message.id, result }),
      () => process.send?.({ id: message.id, failed: true }),
    )
  },
)
process.on('disconnect', () => {
  void subject.close().then(() => process.exit(0))
})
