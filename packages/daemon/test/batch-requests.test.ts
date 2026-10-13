import type { BatchStatus } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { BatchAccessError, toolBatchId } from '../src/batch/engine.js'
import {
  createBatchPort,
  createBatchRequests,
  createItemSessions,
  workerItemConfinement,
} from '../src/batch/requests.js'
import { BatchSpecError } from '../src/batch/spec.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import type { WorkspaceBindingEnvelope, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

const status = { batchId: 'b0123456789ab', status: 'running' } as BatchStatus
const binding = (sessionKey: string) =>
  ({
    version: 1,
    sessionKey,
    workspaceId: 'a'.repeat(64),
    revision: 1,
    canonicalRoot: '/w',
  }) as WorkspaceBindingEnvelope

describe('createBatchRequests', () => {
  const engine = () => ({
    begin: vi.fn(async () => status),
    status: vi.fn(async () => status),
    cancel: vi.fn(async () => status),
  })
  const owner = {
    resolve: (key: string) =>
      key.startsWith('agnes:local:default:cli') ? { active: true as const, principalId: 'local' } : undefined,
  }
  const workspaces = { restoreBinding: async (key: string) => binding(key) }
  const user = 'agnes:local:default:cli:workspace:0123456789abcdef'

  it('starts with the transport session, its owner, its workspace and a call-derived id', async () => {
    const e = engine()
    const handle = createBatchRequests({ engine: e as never, ownership: owner, workspaces })
    await handle(user, {
      op: 'start',
      sessionKey: user,
      toolUseId: 'tu-9',
      cwd: '/w/lab',
      spec: { dir: 'images', prompt: 'x' },
    })
    expect(e.begin).toHaveBeenCalledWith({
      batchId: toolBatchId(user, 'tu-9'),
      principalId: 'local',
      root: '/w',
      cwd: '/w/lab',
      spec: { dir: 'images', prompt: 'x' },
      origin: user,
    })
    await handle(user, { op: 'status', sessionKey: user, batchId: 'b0123456789ab', export: true })
    expect(e.status).toHaveBeenCalledWith('local', 'b0123456789ab', true)
    await handle(user, { op: 'cancel', sessionKey: user, batchId: 'b0123456789ab' })
    expect(e.cancel).toHaveBeenCalledWith('local', 'b0123456789ab')
  })

  it('refuses batch items, sessions without an owner and malformed requests', async () => {
    const handle = createBatchRequests({ engine: engine() as never, ownership: owner, workspaces })
    await expect(
      handle('agnes:local:default:batch:b0123456789ab:3', { op: 'status', batchId: 'b0123456789ab' }),
    ).rejects.toThrow(/batch item/)
    await expect(
      handle('agnes:local:default:dm:x', { op: 'status', batchId: 'b0123456789ab' }),
    ).rejects.toThrow(/owner/)
    await expect(handle(user, { op: 'status' })).rejects.toThrow(/batchId/)
    // A start or an unknown operation is not answered with a batchId complaint.
    await expect(handle(user, { op: 'start', cwd: '/w', spec: {} })).rejects.toThrow(
      'A batch start needs its tool call id and working directory.',
    )
    await expect(handle(user, { op: 'start', toolUseId: 't', spec: {} })).rejects.toThrow(/working directory/)
    await expect(handle(user, { op: 'delete', batchId: 'b0123456789ab' })).rejects.toThrow(
      'unknown batch request',
    )
  })

  it('turns engine refusals into plain messages for the tool', async () => {
    const e = engine()
    e.status.mockRejectedValueOnce(new BatchAccessError())
    e.begin.mockRejectedValueOnce(new BatchSpecError('dir must stay inside the workspace'))
    const handle = createBatchRequests({ engine: e as never, ownership: owner, workspaces })
    await expect(handle(user, { op: 'status', batchId: 'b0123456789ab' })).rejects.toThrow(
      'No batch with this id belongs to you.',
    )
    await expect(handle(user, { op: 'start', toolUseId: 't', cwd: '/w', spec: {} })).rejects.toThrow(
      'dir must stay inside the workspace',
    )
  })

  it('refuses a session a batch owns whatever its key, and inactive owners', async () => {
    const e = engine()
    const handle = createBatchRequests({
      engine: e as never,
      ownership: {
        resolve: (key: string) =>
          key === 'agnes:local:default:cli:owned-by-batch'
            ? { active: true as const, principalId: 'batch:b0123456789ab' }
            : key === 'agnes:local:default:cli:broken'
              ? (() => {
                  throw new Error('disk')
                })()
              : undefined,
      },
      workspaces,
    })
    await expect(
      handle('agnes:local:default:cli:owned-by-batch', { op: 'status', batchId: 'b0123456789ab' }),
    ).rejects.toThrow(/batch item/)
    await expect(
      handle('agnes:local:default:cli:broken', { op: 'status', batchId: 'b0123456789ab' }),
    ).rejects.toThrow(/owner/)
    // A key that merely ends like an item key is refused too: refusing takes nothing away.
    await expect(
      handle('agnes:local:default:cli:x:batch:b0123456789ab:1', { op: 'status', batchId: 'b0123456789ab' }),
    ).rejects.toThrow(/batch item/)
    expect(e.status).not.toHaveBeenCalled()
  })

  it('does not pass internal failures on to the model, and logs them', async () => {
    const e = engine()
    e.status.mockRejectedValueOnce(new Error('SQLITE_IOERR: /secret/path/daemon.sqlite'))
    const logged: string[] = []
    const handle = createBatchRequests({
      engine: e as never,
      ownership: owner,
      workspaces,
      log: (message) => logged.push(message),
    })
    const failure = await handle(user, { op: 'status', batchId: 'b0123456789ab' }).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toContain('/secret/path')
    expect(logged.join('\n')).toContain('SQLITE_IOERR')
  })
})

