import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HostSession } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { reviewDiff } from '../src/review-diff.js'
import { readWorkspaceChanges } from '../src/workspace-changes.js'

const roots: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-review-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function ledger(root: string) {
  const rows: EventEnvelope[] = []
  const add = (type: string, data: unknown, sourceEventSeqs?: number[]) => {
    const row = {
      seq: rows.length + 1,
      id: `record-${rows.length + 1}`,
      ts: '2026-10-09T00:00:00.000Z',
      type,
      data,
      origin: type.startsWith('x/') ? 'ext:agnes/tools-core' : 'core',
      trust: 'untrusted',
      lane: 'main',
      actor: { id: 'test', org: 'local', role: 'user', deptPath: [], attrs: {} },
      ...(sourceEventSeqs ? { sourceEventSeqs } : {}),
    } as EventEnvelope
    rows.push(row)
    return row
  }
  const reader: Pick<HostSession, 'key' | 'scan' | 'lastSeq'> = {
    key: 's',
    get lastSeq() {
      return rows.length
    },
    async scan(q = {}) {
      const matched = rows.filter(
        (row) =>
          (!q.type || (Array.isArray(q.type) ? q.type.includes(row.type) : q.type === row.type)) &&
          (q.fromSeq === undefined || row.seq >= q.fromSeq) &&
          (q.toSeq === undefined || row.seq <= q.toSeq),
      )
      return (q.order === 'desc' ? matched.reverse() : matched).slice(0, q.limit ?? matched.length)
    },
  }
  add('session/start', { key: 's' })
  add('turn/start', { turn: 1 })
  const effect = (
    path: string,
    before: string,
    after: string,
    options: {
      error?: boolean
      origin?: string
      status?: string
      beforeHash?: string
      turn?: number
      name?: string
      result?: boolean
      receipt?: boolean
      transformed?: boolean
      existed?: boolean
    } = {},
  ) => {
    const turn = options.turn ?? 1,
      name = options.name ?? 'write',
      toolUseId = `use-${rows.length}`
    const call = add('tool/call', {
      toolUseId,
      name,
      args: { path: resolve(root, path) },
      ordinal: 0,
      executionDomain: 'workspace',
      resolvedPolicy: { isReadOnly: false },
    })
    if (options.receipt !== false) {
      const receipt = add('x/agnes/tools-core/file-change', {
        version: 1,
        sessionId: 's',
        toolUseId,
        turn,
        operation: name,
        path,
        existed: options.existed ?? before !== '',
        beforeHash: options.beforeHash ?? hash(before),
        afterHash: hash(after),
        status: options.status ?? 'available',
        ...(options.status ? {} : { before, after }),
      })
      if (options.origin) receipt.origin = options.origin
    }
    if (options.result !== false)
      add(
        'tool/result',
        {
          toolUseId,
          content: [],
          isError: options.error ?? false,
          authz: { decisionId: 'actual-decision' },
          enforcement: { level: 'full', scope: ['file'] },
          ...(options.transformed ? { transformedBy: 'another-extension' } : {}),
        },
        [call.seq],
      )
    return call
  }
  return { rows, reader, add, effect }
}
const authority = { stat: async () => ({}) }

it.each(['new\nfile.ts', '设计 review.ts'])(
  'aggregates confirmed versions and fresh reads for %j',
  async (path) => {
    const root = temp(),
      fixture = ledger(root)
    fixture.effect(path, '', 'one\n')
    fixture.add('turn/start', { turn: 2 })
    fixture.effect(path, 'one\n', 'two\n', { turn: 2, name: 'edit' })
    writeFileSync(join(root, path), 'two\n')
    const full = await readWorkspaceChanges(fixture.reader, root, authority, { path })
    expect(full).toMatchObject({
      unrecorded: false,
      truncated: false,
      files: [{ path, kind: 'added', added: 1, removed: 0, freshness: 'current', basis: 'session' }],
    })
    expect(full.selected?.effects).toHaveLength(2)
    expect(full.selected?.effects.every((effect) => effect.laneId === 'main')).toBe(true)
    expect(full.selected?.diff).toContain('+two\n')
    expect(full.selected?.diff).toContain(`--- a/${path.includes('\n') ? JSON.stringify(path) : path}\n`)
    const mismatched = ledger(root)
    mismatched.effect(path, '', 'two\n').lane = 'unverified-lane'
    expect(
      (await readWorkspaceChanges(mismatched.reader, root, authority, { path })).selected?.effects[0]?.laneId,
    ).toBeUndefined()
    const turn = await readWorkspaceChanges(fixture.reader, root, authority, { path, scope: 'turn' })
    expect(turn.selected).toMatchObject({ added: 1, removed: 1, basis: 'turn' })
    expect(turn.selected?.diff).toContain('-one\n')
    writeFileSync(join(root, path), 'external\n')
    if (!full.selected) throw new Error('Missing selected review')
    const changed = await readWorkspaceChanges(fixture.reader, root, authority, {
      path,
      expectedRevision: full.selected.currentRevision,
    })
    expect(changed.selected).toMatchObject({ freshness: 'changed', viewerChanged: true })
    expect(changed.selected?.diff).not.toContain('external')
    expect(changed.revision).not.toBe(full.revision)
    await expect(
      readWorkspaceChanges(
        fixture.reader,
        root,
        {
          stat: async () => {
            throw new Error('Current authority revoked')
          },
        },
        {},
      ),
    ).rejects.toBeDefined()

    fixture.effect('new-empty.txt', '', '', { turn: 2 })
    fixture.effect('existing-empty.txt', '', '', { turn: 2, existed: true })
    writeFileSync(join(root, 'new-empty.txt'), '')
    writeFileSync(join(root, 'existing-empty.txt'), '')
    const empty = await readWorkspaceChanges(fixture.reader, root, authority, { path: 'new-empty.txt' })
    expect(empty.selected).toMatchObject({
      path: 'new-empty.txt',
      kind: 'added',
      added: 0,
      removed: 0,
      diffStatus: 'available',
      freshness: 'current',
      diff: '',
    })
    expect(empty.selected?.effects).toHaveLength(1)
    expect(empty.files.map((file) => file.path)).not.toContain('existing-empty.txt')
  },
)

