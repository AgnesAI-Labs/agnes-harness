import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HostSession } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionUndo, sessionUndoPreview, undoResultFromFact } from '../src/workspace-undo.js'
import { realHosted } from './real-hosted.js'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const actor = { id: 'owner', org: 'local', role: 'user', deptPath: [], attrs: {} } as never

type Write = {
  path: string
  before: string | null
  after: string
  turn?: number
  checkpoint?: boolean | 'collected'
  session?: string
  checkpointOwner?: string
  checkpointPaths?: string[]
}

/** A fake session over a real temp directory, with a seam that really keeps the old bytes. */
function fixture(
  options: { permission?: string; effectivePermission?: string; busy?: boolean; failRewindAt?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'agh-undo-'))
  roots.push(root)
  const rows: EventEnvelope[] = []
  const add = (type: string, data: unknown, origin = 'core') => {
    rows.push({ seq: rows.length + 1, id: `r${rows.length + 1}`, ts: 't', type, data, origin } as never)
    return rows.length
  }
  const kept = new Map<
    string,
    { path: string; before: string | null; stepId: string; owner: string; paths: string[] }
  >()
  const seam = {
    snapshot: async () => ({ id: 'unused' }),
    rewind: async (id: string) => {
      const item = kept.get(id)
      if (!item) throw new Error('missing')
      if (item.path === options.failRewindAt) throw Object.assign(new Error('disk'), { code: 'EIO' })
      const file = join(root, item.path)
      if (item.before === null) rmSync(file, { force: true })
      else writeFileSync(file, item.before)
    },
    list: async () =>
      [...kept].map(([id, item]) => ({ id, stepId: item.stepId, owner: item.owner, paths: item.paths })),
  }
  const view = {
    root,
    fs: () => ({ read: async (path: string) => new Uint8Array(readFileSync(path)) }),
    checkpointContext: () => seam,
  }
  const session = {
    key: 's',
    get lastSeq() {
      return rows.length
    },
    preset: { permission: options.permission ?? 'workspace-write' },
    permissionContext: { policy: options.effectivePermission ?? options.permission ?? 'workspace-write' },
    op: () => (options.busy ? { kind: 'turn' } : null),
    locked: <T>(run: () => Promise<T>) => run(),
    ev: (type: string, data: unknown) => ({ type, data }),
    append: async (events: { type: string; data: unknown }[]) => {
      const first = rows.length + 1
      for (const event of events) add(event.type, event.data, 'principal')
      return { firstSeq: first }
    },
    scan: async (
      q: { type?: string | string[]; fromSeq?: number; toSeq?: number; order?: string; limit?: number } = {},
    ) => {
      const matched = rows.filter(
        (row) =>
          (!q.type || (Array.isArray(q.type) ? q.type.includes(row.type) : q.type === row.type)) &&
          (q.fromSeq === undefined || row.seq >= q.fromSeq) &&
          (q.toSeq === undefined || row.seq <= q.toSeq),
      )
      return (q.order === 'desc' ? matched.reverse() : matched).slice(0, q.limit ?? matched.length)
    },
    d: { workspaceInvocation: { run: async (handler: (v: typeof view) => unknown) => handler(view) } },
  } as unknown as HostSession
  let step = 0
  const write = (spec: Write) => {
    const turn = spec.turn ?? 1
    if (!rows.some((row) => row.type === 'turn/start' && (row.data as { turn: number }).turn === turn))
      add('turn/start', { turn })
    const file = join(root, spec.path)
    mkdirSync(dirname(file), { recursive: true })
    const id = `cp${++step}`
    if (spec.checkpoint !== 'collected')
      kept.set(id, {
        path: spec.path,
        before: spec.before,
        stepId: `${turn}/${step}`,
        owner: spec.checkpointOwner ?? 's',
        paths: spec.checkpointPaths ?? [spec.path],
      })
    writeFileSync(file, spec.after)
    add(
      'x/agnes/tools-core/file-change',
      {
        version: 1,
        sessionId: spec.session ?? 's',
        toolUseId: `u${step}`,
        turn,
        operation: 'write',
        path: spec.path,
        existed: spec.before !== null,
        beforeHash: hash(spec.before ?? ''),
        afterHash: hash(spec.after),
        status: 'available',
        ...(spec.checkpoint === false ? {} : { checkpointId: id }),
      },
      'ext:agnes/tools-core',
    )
  }
  const disk = (path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null
  const undo = (turn: number, commandId = 'c1') =>
    sessionUndo(session, { turn, commandId, admissionId: `a-${commandId}`, actor })
  const facts = () =>
    rows
      .filter((row) => row.type === 'x/core/workspace-undo')
      .map((row) => row.data as never as Record<string, unknown>)
  return { root, session, write, disk, undo, facts }
}

