import { join } from 'node:path'
import {
  action,
  boundary,
  type Kind,
  loopback,
  network,
  refreshInput,
  request,
  resolveInput,
  rule,
  secrets,
} from './network-secrets-fixture.js'

const [kindArg, directory, mode, portArg] = process.argv.slice(2)
if ((kindArg !== 'default' && kindArg !== 'reference') || !directory) throw new Error('Invalid fixture input')
const kind: Kind = kindArg
const auth = boundary()
const port = Number(portArg)
const call = auth.call({ invocationId: 'crashed-request', deadline: '2099-01-01T00:00:00.000Z' })
if (mode === 'network' || mode === 'refresh') {
  const outbound = network(kind, join(directory, 'network'), auth, [rule(port)], { resolver: loopback })
  if (mode === 'network') {
    process.stdout.write('started\n')
    await outbound.request(request(port, '/slow'), call)
  } else {
    const broker = secrets(kind, join(directory, 'secrets'), auth, {
      refresh: async (_input, context) => {
        await outbound.request(request(port, '/slow'), context.call)
        return { state: 'unknown' }
      },
    })
    process.stdout.write('started\n')
    await broker.refresh(refreshInput, action(call))
  }
} else if (mode === 'secrets') {
  const broker = secrets(kind, join(directory, 'secrets'), auth)
  process.stdout.write(`${JSON.stringify(await broker.resolve(resolveInput, call))}\n`)
} else throw new Error('Unknown fixture mode')
// Parent kills the fixture after observing durable evidence. No graceful disposal is involved.
setInterval(() => {}, 1000)