describe('createItemSessions', () => {
  it('owns item sessions under the batch principal, outside every user list, idempotently', async () => {
    const ownership = new SessionPrincipalOwnershipIndex(sqliteTables().table('session_principal_ownership'))
    const bound: string[] = []
    const workspaces = {
      authorizeAndBind: async (key: string) => {
        bound.push(key)
        return binding(key)
      },
      restoreBinding: async (key: string) => binding(key),
      sessionPath: () => undefined,
    } as unknown as WorkspaceCatalog
    const sessions = createItemSessions({
      ownership,
      workspaces,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('unused')
        },
        close: async () => undefined,
      },
    })
    const key = 'agnes:local:default:batch:b0123456789ab:1'
    await sessions.prepare({ sessionKey: key, principalId: 'batch:b0123456789ab', root: '/w' })
    await sessions.prepare({ sessionKey: key, principalId: 'batch:b0123456789ab', root: '/w' })
    expect(ownership.resolve(key)).toEqual({ active: true, principalId: 'batch:b0123456789ab' })
    expect(ownership.activeSessionIds('local')).not.toContain(key)
    expect(bound).toEqual([key, key])
  })

  it('releases an item session by closing it in the registry', async () => {
    const close = vi.fn(async () => undefined)
    const sessions = createItemSessions({
      ownership: new SessionPrincipalOwnershipIndex(sqliteTables().table('o')),
      workspaces: {} as unknown as WorkspaceCatalog,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('unused')
        },
        close,
      },
    })
    await sessions.release('agnes:local:default:batch:b0123456789ab:1')
    expect(close).toHaveBeenCalledWith('agnes:local:default:batch:b0123456789ab:1')
  })

  it('reads a transcript page by page, opening the session when it is closed', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ seq: i + 1, type: 'x' }))
    const scans: Array<{ fromSeq: number; toSeq: number; limit: number }> = []
    const entry = {
      session: {
        lastSeq: 1200,
        scan: async (q: { fromSeq: number; toSeq: number; limit: number }) => {
          scans.push(q)
          return rows.slice(q.fromSeq - 1, q.toSeq)
        },
      },
    }
    const open = vi.fn(async () => entry)
    const sessions = createItemSessions({
      ownership: new SessionPrincipalOwnershipIndex(sqliteTables().table('o')),
      workspaces: { restoreBinding: async (key: string) => binding(key) } as unknown as WorkspaceCatalog,
      registry: { get: () => undefined, open, close: async () => undefined },
    })
    expect(await sessions.transcript('k')).toHaveLength(1200)
    expect(open).toHaveBeenCalledWith({ key: 'k', cwd: '/w', binding: binding('k'), resume: true })
    // Pages until a short one: the daemon's cached head is not consulted (see the next test).
    expect(scans.map((q) => [q.fromSeq, q.toSeq, q.limit])).toEqual([
      [1, 500, 500],
      [501, 1000, 500],
      [1001, 1500, 500],
    ])
  })

  it('reads the rows the worker wrote after the head the daemon last saw', async () => {
    // A job completes when its turn ends; the turn's last rows can still be on their way to the
    // daemon, so a cached head of 3 must not hide turn/end at 5.
    const rows = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, type: i === 4 ? 'turn/end' : 'x' }))
    const entry = {
      session: {
        lastSeq: 3,
        scan: async (q: { fromSeq: number; toSeq: number }) => rows.slice(q.fromSeq - 1, q.toSeq),
      },
    }
    const sessions = createItemSessions({
      ownership: new SessionPrincipalOwnershipIndex(sqliteTables().table('o')),
      workspaces: {} as unknown as WorkspaceCatalog,
      registry: {
        get: () => entry,
        open: async () => {
          throw new Error('unused')
        },
        close: async () => undefined,
      },
    })
    expect((await sessions.transcript('k')).map((row) => row.type)).toEqual(['x', 'x', 'x', 'x', 'turn/end'])
  })

  it('stops reading a ledger that does not end', async () => {
    let scans = 0
    const sessions = createItemSessions({
      ownership: new SessionPrincipalOwnershipIndex(sqliteTables().table('o')),
      workspaces: {} as unknown as WorkspaceCatalog,
      registry: {
        get: () => ({
          session: {
            scan: async (q: { fromSeq: number }) => {
              scans++
              return Array.from({ length: 500 }, (_, i) => ({ seq: q.fromSeq + i }))
            },
          },
        }),
        open: async () => {
          throw new Error('unused')
        },
        close: async () => undefined,
      },
    })
    await expect(sessions.transcript('k')).rejects.toThrow(/too long/)
    expect(scans).toBe(100)
  })

  it('prepares only item keys, and only for the batch the key names', async () => {
    const ownership = new SessionPrincipalOwnershipIndex(sqliteTables().table('o'))
    const authorizeAndBind = vi.fn(async (key: string) => binding(key))
    const sessions = createItemSessions({
      ownership,
      workspaces: { authorizeAndBind, sessionPath: () => undefined } as unknown as WorkspaceCatalog,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('unused')
        },
        close: async () => undefined,
      },
    })
    const refused = [
      // a user key, a key of another batch, and a user principal for a real item key
      ['agnes:local:default:dm:x', 'batch:b0123456789ab'],
      ['agnes:local:default:batch:b0123456789ab:1', 'batch:bffffffffffff'],
      ['agnes:local:default:batch:b0123456789ab:1', 'local'],
    ] as const
    for (const [sessionKey, principalId] of refused)
      await expect(sessions.prepare({ sessionKey, principalId, root: '/w' })).rejects.toThrow(/belong/)
    expect(authorizeAndBind).not.toHaveBeenCalled()
    expect(ownership.resolve('agnes:local:default:batch:b0123456789ab:1')).toBeUndefined()
  })

  it('refuses an item key a user already holds', async () => {
    const ownership = new SessionPrincipalOwnershipIndex(sqliteTables().table('o'))
    const key = 'agnes:local:default:batch:b0123456789ab:1'
    expect(ownership.bindNew(key, 'local')).toBe(true)
    expect(ownership.activateNew(key, 'local')).toBe(true)
    const sessions = createItemSessions({
      ownership,
      workspaces: {
        authorizeAndBind: async (k: string) => binding(k),
        sessionPath: () => '/w',
      } as unknown as WorkspaceCatalog,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('unused')
        },
        close: async () => undefined,
      },
    })
    await expect(
      sessions.prepare({ sessionKey: key, principalId: 'batch:b0123456789ab', root: '/w' }),
    ).rejects.toThrow(/owner/)
    expect(ownership.resolve(key)).toEqual({ active: true, principalId: 'local' })
  })
})