it('restores the bytes from before the first write of the turn and deletes a file the turn created', async () => {
  const t = fixture()
  t.write({ path: 'a.txt', before: 'v0', after: 'v1' })
  t.write({ path: 'a.txt', before: 'v1', after: 'v2' })
  t.write({ path: 'sub/new.txt', before: null, after: 'made' })
  const preview = await sessionUndoPreview(t.session, {})
  expect(preview).toMatchObject({ turn: 1, undoable: true, blockedBy: 'none' })
  expect(preview.files.map((file) => [file.path, file.action])).toEqual([
    ['a.txt', 'restore'],
    ['sub/new.txt', 'delete'],
  ])
  const result = await t.undo(1)
  expect(result).toMatchObject({ turn: 1, restored: ['a.txt', 'sub/new.txt'], failed: [], conflicts: [] })
  expect(t.disk('a.txt')).toBe('v0')
  expect(t.disk('sub/new.txt')).toBeNull()
  expect(t.facts()).toEqual([
    expect.objectContaining({ turn: 1, restored: ['a.txt', 'sub/new.txt'], failed: [] }),
  ])
  // The same turn cannot be undone twice, and the preview now offers nothing.
  await expect(t.undo(1, 'c2')).rejects.toMatchObject({ data: { code: 'UNDO_ALREADY_DONE' } })
})

it('refuses the whole turn when any file changed afterwards, and changes no file', async () => {
  const t = fixture()
  t.write({ path: 'a.txt', before: 'v0', after: 'v1' })
  t.write({ path: 'b.txt', before: 'w0', after: 'w1' })
  writeFileSync(join(t.root, 'b.txt'), 'edited by hand')
  await expect(t.undo(1)).rejects.toMatchObject({
    data: { code: 'UNDO_CONFLICT', conflicts: [{ path: 'b.txt', reason: 'changed-since' }] },
  })
  expect(t.disk('a.txt')).toBe('v1')
  expect(t.disk('b.txt')).toBe('edited by hand')
  expect(t.facts()).toEqual([
    expect.objectContaining({ restored: [], conflicts: [{ path: 'b.txt', reason: 'changed-since' }] }),
  ])
  // A replay of the refused command answers with the same refusal instead of acting again.
  const fact = t.facts()[0] as never
  expect(() => undoResultFromFact('s', 9, fact)).toThrow()
})

