import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeClientTransportPolicy, RuntimeClientTransportWire } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryJournal } from '../../../sdk/src/journal.js'
import { RuntimeClientTransport, readOutcome } from '../../../sdk/src/runtime/client-transport.js'

// The daemon's runtime client routes on its private listener, in a process of their own: a reader left
// unread is closed at its owner after the real idle timeout, and after the process is killed its readers
// are refused for a resync while its accepted command is recovered by the original id, never resent.

const { routes } = RuntimeClientTransportWire
const { readerIdleTimeoutMs } = RuntimeClientTransportPolicy
const fixture = fileURLToPath(new URL('./fixtures/transport-server.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const BEARER = 'transport-e2e-bearer'
const header = { negotiatedSession: 's1', clientInstanceId: 'ci-1', catalogRevision: 1, callId: 'call-1' }
const scope = { installationId: 'inst-1', runtimeId: 'rt-1', workspaceId: 'ws-1', kind: 'workspace' }
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

type Server = Awaited<ReturnType<typeof serve>>
const children = new Set<ChildProcess>()
const directories: string[] = []
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Starts the fixture server; resolves once it listens, recording each owner event with its time. */
function serve(directory: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, 'default', directory], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const events: { text: string; at: number }[] = []
  const waiting: { text: string; seen: (at: number) => void }[] = []
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const closed = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('close', (_code, signal) => resolve(signal)),
  )
  return new Promise<{
    baseUrl: string
    events: () => string[]
    seen: (text: string) => Promise<number>
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
            events: () => events.map((entry) => entry.text),
            seen: (text) => {
              const hit = events.find((entry) => entry.text === text)
              return hit ? Promise.resolve(hit.at) : new Promise((done) => waiting.push({ text, seen: done }))
            },
            kill: () => {
              child.kill('SIGKILL')
              return closed
            },
          })
        if (!line.startsWith('OWNER ')) continue
        const entry = { text: line.slice('OWNER '.length), at: Date.now() }
        events.push(entry)
        for (const wait of waiting.splice(0)) {
          if (wait.text === entry.text) wait.seen(entry.at)
          else waiting.push(wait)
        }
      }
    })
    void closed.then(() => reject(new Error(`transport server exited before it listened\n${stderr}`)))
  })
}

async function post(server: Server, name: keyof typeof routes, body: unknown) {
  const response = await fetch(server.baseUrl + routes[name].path, {
    method: 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  const outcome = await readOutcome(response)
  if (!outcome) throw new Error(`no Outcome from ${name}`)
  return outcome.ok
    ? { status: response.status, value: outcome.value as Record<string, unknown> }
    : { status: response.status, detailCode: outcome.error.detailCode }
}
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-transport-stream-'))
  directories.push(directory)
  return directory
}
const reading = (subscriptionId: unknown, callHeader: unknown = header) => ({
  header: callHeader,
  subscriptionId,
  cursor: 'c0',
  limit: 256,
})

describe('runtime client subscriptions in a real daemon process', () => {
  it(
    'closes a reader left unread for the real idle timeout at its owner and refuses it afterwards',
    async () => {
      const server = await serve(temporary())
      const opened = await post(server, 'subscribe', { header, topic: 'interactions', input: { scope } })
      const subscriptionId = opened.value?.subscriptionId
      const readAt = Date.now()
      expect(await post(server, 'readSubscription', reading(subscriptionId))).toMatchObject({ status: 200 })
      const closedAt = await server.seen(`close ${subscriptionId}`)
      // The timer starts once the read is answered, so it cannot close earlier than the timeout after it.
      expect(closedAt - readAt).toBeGreaterThanOrEqual(readerIdleTimeoutMs)
      expect(closedAt - readAt).toBeLessThan(readerIdleTimeoutMs + 5_000)
      expect(await post(server, 'readSubscription', reading(subscriptionId))).toEqual({
        status: 409,
        detailCode: 'resync_required',
      })
      expect(server.events()).toEqual([
        `subscribe ${subscriptionId}`,
        `read ${subscriptionId}`,
        `close ${subscriptionId}`,
      ])
      // Subscribing again starts from a fresh snapshot.
      expect(
        await post(server, 'subscribe', { header, topic: 'interactions', input: { scope } }),
      ).toMatchObject({
        status: 200,
        value: { frame: { kind: 'snapshot' } },
      })
    },
    readerIdleTimeoutMs + 30_000,
  )

  it('refuses the readers of a killed process after restart and recovers its command without resending it', async () => {
    const directory = temporary()
    const first = await serve(directory)
    const journal = memoryJournal('client-1')
    const egress: string[] = []
    const client = (baseUrl: string) =>
      new RuntimeClientTransport({
        baseUrl,
        hello: { capabilities, authorApi: [], loadedBundles: [] },
        journal,
        journalPartitionKey: 'partition-1',
        credential: BEARER,
        fetch: (url, init) => {
          egress.push(new URL(url).pathname)
          return fetch(url, init)
        },
      })
    const before = client(first.baseUrl)
    await before.connect()
    const oldHeader = before.header()
    const opened = await post(first, 'subscribe', {
      header: oldHeader,
      topic: 'interactions',
      input: { scope },
    })
    const subscriptionId = opened.value?.subscriptionId
    const sending = before.command('conversation.cancel', {
      sessionId: 'conv-1',
      runId: 'run-1',
      requestId: 'hold-1',
    })
    await first.seen('cancel hold-1')
    expect(await first.kill()).toBe('SIGKILL')
    expect(await sending).toMatchObject({ state: 'unknown' })

    const second = await serve(directory)
    expect(await post(second, 'readSubscription', reading(subscriptionId, oldHeader))).toEqual({
      status: 409,
      detailCode: 'resync_required',
    })
    const after = client(second.baseUrl)
    await after.connect()
    expect(await after.recover()).toEqual([
      { id: 'hold-1', operation: 'conversation.cancel', state: 'accepted' },
    ])
    // The restarted owner was asked for the status by the original id and never received the command again.
    expect(second.events()).toEqual(['bootstrap', 'status hold-1'])
    expect(egress.filter((path) => path === routes.clientCommand.path)).toHaveLength(1)
  }, 30_000)
})
