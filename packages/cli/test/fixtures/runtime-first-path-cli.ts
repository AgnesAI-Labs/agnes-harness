import { join } from 'node:path'
import { connectRuntime } from '@agnes/cli-tui'
import { RuntimeClientTransportWire as Wire } from '@agnes/protocol/runtime'
import { memoryJournal } from '@agnes/sdk'
import { ensureLocalBackend } from '../../src/boot/backend.js'

const root = process.env.AGH_HOME
if (!root) throw Error('Missing isolated home')
// Real CLI discovery + SDK local handshake + generation-scoped credential delivery (#275).
const backend = await ensureLocalBackend({
  home: root,
  profile: 'local-dev',
  dataDir: join(root, 'data'),
  workspace: root,
  cwd: root,
  spawnDaemon() {
    throw Error('The test must attach to its existing daemon')
  },
})
try {
  const endpoint = backend.runtimeClient
  if (!endpoint) throw Error('Daemon did not publish a runtime endpoint')
  const bootstrapReplies: unknown[] = []
  const runtime = await connectRuntime({
    endpoint: async () => endpoint,
    journal: memoryJournal('first-path'),
    journalPartitionKey: 'first-path-test-identity',
    locale: 'en',
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (url.endsWith(Wire.routes.bootstrap.path)) bootstrapReplies.push(await response.clone().json())
      return response
    },
  })
  // The optional fixture Welcome installs no backend rights; all calls still use real HTTP.
  let selectedRead: unknown = null
  let selectedCommand: unknown = null
  if (runtime.ok) {
    selectedRead = await runtime.transport.query('conversation.open', {
      sessionId: 'fixture-session',
      limit: 1,
    })
    selectedCommand = await runtime.transport.command('conversation.cancel', {
      sessionId: 'fixture-session',
      runId: 'fixture-run',
      requestId: 'fixture-request',
    })
  }
  const header = {
    negotiatedSession: 'boundary-probe',
    clientInstanceId: 'fixture-cli',
    catalogRevision: 1,
    callId: 'probe',
  }
  const post = async (path: string, body: unknown, bearer = endpoint.bearer) => {
    const response = await fetch(endpoint.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: response.status === 401 ? null : await response.json() }
  }
  const projection = await post(Wire.routes.clientQuery.path, {
    header,
    call: { operation: 'conversation.open', input: { sessionId: 'fixture-session', limit: 1 } },
  })
  const command = await post(Wire.routes.clientCommand.path, {
    header,
    call: {
      operation: 'conversation.cancel',
      input: { sessionId: 'fixture-session', runId: 'fixture-run', requestId: 'fixture-request' },
    },
  })
  const unauthorized = await post(Wire.routes.clientQuery.path, {}, 'wrong-generation')
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, daemonPid: backend.discovery.owner.pid, runtime: runtime.ok ? { ok: true } : runtime, bootstrapReplies, selectedRead, selectedCommand, projection, command, unauthorized })}\n`,
  )
} finally {
  await backend.close()
}