it('refuses while a turn runs and when the session permission is read-only', async () => {
  const busy = fixture({ busy: true })
  busy.write({ path: 'a.txt', before: 'v0', after: 'v1' })
  await expect(busy.undo(1)).rejects.toMatchObject({ data: { reason: 'a turn is running' } })
  expect(await sessionUndoPreview(busy.session, {})).toMatchObject({
    busy: true,
    undoable: false,
    blockedBy: 'busy',
  })
  const readOnly = fixture({ permission: 'workspace-write', effectivePermission: 'read-only' })
  readOnly.write({ path: 'a.txt', before: 'v0', after: 'v1' })
  await expect(readOnly.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_READ_ONLY' } })
  expect(readOnly.disk('a.txt')).toBe('v1')
})

it.each([
  ['an older receipt without a checkpoint id', { checkpoint: false as const }, 'legacy-receipt'],
  ['a snapshot that was collected', { checkpoint: 'collected' as const }, 'checkpoint-collected'],
])('shows %s as not undoable and touches nothing', async (_name, extra, reason) => {
  const t = fixture()
  t.write({ path: 'a.txt', before: 'v0', after: 'v1', ...extra })
  expect(await sessionUndoPreview(t.session, {})).toMatchObject({
    undoable: false,
    blockedBy: 'files',
    files: [{ path: 'a.txt', undoable: false, reason }],
  })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_UNAVAILABLE' } })
  expect(t.disk('a.txt')).toBe('v1')
})

it('never uses a receipt that belongs to another session', async () => {
  const t = fixture()
  t.write({ path: 'a.txt', before: 'v0', after: 'v1', session: 'other' })
  expect(await sessionUndoPreview(t.session, {})).toMatchObject({
    blockedBy: 'none',
    undoable: false,
    files: [],
  })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_NOTHING_TO_UNDO' } })
  expect(t.disk('a.txt')).toBe('v1')
})

it('asks for later turns to be undone first', async () => {
  const t = fixture()
  t.write({ path: 'a.txt', before: 'v0', after: 'v1', turn: 1 })
  t.write({ path: 'b.txt', before: 'w0', after: 'w1', turn: 2 })
  expect(await sessionUndoPreview(t.session, { turn: 1 })).toMatchObject({
    blockedBy: 'later-turns',
    laterTurns: [2],
  })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_LATER_TURNS' } })
  await t.undo(2)
  await t.undo(1, 'c2')
  expect([t.disk('a.txt'), t.disk('b.txt')]).toEqual(['v0', 'w0'])
})

it('stops at the first failure and records exactly what the disk holds', async () => {
  const t = fixture({ failRewindAt: 'b.txt' })
  t.write({ path: 'a.txt', before: 'v0', after: 'v1' })
  t.write({ path: 'b.txt', before: 'w0', after: 'w1' })
  t.write({ path: 'c.txt', before: 'x0', after: 'x1' })
  const result = await t.undo(1)
  expect(result).toMatchObject({
    restored: ['a.txt'],
    failed: [
      { path: 'b.txt', reason: 'EIO' },
      { path: 'c.txt', reason: 'not-attempted' },
    ],
  })
  expect([t.disk('a.txt'), t.disk('b.txt'), t.disk('c.txt')]).toEqual(['v0', 'w1', 'x1'])
  expect(t.facts()).toEqual([expect.objectContaining({ restored: ['a.txt'], failed: result.failed })])
  // A turn whose undo did not finish is still offered, and a replay answers from the fact.
  expect(await sessionUndoPreview(t.session, {})).toMatchObject({ turn: 1 })
  expect(undoResultFromFact('s', result.seq, t.facts()[0] as never)).toEqual(result)
})

it('refuses a turn with more files than one undo handles instead of restoring part of it', async () => {
  const t = fixture()
  for (let i = 0; i < 201; i++)
    t.write({ path: `f${String(i).padStart(3, '0')}.txt`, before: 'a', after: 'b' })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_UNAVAILABLE' } })
  expect(t.disk('f000.txt')).toBe('b')
})

it('refuses while a real turn runs, through the worker command frames', async () => {
  const t = await realHosted()
  cleanups.push(t.close)
  await t.hosted.open(t.openFrame('undo-busy'))
  expect(await t.hosted.dispatch(t.command('undo-busy', 'undoPreview', {}))).toMatchObject({
    busy: false,
    undoable: false,
    files: [],
  })
  const release = t.hold()
  await t.prompt('undo-busy', 'hold the turn open')
  const running = t.run('undo-busy').catch(() => undefined)
  const session = t.host.kernel.get('undo-busy')
  if (!session) throw new Error('session did not open')
  await vi.waitFor(() => expect(session.op()).not.toBeNull())
  expect(await t.hosted.dispatch(t.command('undo-busy', 'undoPreview', {}))).toMatchObject({ busy: true })
  await expect(
    t.hosted.dispatch(
      t.command('undo-busy', 'undo', { turn: 1, commandId: 'c', admissionId: 'a', actor: session.d.actor }),
    ),
  ).rejects.toMatchObject({ data: { code: 'SESSION_BUSY' } })
  expect(await session.scan({ type: 'x/core/workspace-undo', fromSeq: 1, toSeq: session.lastSeq })).toEqual(
    [],
  )
  release()
  await running
})

it('never restores an intermediate version when the receipt scan truncates a turn', async () => {
  const t = fixture()
  for (let i = 0; i < 5001; i++) t.write({ path: 'a.txt', before: `v${i}`, after: `v${i + 1}` })
  expect(await sessionUndoPreview(t.session, { turn: 1 })).toMatchObject({ undoable: false })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_NOTHING_TO_UNDO' } })
  expect(t.disk('a.txt')).toBe('v5001')
  expect(t.facts()).toEqual([])
})

it.each([
  { checkpointOwner: 'another-session' },
  { checkpointPaths: ['a.txt', 'unrelated.txt'] },
  { checkpointPaths: ['/outside/a.txt'] },
  { checkpointPaths: ['elsewhere.txt'] },
])('refuses a checkpoint that is not bound to exactly this session and file: %j', async (extra) => {
  const t = fixture({ permission: 'full-access' })
  t.write({ path: 'a.txt', before: 'v0', after: 'v1', ...extra })
  expect(await sessionUndoPreview(t.session, {})).toMatchObject({ undoable: false, blockedBy: 'files' })
  await expect(t.undo(1)).rejects.toMatchObject({ data: { code: 'UNDO_UNAVAILABLE' } })
  expect(t.disk('a.txt')).toBe('v1')
  expect(t.facts()).toEqual([])
})
