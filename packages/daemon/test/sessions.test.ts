import type { Host, WorkspaceBinding } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { type SessionEntry, SessionRegistry } from '../src/local/sessions.js'
import { openTestHost } from './host.js'
import { workspaceBinding } from './workspace-authority.js'

const actor = { id: 'tester', org: 'local', role: 'owner', deptPath: [], attrs: {} }

describe('SessionRegistry', () => {
  it('refuses retired new and existing opens/forks while preserving reads and exact close proof', async () => {
    const h = await openTestHost()
    let blocked = false
    const reg = new SessionRegistry(h.host, {
      clock: Date.now,
      pollMs: 5,
      assertSessionAdmitted: () => {
        if (blocked) throw new Error('retired')
      },
    })
    try {
      const entry = await reg.open({ key: 'admission-parent', cwd: h.dataDir })
      blocked = true
      await expect(reg.open({ key: entry.key, cwd: h.dataDir })).rejects.toThrow('retired')
      await expect(reg.open({ key: 'new-blocked', cwd: h.dataDir })).rejects.toThrow('retired')
      await expect(reg.fork({ parent: entry.key, at: 1 })).rejects.toThrow('retired')
      expect(reg.require(entry.key)).toBe(entry)
      expect(await entry.session.projectUI()).toMatchObject({ upto: expect.any(Number) })
      expect(await reg.closeAndConfirm(entry.key)).toMatchObject({
        exited: true,
        owner: { sessionKey: entry.key },
      })
      expect(entry.session.d.log.isClosed).toBe(true)
    } finally {
      await reg.closeAll()
      await h.close()
    }
  })

  it('decodes and forwards daemon workspace authority for opens and forks', async () => {
    const stopped = new Error('stop after capture')
    const accept = vi.fn(
      (envelope: Awaited<ReturnType<typeof workspaceBinding>>, expectedSessionKey: string) =>
        ({
          sessionKey: expectedSessionKey,
          workspaceId: envelope.workspaceId,
          authorityRevision: envelope.revision,
          canonicalRoot: envelope.canonicalRoot,
        }) as WorkspaceBinding,
    )
    const create = vi.fn<Host['createSession']>(async () => {
      throw stopped
    })
    const host = { acceptWorkspaceBinding: accept, createSession: create } as unknown as Host
    const reg = new SessionRegistry(host, { clock: () => Date.now(), pollMs: 5 })
    const canonicalRoot = '/workspace'
    const parentKey = 'agnes:binding:parent'
    const parentEnvelope = await workspaceBinding(parentKey, canonicalRoot)
    await expect(reg.open({ key: parentKey, cwd: canonicalRoot, binding: parentEnvelope })).rejects.toBe(
      stopped,
    )
    expect(accept).toHaveBeenCalledWith(parentEnvelope, parentKey)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      key: parentKey,
      binding: { sessionKey: parentKey, canonicalRoot, authorityRevision: 1 },
    })
    expect(create.mock.calls[0]?.[0].binding).not.toBe(parentEnvelope)

    ;(reg as unknown as { entries: Map<string, SessionEntry> }).entries.set(parentKey, {
      session: {
        d: { cwd: canonicalRoot, log: {} },
        projectUI: vi.fn(async () => ({ opState: null })),
        scan: vi.fn(async () => [{ seq: 7, type: 'turn/end', data: { reason: 'completed' } }]),
      },
    } as unknown as SessionEntry)
    const childKey = 'agnes:binding:child'
    const childEnvelope = await workspaceBinding(childKey, canonicalRoot)
    await expect(reg.fork({ parent: parentKey, at: 7, childKey, binding: childEnvelope })).rejects.toBe(
      stopped,
    )
    expect(accept).toHaveBeenCalledWith(childEnvelope, childKey)
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
      key: childKey,
      binding: { sessionKey: childKey, canonicalRoot, authorityRevision: 1 },
      parent: { key: parentKey, boundarySeq: 7 },
    })
    expect(create.mock.calls.at(-1)?.[0].binding).not.toBe(childEnvelope)
  })

  it.each([false, true])(
    'retains exact close proof when retirement races a new owner (drain failure: %s)',
    async (failClose) => {
      const h = await openTestHost()
      let blocked = false
      let restoreClose: () => void = () => undefined
      const create = h.host.createSession.bind(h.host)
      vi.spyOn(h.host, 'createSession').mockImplementation(async (options) => {
        const session = await create(options)
        const originalClose = session.close.bind(session)
        restoreClose = () => {
          session.close = originalClose
        }
        if (failClose)
          session.close = async () => {
            throw new Error('late owner drain failed')
          }
        blocked = true
        return session
      })
      const reg = new SessionRegistry(h.host, {
        clock: Date.now,
        pollMs: 5,
        assertSessionAdmitted: () => {
          if (blocked) throw new Error('retired')
        },
      })
      try {
        await expect(reg.open({ key: 'late-fence', cwd: h.dataDir })).rejects.toThrow('retired')
        expect(reg.get('late-fence')).toBeUndefined()
        if (failClose) {
          await expect(reg.closeAndConfirm('late-fence')).resolves.toMatchObject({
            exited: false,
            reason: 'close-failed',
            owner: { sessionKey: 'late-fence' },
          })
          expect(reg.get('late-fence')).toBeUndefined()
          restoreClose()
        }
        const proof = await reg.closeAndConfirm('late-fence')
        expect(proof).toMatchObject({
          exited: true,
          owner: { sessionKey: 'late-fence', generation: 1, workerGeneration: null },
        })
        expect(reg.get('late-fence')).toBeUndefined()
      } finally {
        restoreClose()
        await reg.closeAll()
        await h.close()
      }
    },
  )

  it('opens, finds, subscribes and rejects unknown keys', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const e = await reg.open({ cwd: h.dataDir })
    expect(reg.get(e.key)).toBe(e)
    expect(e.generation).toBe(1)
    expect(() => reg.require('agnes:nope')).toThrow(/SESSION_NOT_FOUND/)
    const got: string[] = []
    const off = reg.subscribe(e.key, (ev) => got.push(ev.type))
    await e.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await new Promise((r) => setTimeout(r, 60))
    expect(got).toContain('session/start')
    off()
    await reg.closeAll()
    await h.close()
  })

  it('one throwing listener does not stop the others, or the tail behind them', async () => {
    // The fan-out was a bare loop, so a listener that threw skipped every listener after it and then
    // left the tail that called it as an unhandled rejection.
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const e = await reg.open({ cwd: h.dataDir })
    const before: number[] = []
    const after: number[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (x: unknown): void => {
      unhandled.push(x)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      reg.subscribe(e.key, (ev) => before.push(ev.seq))
      reg.subscribe(e.key, () => {
        throw new Error('listener blew up')
      })
      reg.subscribe(e.key, (ev) => after.push(ev.seq))
      await e.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      await new Promise((r) => setTimeout(r, 80))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    // The one registered after the thrower saw exactly what the one registered before it saw.
    expect(before.length).toBeGreaterThan(0)
    expect(after).toEqual(before)
    // Contained is not swallowed: the failures are on the entry, one per event the thrower saw.
    expect(e.listenerErrors).toHaveLength(before.length)
    expect((e.listenerErrors[0] as Error).message).toBe('listener blew up')
    // Not detached: it is still called on the next event, holes and all.
    expect(e.listeners.size).toBe(3)
    // The tail is alive, which is what a killed loop would not be.
    expect(e.tailError).toBeNull()
    await reg.closeAll()
    await h.close()
  })

  it('holds rows appended before the first subscriber instead of dropping them', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    // open() starts the tail at once, so session/start is normally read before any handler has
    // subscribed. Wait past several poll intervals with no subscriber, then subscribe.
    const e = await reg.open({ cwd: h.dataDir })
    await new Promise((r) => setTimeout(r, 40))
    expect(e.backlog.length).toBeGreaterThan(0)
    const got: number[] = []
    reg.subscribe(e.key, (ev) => got.push(ev.seq))
    expect(got[0]).toBe(1)
    expect(e.backlog).toHaveLength(0)
    await reg.closeAll()
    await h.close()
  })

  it('closing a key stops its tail and forgets it', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const e = await reg.open({ cwd: h.dataDir })
    const closing = reg.close(e.key)
    expect(reg.get(e.key)).toBeUndefined()
    await closing
    await expect(reg.closeAndConfirm(e.key)).resolves.toEqual({
      exited: true,
      owner: { sessionKey: e.key, writerRunId: e.session.writerRunId, generation: 1, workerGeneration: null },
    })
    await expect(reg.closeAndConfirm('agnes:missing')).resolves.toEqual({
      exited: false,
      reason: 'owner-unknown',
    })
    expect(reg.get(e.key)).toBeUndefined()
    expect(reg.keys()).toEqual([])
    expect(e.ac.signal.aborted).toBe(true)
    await h.close()
  })

  it('deduplicates same-key creation retries and rejects changed parameters', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const binding = await h.workspaces.authorizeAndBind('agnes:retry:stable', h.dataDir)
    const request = { key: 'agnes:retry:stable', cwd: binding.canonicalRoot, binding }

    const [first, retry] = await Promise.all([reg.open(request), reg.open(request)])
    expect(retry).toBe(first)
    await expect(reg.open({ ...request, runtime: 'jevloop' })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })
    await expect(reg.open({ ...request, runtime: 'native' })).resolves.toBe(first)
    await expect(reg.open({ ...request, cwd: `${h.dataDir}/different` })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })
    await expect(reg.open({ ...request, preset: 'changed' })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })

    await reg.closeAll()
    await h.close()
  })
  it('keeps a failed owner sealed and retries its exact close without reusing proof for a replacement', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: Date.now, pollMs: 5 })
    const e = await reg.open({ cwd: h.dataDir })
    await expect(
      reg.closeAndConfirm(e.key, {
        expectedWriterRunId: e.session.writerRunId,
        expectedOwnerEpoch: (e.session.d.log.ownerEpoch ?? 0) + 1,
      }),
    ).resolves.toEqual({ exited: false, reason: 'owner-unknown' })
    const actualClose = e.session.close.bind(e.session)
    let rejectClose: ((error: Error) => void) | undefined
    e.session.close = () =>
      new Promise((_, reject) => {
        rejectClose = reject
      })
    try {
      const first = reg.close(e.key)
      expect(reg.close(e.key)).toBe(first)
      const originalProof = reg.closeAndConfirm(e.key)
      const failed = expect(first).rejects.toThrow('drain failed')
      const fenced = expect(reg.open({ key: e.key, cwd: h.dataDir })).rejects.toThrow('drain failed')
      expect(reg.get(e.key)).toBeUndefined()
      rejectClose?.(new Error('drain failed'))
      await Promise.all([failed, fenced])
      await expect(originalProof).resolves.toMatchObject({
        exited: false,
        reason: 'close-failed',
        owner: { writerRunId: e.session.writerRunId },
      })
      expect(e.session.d.log.isClosed).toBe(false)
      expect(reg.keys()).toEqual([])
      expect(() => reg.require(e.key)).toThrow(/SESSION_NOT_FOUND/)
      await expect(reg.open({ key: e.key, cwd: h.dataDir })).rejects.toThrow('drain failed')
      e.session.close = actualClose
      let settleTurn: (() => void) | undefined
      e.inflight = {
        promptId: 'ending',
        abort: new AbortController(),
        settled: new Promise<void>((resolve) => {
          settleTurn = resolve
        }),
      }
      let acknowledged = false
      await expect(reg.closeAndConfirm(e.key, { expectedWriterRunId: 'replacement' })).resolves.toEqual({
        exited: false,
        reason: 'owner-unknown',
      })
      const retried = reg
        .closeAndConfirm(e.key, { expectedWriterRunId: e.session.writerRunId })
        .then((proof) => {
          acknowledged = true
          return proof
        })
      await vi.waitFor(() => expect(e.session.d.log.isClosed).toBe(true))
      expect(acknowledged).toBe(false)
      expect(reg.get(e.key)).toBeUndefined()
      settleTurn?.()
      await expect(retried).resolves.toMatchObject({
        exited: true,
        owner: {
          sessionKey: e.key,
          writerRunId: e.session.writerRunId,
          generation: 1,
          workerGeneration: null,
        },
      })
      expect(e.session.d.log.isClosed).toBe(true)
      // A retained failure receipt remains failure, even after its owner eventually drains.
      await expect(originalProof).resolves.toMatchObject({ exited: false })

      const replacement = await reg.open({ key: e.key, cwd: h.dataDir })
      expect(replacement.session.writerRunId).not.toBe(e.session.writerRunId)
      await expect(
        reg.closeAndConfirm(e.key, { expectedWriterRunId: e.session.writerRunId }),
      ).resolves.toEqual({ exited: false, reason: 'owner-unknown' })
      expect(reg.get(e.key)).toBe(replacement)
      expect(replacement.session.d.log.isClosed).toBe(false)
      const closeReplacement = replacement.session.close.bind(replacement.session)
      replacement.session.close = async () => {
        throw new Error('replacement drain failed')
      }
      await expect(reg.closeAndConfirm(e.key)).resolves.toMatchObject({
        exited: false,
        reason: 'close-failed',
        owner: { writerRunId: replacement.session.writerRunId },
      })
      replacement.session.close = closeReplacement
      await expect(reg.closeAndConfirm(e.key)).resolves.toMatchObject({
        exited: true,
        owner: { writerRunId: replacement.session.writerRunId },
      })
    } finally {
      e.session.close = actualClose
      await actualClose()
      await h.close()
    }
  })
  it('refuses a close acknowledgement while the writer remains live, then retries it', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: Date.now, pollMs: 5 })
    const entry = await reg.open({ cwd: h.dataDir })
    const actualClose = entry.session.close.bind(entry.session)
    entry.session.close = async () => undefined
    try {
      await expect(reg.closeAndConfirm(entry.key)).resolves.toMatchObject({
        exited: false,
        reason: 'close-failed',
        owner: { writerRunId: entry.session.writerRunId },
      })
      expect(entry.session.d.log.isClosed).toBe(false)
      expect(reg.get(entry.key)).toBeUndefined()
      entry.session.close = actualClose
      await expect(reg.closeAndConfirm(entry.key)).resolves.toMatchObject({
        exited: true,
        owner: { writerRunId: entry.session.writerRunId },
      })
      expect(entry.session.d.log.isClosed).toBe(true)
    } finally {
      entry.session.close = actualClose
      await actualClose()
      await h.close()
    }
  })

  it('closes a session created by an overtaken open without publishing it to the opener', async () => {
    const h = await openTestHost()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let created = false
    const host = {
      ...h.host,
      createSession: async (o: Parameters<Host['createSession']>[0]) => {
        const session = await h.host.createSession(o)
        created = true
        await gate
        return session
      },
    } as Host
    const reg = new SessionRegistry(host, { clock: () => Date.now(), pollMs: 5 })
    const key = 'agnes:opening:close'
    const opening = reg.open({ key, cwd: h.dataDir })
    const rejected = expect(opening).rejects.toThrow('closed while opening')
    await vi.waitFor(() => expect(created).toBe(true))
    const proof = reg.closeAndConfirm(key)
    expect(reg.get(key)).toBeUndefined()
    release?.()
    await rejected
    await expect(proof).resolves.toMatchObject({
      exited: true,
      owner: { sessionKey: key, generation: 1, workerGeneration: null },
    })
    expect(() => reg.require(key)).toThrow(/SESSION_NOT_FOUND/)
    await h.close()
  })
})
