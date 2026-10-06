import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeClientTransportWire } from '@agnes/protocol/runtime'
import { createRuntimeClient, RuntimeClientTransport, runtimeJournalKey } from '@agnes/sdk/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryJournal } from '../../src/journal.js'

// The same SDK runtime client against the daemon's runtime listener and the reference server, each in a
// process of its own, through a proxy that loses, duplicates, reorders and cuts replies and counts every
// request the client sends. However the network or the server fails, a command leaves the client once
// and is recovered by its original id, never resent.

const { routes } = RuntimeClientTransportWire
const fixture = fileURLToPath(
  new URL('../../../daemon/test/runtime/fixtures/transport-server.ts', import.meta.url),
)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const BEARER = 'transport-e2e-bearer'
const capabilities = {
  clientInstanceId: 'ci-1',
  target: 'sdk' as const,
  protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
  viewSchemaRanges: [],
  renderKeys: [],
  features: [RuntimeClientTransportWire.feature],
  capabilitiesRevision: 1,
  interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
  files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
  display: { plainText: true, markdown: true, maxTextBytes: 1024, inlinePreviewMimes: [] },
}

const children = new Set<ChildProcess>()
const servers = new Set<Server>()
const directories: string[] = []
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  for (const server of servers) server.closeAllConnections()
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
  servers.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Starts the fixture server for `provider`; resolves with its URL and the owner events it prints. */
function serve(provider: string, directory: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, provider, directory], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const events: string[] = []
  const waiting = new Map<string, () => void>()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const closed = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('close', (_code, signal) => resolve(signal)),
  )
  return new Promise<{
    baseUrl: string
    events: string[]
    seen: (text: string) => Promise<void>
    kill: () => Promise<NodeJS.Signals | null>
  }>((resolve, reject) => {
    let buffered = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (line.startsWith('READY '))
          resolve({
            baseUrl: line.slice('READY '.length),
            events,
            seen: (text) =>
              events.includes(text) ? Promise.resolve() : new Promise((done) => waiting.set(text, done)),
            kill: () => {
              child.kill('SIGKILL')
              return closed
            },
          })
        if (!line.startsWith('OWNER ')) continue
        const text = line.slice('OWNER '.length)
        events.push(text)
        waiting.get(text)?.()
      }
    })
    void closed.then(() => reject(new Error(`transport server exited before it listened\n${stderr}`)))
  })
}

type Fault = 'lose' | 'drop' | 'duplicate' | 'cut' | 'late'
type Answer = { status: number; headers: IncomingHttpHeaders; body: Buffer }

/**
 * Forwards every request to the current target and records the client's raw egress. The next command
 * takes the next queued fault: `lose` drops the reply after the server answered, `drop` never forwards
 * the request, `duplicate` forwards it twice, `cut` ends the reply half way, `late` holds the reply until
 * the next command's reply has gone out.
 */
async function proxy() {
  let target = ''
  const egress: { path: string; body: Record<string, unknown> }[] = []
  const faults: Fault[] = []
  let late: Promise<void> | null = null
  let release = (): void => undefined
  const forward = (path: string, method: string, headers: IncomingHttpHeaders, body: Buffer) =>
    new Promise<Answer>((resolve, reject) => {
      const { host: _host, connection: _connection, ...rest } = headers
      const out = request(target + path, { method, headers: rest }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        )
      })
      out.on('error', reject)
      out.end(body)
    })
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const path = incoming.url ?? ''
    egress.push({ path, body: JSON.parse(body.toString('utf8') || 'null') })
    const fault = path === routes.clientCommand.path ? faults.shift() : undefined
    if (fault === 'drop') return void incoming.socket.destroy()
    const send = () => forward(path, incoming.method ?? 'POST', incoming.headers, body)
    let answer: Answer
    try {
      answer = fault === 'duplicate' ? (await Promise.all([send(), send()]))[0] : await send()
    } catch {
      return void incoming.socket.destroy()
    }
    if (fault === 'lose') return void incoming.socket.destroy()
    if (fault === 'late') {
      late = new Promise((resolve) => {
        release = resolve
      })
      await late
    }
    const { connection: _connection, 'transfer-encoding': _encoding, ...headers } = answer.headers
    if (fault === 'cut') {
      outgoing.writeHead(answer.status, { ...headers, 'content-length': answer.body.length })
      outgoing.write(answer.body.subarray(0, answer.body.length >> 1))
      return void outgoing.socket?.destroy()
    }
    outgoing.writeHead(answer.status, headers).end(answer.body)
    if (late && fault !== 'late' && path === routes.clientCommand.path) {
      late = null
      release()
    }
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    retarget: (url: string) => {
      target = url
    },
    fault: (...next: Fault[]) => faults.push(...next),
    /** How many times the client sent a command with this request id. */
    sent: (requestId: string) =>
      egress.filter(
        (entry) =>
          entry.path === routes.clientCommand.path &&
          (entry.body.call as { input: { requestId: string } }).input.requestId === requestId,
      ).length,
  }
}