describe('createBatchPort', () => {
  const engine = () => ({
    begin: vi.fn(async () => status),
    status: vi.fn(async () => status),
    cancel: vi.fn(async () => status),
    list: vi.fn(() => [status]),
  })

  it('roots a CLI batch at the registered workspace the caller names, under the caller principal', async () => {
    const e = engine()
    const bind = vi.fn(async (_id: string | undefined, path: string) => {
      if (path !== '/w/./') throw Object.assign(new Error('workspace is not registered'), { code: -32010 })
      return { workspaceId: 'a'.repeat(64), path: '/w' }
    })
    const port = createBatchPort({ engine: e as never, workspaces: { bind } as never })
    await port.start({ principalId: 'local', cwd: '/w/./', spec: { dir: 'images', prompt: 'x' } })
    expect(bind).toHaveBeenCalledWith(undefined, '/w/./')
    expect(e.begin).toHaveBeenCalledWith({
      batchId: expect.stringMatching(/^b[0-9a-f]{12}$/u),
      principalId: 'local',
      root: '/w',
      cwd: '/w',
      spec: { dir: 'images', prompt: 'x' },
    })
    // A folder that is not a registered workspace is refused before anything is enumerated.
    await expect(port.start({ principalId: 'local', cwd: '/elsewhere', spec: {} })).rejects.toThrow(
      /registered/,
    )
    expect(e.begin).toHaveBeenCalledTimes(1)
    await port.status({ principalId: 'local', batchId: 'b0123456789ab', export: true })
    expect(e.status).toHaveBeenCalledWith('local', 'b0123456789ab', true)
    await port.status({ principalId: 'local', batchId: 'b0123456789ab' })
    expect(e.status).toHaveBeenLastCalledWith('local', 'b0123456789ab', false)
    await port.cancel({ principalId: 'local', batchId: 'b0123456789ab' })
    expect(e.cancel).toHaveBeenCalledWith('local', 'b0123456789ab')
    expect(await port.list({ principalId: 'local' })).toEqual([status])
    expect(e.list).toHaveBeenCalledWith('local')
  })

  it('answers engine refusals as RPC refusals with a reason', async () => {
    const e = engine()
    e.begin.mockRejectedValueOnce(new BatchSpecError('dir is not an existing folder'))
    e.status.mockRejectedValueOnce(new BatchAccessError())
    e.cancel.mockRejectedValueOnce(new BatchAccessError())
    const port = createBatchPort({
      engine: e as never,
      workspaces: { bind: async () => ({ workspaceId: 'a'.repeat(64), path: '/w' }) } as never,
    })
    await expect(port.start({ principalId: 'local', cwd: '/w', spec: {} })).rejects.toMatchObject({
      code: -32011,
      data: { code: 'BATCH_SPEC_INVALID', reason: 'dir is not an existing folder' },
    })
    for (const call of [
      () => port.status({ principalId: 'local', batchId: 'b0123456789ab' }),
      () => port.cancel({ principalId: 'local', batchId: 'b0123456789ab' }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: -32011,
        data: { code: 'BATCH_NOT_FOUND', reason: 'No batch with this id belongs to you.' },
      })
  })
})

describe('workerItemConfinement', () => {
  it('is ready only when the live worker says so', async () => {
    const port = (alive: boolean, answer: unknown) => {
      const command = vi.fn(async () => answer)
      return { command, port: workerItemConfinement(async () => ({ alive, command })) }
    }
    const yes = port(true, { ready: true })
    await expect(yes.port.itemConfinementReady()).resolves.toBe(true)
    expect(yes.command).toHaveBeenCalledWith('batch.confinement', {}, { timeoutMs: 30_000 })
    await expect(port(true, { ready: false }).port.itemConfinementReady()).resolves.toBe(false)
    await expect(port(true, { ready: 'yes' }).port.itemConfinementReady()).resolves.toBe(false)
    await expect(port(true, undefined).port.itemConfinementReady()).resolves.toBe(false)
    const dead = port(false, { ready: true })
    await expect(dead.port.itemConfinementReady()).rejects.toThrow(/not running/)
    expect(dead.command).not.toHaveBeenCalled()
  })
})