it('does not attribute an intervening external edit, failed call, forged receipt or transformed result', async () => {
  const root = temp(),
    fixture = ledger(root)
  fixture.effect('a', '', 'one\n')
  fixture.effect('a', 'external\n', 'two\n', { name: 'edit' })
  writeFileSync(join(root, 'a'), 'two\n')
  for (const [path, options] of Object.entries({
    failed: { error: true },
    forged: { origin: 'ext:third-party' },
    invalid: { beforeHash: hash('wrong') },
    pending: { result: false },
    transformed: { transformed: true },
  })) {
    fixture.effect(path, '', 'UNTRUSTED\n', options)
    writeFileSync(join(root, path), 'UNTRUSTED\n')
  }
  const result = await readWorkspaceChanges(fixture.reader, root, authority, { path: 'a' })
  expect(result.files.map((file) => file.path)).toEqual(['a'])
  expect(result.selected).toMatchObject({ basis: 'latest-effect', added: 1, removed: 1 })
  expect(result.selected?.effects).toHaveLength(1)
  expect(result.selected?.diff).toContain('-external\n')
  expect(result.unrecorded).toBe(true)
})

it('refuses symlinks, installation home, path escapes and old parent-session effects', async () => {
  const root = temp(),
    outside = temp(),
    fixture = ledger(root)
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('AGH_HOME', home)
  for (const path of ['escape', 'home/credentials', '../private'])
    fixture.effect(path, '', 'PRIVATE_SENTINEL')
  writeFileSync(join(outside, 'private'), 'PRIVATE_SENTINEL')
  symlinkSync(join(outside, 'private'), join(root, 'escape'))
  writeFileSync(join(home, 'credentials'), 'PRIVATE_SENTINEL')
  expect((await readWorkspaceChanges(fixture.reader, root, authority, {})).files).toEqual([])
  for (const path of ['escape', 'home/credentials', '../private', '/etc/passwd'])
    await expect(readWorkspaceChanges(fixture.reader, root, authority, { path })).rejects.toBeDefined()
  await expect(readWorkspaceChanges(fixture.reader, home, authority, {})).rejects.toBeDefined()
  fixture.add('session/start', { key: 'child' })
  fixture.add('turn/start', { turn: 3 })
  expect(
    (await readWorkspaceChanges({ ...fixture.reader, key: 'child' }, root, authority, {})).files,
  ).toEqual([])
})

it('caps history, files and text, and marks unsupported successful mutations as unrecorded', async () => {
  const root = temp(),
    fixture = ledger(root)
  fixture.effect('binary', '', '\0', { status: 'binary' })
  writeFileSync(join(root, 'binary'), '\0')
  fixture.effect('large', '', 'a'.repeat(20_000), { status: 'too-large' })
  writeFileSync(join(root, 'large'), 'a'.repeat(1024 * 1024 + 1))
  fixture.effect('unknown-shell-effect', '', '', { name: 'shell', receipt: false })
  const unavailable = await readWorkspaceChanges(fixture.reader, root, authority, {})
  expect(unavailable.unrecorded).toBe(true)
  expect(unavailable.files.map((file) => file.diffStatus).sort()).toEqual(['binary', 'too-large'])
  expect(unavailable.files.every((file) => file.added === undefined && file.removed === undefined)).toBe(true)
  expect(unavailable.files.find((file) => file.path === 'large')).toMatchObject({
    freshness: 'unavailable',
    currentRevision: expect.stringMatching(/^weak:/),
  })
  for (let i = 0; i < 60; i++) {
    fixture.effect(`f${i}`, '', 'new\n')
    writeFileSync(join(root, `f${i}`), 'new\n')
  }
  const capped = await readWorkspaceChanges(fixture.reader, root, authority, {})
  expect(capped.files).toHaveLength(50)
  expect(capped.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThan(750 * 1024)
  for (let i = 0; i < 510; i++)
    fixture.add('tool/call', { toolUseId: `irrelevant-${i}`, name: 'read', args: {}, ordinal: 0 })
  const window = await readWorkspaceChanges(fixture.reader, root, authority, {})
  expect(window.truncated).toBe(true)
  expect(window.files).toEqual([])
})

it.each([
  ['', 'one\n', 1, 0],
  ['one\n', 'two\n', 1, 1],
  ['one\n', 'one\n', 0, 0],
  ['a\nb\n', 'b\na\n', 1, 1],
  ['one', 'one\n', 1, 1],
  ['é\n', '中\n', 1, 1],
])('computes bounded read-only diffs for %j to %j', (before, after, added, removed) => {
  expect(reviewDiff('file\nname', before, after)).toMatchObject({ added, removed })
})
it('refuses a costly comparison or oversized diff rather than inventing counts', () => {
  expect(reviewDiff('a', 'a\n'.repeat(500), 'b\n'.repeat(500))).toBeUndefined()
  expect(reviewDiff('a', 'a'.repeat(35_000), 'b'.repeat(35_000))).toBeUndefined()
  expect(reviewDiff('a', 'a', 'b')?.diff).toContain('\\ No newline at end of file')
})
