import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import type { Host, HostSession, Prompter } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReplyFrame } from '../src/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/framing.js'
import { runWorker } from '../src/main.js'
import { installWorkerProcessGuards } from '../src/process-guards.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

vi.mock('../src/tail.js', () => ({ tailSession: vi.fn() }))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function fakeLink(): { link: Duplex; fromWorker: unknown[] } {
  const fromWorker: unknown[] = []
  const dec = new JsonlDecoder()
  const link = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      for (const frame of dec.feed(chunk as Buffer)) fromWorker.push(frame)
      callback()
    },
  })
  return { link, fromWorker }
}

function frameFrom<T>(fromWorker: unknown[], match: (frame: Record<string, unknown>) => boolean): Promise<T> {
  return vi.waitFor(
    () => {
      const found = fromWorker.find((frame) => match(frame as Record<string, unknown>))
      if (!found) throw new Error('frame not sent yet')
      return found as T
    },
    { timeout: 2_000, interval: 10 },
  )
}

const replyTo = (fromWorker: unknown[], requestId: string) =>
  frameFrom<ReplyFrame>(fromWorker, (frame) => frame.kind === 'reply' && frame.requestId === requestId)

describe('shared worker: one session’s frame error stays with that session', () => {
  it('drops a supervisor reply that names the wrong session without stopping the worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiso-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const profile = join(root, 'profile.json')
    await writeFile(
      profile,
      JSON.stringify({
        name: 'local-dev',
        dataDir: root,
        cacheDir: join(root, 'cache'),
        adapters: { secrets: { kind: 'env' } },
        packages: [],
        hash: `sha256-${'0'.repeat(64)}`,
      }),
    )
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let prompter!: Prompter
    const session = (key: string) =>
      ({
        key,
        writerRunId: 'writer',
        d: { log: { parent: null }, cwd: root },
        lastSeq: 0,
        latest: () => undefined,
        preset: { name: 'standard' },
        // Session A's turn asks the supervisor for an approval; B's turn just completes.
        run: async () => {
          if (key === 'a')
            return { reason: await prompter.ask({} as never, { signal: new AbortController().signal }) }
          return { reason: 'completed' }
        },
        close: async () => undefined,
      }) as unknown as HostSession
    const host = {
      extensionRows: { current: () => [], prepare: () => ({}), apply: async () => ({}) },
      kernel: { sessions: new Map() },
      acceptWorkspaceBinding: (envelope: unknown) => envelope,
      createSession: async (options: { key: string }) => session(options.key),
      close: async () => undefined,
    } as unknown as Host
    const { link, fromWorker } = fakeLink()
    cleanup.push(async () => {
      link.removeAllListeners()
      link.destroy()
    })
    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'tok',
        AGNES_SUPERVISOR_SOCKET: '/tmp/wiso.sock',
        AGNES_WORKER_KEY: '@shared',
        AGNES_PROFILE_FILE: profile,
        AGNES_WORKER_GENERATION: '1',
        AGH_HOME: root,
        HOME: root,
      },
      { connect: async () => link, gate: null },
      {
        buildHost: async (_profile, given) => {
          prompter = given
          return host
        },
      },
    )
    for (const key of ['a', 'b']) {
      link.push(
        encodeFrame({
          kind: 'session.open',
          requestId: `open:${key}`,
          sessionKey: key,
          params: {
            binding: {
              version: 1,
              sessionKey: key,
              workspaceId: 'a'.repeat(64),
              revision: 1,
              canonicalRoot: root,
            },
          },
        }),
      )
      expect((await replyTo(fromWorker, `open:${key}`)).error).toBeUndefined()
    }

    const run = (key: string) =>
      link.push(
        encodeFrame({
          kind: 'command',
          requestId: `run:${key}`,
          sessionKey: key,
          method: 'run',
          params: { runId: key, until: 'turn-end' },
        }),
      )
    run('a')
    const ask = await frameFrom<{ requestId: string }>(
      fromWorker,
      (frame) => frame.kind === 'request' && frame.sessionKey === 'a',
    )
    // A reply for A's request that names session B used to exit the whole worker.
    link.push(encodeFrame({ kind: 'reply', requestId: ask.requestId, sessionKey: 'b', result: 'wrong' }))
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('agnes worker: reply frame failed:', expect.any(Error)),
    )
    run('b')
    expect(await replyTo(fromWorker, 'run:b')).toMatchObject({ result: { reason: 'completed' } })

    // A's request is still pending and still settles with its own reply.
    link.push(
      encodeFrame({ kind: 'reply', requestId: ask.requestId, sessionKey: 'a', result: 'allowed-once' }),
    )
    expect(await replyTo(fromWorker, 'run:a')).toMatchObject({ result: { reason: 'allowed-once' } })
    expect(exit).not.toHaveBeenCalled()
    expect(fromWorker).not.toContainEqual(expect.objectContaining({ kind: 'session.interrupted' }))
  })
})

describe('worker process guards', () => {
  function guarded() {
    const target = new EventEmitter()
    const channel = new SharedSessionChannel(() => undefined)
    const failed: Array<[string, unknown]> = []
    const fatal: unknown[] = []
    const dispose = installWorkerProcessGuards({
      sessionOf: () => channel.sessionInContext(),
      failSession: (key, error) => failed.push([key, error]),
      fatal: (error) => fatal.push(error),
      log: () => undefined,
      target,
    })
    return { target, channel, failed, fatal, dispose }
  }

  it('fails only the session whose async work threw or rejected', async () => {
    const { target, channel, failed, fatal, dispose } = guarded()
    const thrown = new Error('plugin timer threw')
    const rejected = new Error('plugin promise rejected')
    channel.run('a', () => target.emit('uncaughtException', thrown))
    await channel.run('b', async () => {
      await null
      target.emit('unhandledRejection', rejected)
    })
    expect(failed).toEqual([
      ['a', thrown],
      ['b', rejected],
    ])
    expect(fatal).toEqual([])
    dispose()
    expect(target.listenerCount('uncaughtException')).toBe(0)
    expect(target.listenerCount('unhandledRejection')).toBe(0)
  })

  it('logs an unattributed rejection and exits only for an unattributed exception', () => {
    const { target, failed, fatal } = guarded()
    target.emit('unhandledRejection', new Error('stray'))
    expect(fatal).toEqual([])
    const crash = new Error('unknown state')
    target.emit('uncaughtException', crash)
    expect(failed).toEqual([])
    expect(fatal).toEqual([crash])
  })

  it('exits when failing the session itself throws', () => {
    const target = new EventEmitter()
    const channel = new SharedSessionChannel(() => undefined)
    const fatal: unknown[] = []
    installWorkerProcessGuards({
      sessionOf: () => channel.sessionInContext(),
      failSession: () => {
        throw new Error('link gone')
      },
      fatal: (error) => fatal.push(error),
      log: () => undefined,
      target,
    })
    const error = new Error('boom')
    channel.run('a', () => target.emit('uncaughtException', error))
    expect(fatal).toEqual([error])
  })
})
