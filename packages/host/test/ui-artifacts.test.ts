import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalArtifactReadStore } from '@agnes/host-artifacts/artifact-read-store'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import { createUiArtifactChecker, withUiArtifactStatuses } from '../src/runtime/sessions/ui-artifacts.js'

it('checks session/lane registration metadata, legacy results, cold replay and cancellation without loading bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-ui-artifacts-'))
  const signal = new AbortController().signal
  const bytes = new TextEncoder().encode('<h1>合成交付物</h1>')
  const ref = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    mime: 'text/html',
  }
  const shard = join(root, 'artifacts', 'sha256', ref.sha256.slice(0, 2))
  await mkdir(shard, { recursive: true })
  await writeFile(join(shard, ref.sha256), bytes)
  const rows: EventEnvelope[] = []
  let closed = false
  const session = (key: string, lane: string, events = rows) =>
    ({
      key,
      lane,
      get lastSeq() {
        return events.length
      },
      get closingOrClosed() {
        return closed
      },
      d: { log: {} },
      scan: async (query: { type?: string | string[]; lane?: string; fromSeq?: number; toSeq?: number }) =>
        events.filter(
          (row) =>
            (!query.type ||
              (Array.isArray(query.type) ? query.type.includes(row.type) : row.type === query.type)) &&
            (!query.lane || row.lane === query.lane) &&
            row.seq >= (query.fromSeq ?? 0) &&
            row.seq <= (query.toSeq ?? Infinity),
        ),
    }) as unknown as HostSession
  const main = session('one', 'main')
  const store = createLocalArtifactReadStore({ dataDir: root, maxArtifactBytes: 1024 })
  // Any accidental body read in the list checker fails this observable contract.
  const checker = () =>
    createUiArtifactChecker({
      ...store,
      get: async () => {
        throw new Error('body read forbidden')
      },
    })
  const check = checker()
  const append = (type: string, data: unknown, origin = 'system', trust = 'trusted', lane = 'main') =>
    rows.push({
      seq: rows.length + 1,
      id: `event-${rows.length}`,
      ts: new Date(0).toISOString(),
      type,
      data,
      origin,
      trust,
      lane,
    } as EventEnvelope)
  try {
    expect(await check(main, ref, signal)).toBe('not_found')
    append(
      'x/agnes/intelligent-ui/surface.opened',
      { artifact: ref },
      'ext:agnes/intelligent-ui',
      'untrusted',
    )
    append('x/core/artifact.registered', { artifact: ref }, 'ext:fixture/plugin')
    expect(await check(main, ref, signal)).toBe('not_found')
    append('x/core/artifact.registered', { artifact: ref })
    expect(await check(main, ref, signal)).toBe('available')
    const parameterized = { ...ref, mime: 'text/plain; charset=utf-8' }
    append('x/core/artifact.registered', { artifact: parameterized })
    expect(await check(main, parameterized, signal)).toBe('unavailable')
    expect(await checker()(session('one', 'main'), parameterized, signal)).toBe('unavailable')
    expect(await check(main, ref, signal)).toBe('available')
    const alias = { ...ref, mime: 'text/plain' }
    append('x/core/artifact.registered', { artifact: alias })
    expect(await check(main, alias, signal)).toBe('available')
    expect(await checker()(session('one', 'main'), alias, signal)).toBe('available')
    for (const mutation of [{ sha256: 'f'.repeat(64) }, { size: bytes.length - 1 }, { mime: 'image/png' }])
      expect(await check(main, { ...ref, ...mutation }, signal)).not.toBe('available')
    expect(await check(session('other', 'main', []), ref, signal)).toBe('not_found')
    expect(await check(session('one', 'other'), ref, signal)).toBe('not_found')
    expect(await checker()(session('one', 'main'), ref, signal)).toBe('available')
    const legacy = session('legacy', 'main', [])
    const legacyRows = [
      {
        actor: { id: 'synthetic', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        seq: 1,
        id: 'legacy',
        ts: new Date(0).toISOString(),
        type: 'tool/result',
        lane: 'main',
        origin: 'tool:present',
        trust: 'trusted',
        data: {
          isError: false,
          content: [{ type: 'resource_link', uri: `artifact://${ref.sha256}`, mimeType: ref.mime }],
        },
      },
    ] as EventEnvelope[]
    expect(await check(session('legacy', 'main', legacyRows), ref, signal)).toBe('available')
    expect(await check(legacy, ref, signal)).toBe('not_found')
    await rm(join(shard, ref.sha256))
    expect(await check(main, ref, signal)).toBe('unavailable')
    await writeFile(join(shard, ref.sha256), bytes)
    expect(await check(main, ref, signal)).toBe('available')
    const temporary = createUiArtifactChecker({
      ...store,
      status: async () => {
        throw new Error('transient')
      },
    })
    expect(await temporary(main, ref, signal)).toBe('unavailable')
    const cancelling = new AbortController()
    const cancelled = createUiArtifactChecker({
      ...store,
      status: async () => {
        cancelling.abort()
        return 'available'
      },
    })
    await expect(cancelled(main, ref, cancelling.signal)).rejects.toThrow()
    closed = true
    expect(await check(main, ref, signal)).toBe('unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('decorates old-provider records per file without failing a page or trusting stored status', async () => {
  const signal = new AbortController().signal
  const record = {
    surface: {
      id: 'legacy',
      revision: 1,
      title: 'Legacy',
      placement: { inline: true, workbench: true },
      components: [
        { id: 'good', kind: 'artifact-file', dataKey: 'good' },
        { id: 'bad', kind: 'artifact-file', dataKey: 'bad' },
      ],
      data: {
        good: {
          name: 'demo.html',
          description: '',
          artifact: { sha256: 'a'.repeat(64), size: 3, mime: 'text/html' },
        },
        bad: {
          name: 'demo.html',
          description: '',
          artifact: { sha256: 'b'.repeat(64), size: 4, mime: 'text/html' },
        },
      },
      actions: [],
    },
    status: 'open',
    createdSeq: 1,
    updatedSeq: 1,
    owner: 'old-provider',
    lane: 'main',
    taskId: 'old',
    artifacts: { bad: 'available' },
  } as const
  const shown = await withUiArtifactStatuses(
    record as unknown as import('@agnes/protocol').UiSurfaceRecord,
    async (ref) => (ref.sha256.startsWith('a') ? 'available' : 'not_found'),
    signal,
  )
  expect(shown.artifacts).toEqual({ good: 'available', bad: 'not_found' })
  expect(record.artifacts).toEqual({ bad: 'available' })
  const temporary = await withUiArtifactStatuses(
    shown,
    async (ref) => {
      if (ref.sha256.startsWith('b')) throw new Error('temporary')
      return 'available'
    },
    signal,
  )
  expect(temporary.artifacts).toEqual({ good: 'available', bad: 'unavailable' })
})