const cancel = (requestId: string) => ({ sessionId: 'conv-1', runId: 'run-1', requestId })
const states = (reports: readonly { id: string; state: string }[]) =>
  Object.fromEntries(reports.map(({ id, state }) => [id, state]))

describe.each(['default', 'reference'])(
  'the SDK runtime client against the %s server process',
  (provider) => {
    it('sends each command once whatever the network does, and recovers it by its original id', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agnes-sdk-reconnect-'))
      directories.push(directory)
      let server = await serve(provider, directory)
      const network = await proxy()
      network.retarget(server.baseUrl)
      const journal = memoryJournal('client-1')
      const connect = async () => {
        const transport = new RuntimeClientTransport({
          baseUrl: network.url,
          hello: { capabilities, authorApi: [], loadedBundles: [] },
          journal,
          journalPartitionKey: 'partition-1',
          credential: BEARER,
        })
        await transport.connect()
        return createRuntimeClient(transport)
      }
      const pending = async () =>
        (await journal.pending(runtimeJournalKey('partition-1'))).map((entry) => [
          entry.commandId,
          entry.state,
        ])
      let client = await connect()
      expect(client.transport.mode).toBe('compatible')

      // A reply lost after the owner accepted, and one cut off half way: unknown, then recovered.
      network.fault('lose', 'cut')
      expect(await client.conversations.cancel(cancel('lost-1'))).toMatchObject({ state: 'unknown' })
      expect(await client.conversations.cancel(cancel('cut-1'))).toMatchObject({ state: 'unknown' })
      // A request the network delivers twice reaches the owner twice under one id; the client sent it once.
      network.fault('duplicate')
      expect(await client.conversations.cancel(cancel('twice-1'))).toMatchObject({ state: 'ok' })
      // A request lost before the owner stays pending as not accepted.
      network.fault('drop')
      expect(await client.conversations.cancel(cancel('dropped-1'))).toMatchObject({ state: 'unknown' })
      // Replies in the other order still settle their own calls.
      network.fault('late')
      const first = client.conversations.cancel(cancel('first-1'))
      await server.seen('cancel first-1')
      const second = await client.conversations.cancel(cancel('second-1'))
      expect([await first, second]).toMatchObject([
        { state: 'ok', value: { requestId: 'first-1' } },
        { state: 'ok', value: { requestId: 'second-1' } },
      ])

      // Admitted but not final, the others stay journaled as accepted; the dropped one was never admitted.
      const accepted = ['lost-1', 'cut-1', 'twice-1', 'first-1', 'second-1']
      expect(states(await client.transport.recover())).toEqual({
        ...Object.fromEntries(accepted.map((id) => [id, 'accepted'])),
        'dropped-1': 'not-accepted',
      })
      expect(await pending()).toEqual([
        ...['lost-1', 'cut-1', 'twice-1'].map((id) => [id, 'accepted']),
        ['dropped-1', undefined],
        ...['first-1', 'second-1'].map((id) => [id, 'accepted']),
      ])

      // The server process is killed with the command in flight, then started again behind the same URL.
      const holding = client.conversations.cancel(cancel('hold-1'))
      await server.seen('cancel hold-1')
      expect(await server.kill()).toBe('SIGKILL')
      expect(await holding).toMatchObject({ state: 'unknown' })
      server = await serve(provider, directory)
      network.retarget(server.baseUrl)
      client = await connect()
      const recovered = await client.transport.recover()
      expect(states(recovered)).toEqual({
        ...Object.fromEntries([...accepted, 'hold-1'].map((id) => [id, 'accepted'])),
        'dropped-1': 'not-accepted',
      })
      // The restarted owner is only asked for statuses by the original ids.
      expect(server.events).toEqual(['bootstrap', ...recovered.map(({ id }) => `status ${id}`)])

      // Raw egress: every command left the client exactly once, recovery included.
      for (const id of ['lost-1', 'cut-1', 'twice-1', 'dropped-1', 'first-1', 'second-1', 'hold-1'])
        expect([id, network.sent(id)]).toEqual([id, 1])
    }, 60_000)
  },
)
