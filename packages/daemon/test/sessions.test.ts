import type { Host, WorkspaceBinding } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { type SessionEntry, SessionRegistry } from '../src/local/sessions.js'
import { openTestHost } from './host.js'
import { workspaceBinding } from './workspace-authority.js'

const actor = { id: 'tester', org: 'local', role: 'owner', deptPath: [], attrs: {} }

describe('SessionRegistry', () => {
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
    await reg.close(e.key)
    expect(reg.get(e.key)).toBeUndefined()
    expect(reg.keys()).toEqual([])
    expect(e.ac.signal.aborted).toBe(true)
    await h.close()
  })

  it('deduplicates same-key creation retries and rejects changed parameters', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const request = { key: 'agnes:retry:stable', cwd: h.dataDir }

    const [first, retry] = await Promise.all([reg.open(request), reg.open(request)])
    expect(retry).toBe(first)
    await expect(reg.open({ ...request, cwd: `${h.dataDir}/different` })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })
    await expect(reg.open({ ...request, preset: 'changed' })).rejects.toMatchObject({
      data: { code: 'ID_CONFLICT' },
    })

    await reg.closeAll()
    await h.close()
  })
})
