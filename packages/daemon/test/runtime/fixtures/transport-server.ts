// A runtime client server in a process of its own, for the real-process transport tests: the daemon's
// private runtime listener and routes (`default`) or the reference server (`reference`), admitting one
// bearer, over an owner whose admitted cancels outlive the process in `<directory>/committed`. Prints
// `READY <baseUrl>` once it listens and one `OWNER <event>` line for every call that reaches the owner.
// A cancel whose request id starts with `hold` is committed and then never answered.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as Wire from '@agnes/protocol/runtime'
import { startReferenceTransport } from '../../../../../examples/runtime-reference/src/providers/transport.js'
import type { TransportBacking } from '../../../../extension-api/testkit/runtime/contracts/transport.js'
import type { RuntimeClientPorts } from '../../../src/runtime/transport.js'
import { listenWebSocket } from '../../../src/supervisor/ws.js'

const TRANSPORT_E2E_BEARER = 'transport-e2e-bearer'

const [provider = 'default', directory = '.'] = process.argv.slice(2)
const file = join(directory, 'committed')
const event = (text: string) => process.stdout.write(`OWNER ${text}\n`)
const committed = (requestId: string) =>
  existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(requestId)
const ok = <T>(value: T) => ({ ok: true as const, value })
const handle = (requestId: string, accepted: boolean): Wire.CommandHandle =>
  accepted
    ? {
        commandId: `command-${requestId}`,
        requestId,
        revision: 1,
        completion: 'runtime-accepted',
        status: 'accepted',
        result: null,
        error: null,
      }
    : {
        requestId,
        status: 'not-accepted',
        commandId: null,
        revision: null,
        completion: null,
        result: null,
        error: null,
      }
const snapshot = {
  page: { items: [], snapshot: 'snapshot-1', nextCursor: null, complete: true },
  nextCursor: null,
  complete: true,
}
let subscriptions = 0

const owner: TransportBacking = {
  operations: ['conversation.cancel', 'conversation.status', 'transport.catalogStatus'],
  async bootstrap(hello) {
    event('bootstrap')
    const negotiatedSession = `session-${randomUUID()}`
    const welcome = {
      negotiatedSession,
      wireVersion: { major: 2, minor: 0 },
      catalogRevision: 1,
      capabilities: { ...hello.capabilities, negotiatedSession, effectivePolicyRevision: 1 },
      modules: [],
      domainSchemas: [],
      mode: 'compatible' as const,
      reasons: [],
      clientInstanceId: hello.capabilities.clientInstanceId,
    }
    return ok({ welcome, catalogPage: { nextCursor: null, complete: true } })
  },
  async catalogPage() {
    return {
      ok: false,
      error: {
        code: 'conflict',
        detailCode: 'catalog_changed',
        message: 'catalog changed',
        retryAdvice: { kind: 'retry_read' },
        diagnosticId: randomUUID(),
      },
    }
  },
  async call(operation, input) {
    if (operation === 'conversation.cancel') {
      const { requestId } = input as { requestId: string }
      appendFileSync(file, `${requestId}\n`)
      event(`cancel ${requestId}`)
      if (requestId.startsWith('hold')) await new Promise(() => undefined)
      return ok(handle(requestId, true))
    }
    if (operation === 'conversation.status') {
      event(`status ${input as string}`)
      return ok(handle(input as string, committed(input as string)))
    }
    return ok({ catalogRevision: 1, mode: 'compatible', reasonCode: null })
  },
  async subscribe(request) {
    const subscriptionId = `sub-${process.pid}-${++subscriptions}`
    event(`subscribe ${subscriptionId}`)
    const frame = { subscriptionId, topic: 'interactions', kind: 'snapshot', cursor: 'c0', payload: snapshot }
    return ok({ header: request.header, subscriptionId, topic: 'interactions', cursor: 'c0', frame } as never)
  },
  async readSubscription(request) {
    event(`read ${request.subscriptionId}`)
    return ok({ header: request.header, frames: [], nextCursor: request.cursor, hasMore: false })
  },
  async closeSubscription(request) {
    event(`close ${request.subscriptionId}`)
    return ok({ closed: true })
  },
}

async function start(): Promise<string> {
  if (provider === 'reference')
    return (await startReferenceTransport(owner, { kind: 'bearer', credential: TRANSPORT_E2E_BEARER }))
      .baseUrl
  const runtimeClient = {
    bootstrap: owner.bootstrap,
    catalogPage: owner.catalogPage,
    subscribe: owner.subscribe,
    readSubscription: owner.readSubscription,
    closeSubscription: owner.closeSubscription,
    ...Object.fromEntries(
      owner.operations.map((operation) => [
        operation,
        (input: unknown, header: Wire.ClientCallHeader) => owner.call(operation, input, header),
      ]),
    ),
  } as RuntimeClientPorts
  const listener = await listenWebSocket({
    addr: '127.0.0.1:0',
    token: TRANSPORT_E2E_BEARER,
    runtimeOnly: { current: async () => true },
    endpoint: () => {
      throw new Error('the runtime listener opens no RPC session')
    },
    runtimeClient,
  })
  return listener.url.replace(/^ws/, 'http')
}

process.stdout.write(`READY ${await start()}\n`)
