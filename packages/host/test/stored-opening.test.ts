import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultIds, type Event, type EventInput, SessionLogImpl, UIProjectionCell } from '@agnes/core'
import { UI_PROJECTION_DEFAULT_MAX_BYTES } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import { createStoredOpeningReader } from '../src/stored-opening.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = {
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t: unknown) => globalThis.clearTimeout(t as never),
}
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const user = (content: unknown[]): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content } as never,
})
const answer = (text: string): EventInput => ({
  actor: { ...actor, id: 'agent', role: 'agent' },
  origin: 'model',
  trust: 'untrusted',
  type: 'assistant/message',
  data: { content: [{ type: 'text', text }], stopReason: 'end_turn' },
})

async function writeSession(dir: string, key: string, image: string): Promise<string> {
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  const log = await SessionLogImpl.open({
    storage,
    key,
    writerRunId: 'writer',
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.now(),
    timers,
  })
  for (let i = 0; i < 30; i++)
    await log.append([user([{ type: 'text', text: `question ${i}` }]), answer(`answer ${i}`)])
  await log.append([
    user([
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: image },
    ]),
  ])
  await log.close()
  await storage.close()
  return file
}

/** The control: every row read lean from the writer's adapter, folded in one cell. */
async function control(dir: string, key: string, maxNodes: number) {
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  try {
    const { lastSeq } = await storage.open(key, { writerRunId: 'control', ttlMs: 60_000 })
    const cell = new UIProjectionCell(key, 'main')
    for (let from = 1; from <= lastSeq; from += 500)
      cell.apply(
        (await storage.scanLean(key, {
          fromSeq: from,
          toSeq: Math.min(lastSeq, from + 499),
          limit: 500,
        })) as Event[],
      )
    cell.sealReplay()
    await storage.release(key, 'control')
    return {
      lastSeq,
      opening: await cell.opening({ maxNodes, maxBytes: UI_PROJECTION_DEFAULT_MAX_BYTES }),
    }
  } finally {
    await storage.close()
  }
}

describe('stored opening reader', () => {
  it('folds the stored rows lean into the same bounded opening, without the image bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:stored'
    const image = randomBytes(400 * 1024).toString('base64')
    const file = await writeSession(dir, key, image)

    const reader = createStoredOpeningReader({ file })
    try {
      const result = await reader.opening(key, 200)
      const expected = await control(dir, key, 200)
      const timeline = result.timeline as { nodes: unknown[] }
      expect(timeline.nodes.length).toBeGreaterThan(30)
      expect(timeline.nodes.length).toBe(expected.opening.timeline.nodes.length)
      expect(result.timeline).toEqual(expected.opening.timeline)
      expect(result.hasEarlier).toBe(expected.opening.hasEarlier)
      expect(result.lastSeq).toBe(expected.lastSeq)
      const text = JSON.stringify(result)
      for (let at = 0; at + 64 <= image.length; at += 4096)
        expect(text).not.toContain(image.slice(at, at + 64))
    } finally {
      reader.close()
    }
  })

  it('reads while another connection holds the writer lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:leased'
    const file = await writeSession(dir, key, 'QUJD')
    const writer = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const reader = createStoredOpeningReader({ file })
    try {
      const { lastSeq } = await writer.open(key, { writerRunId: 'live-writer', ttlMs: 60_000 })
      const result = await reader.opening(key, 5)
      expect(result.lastSeq).toBe(lastSeq)
      expect((result.timeline as { nodes: unknown[] }).nodes).toHaveLength(5)
      expect(result.hasEarlier).toBe(true)
    } finally {
      reader.close()
      await writer.release(key, 'live-writer')
      await writer.close()
    }
  })

  it('opens the database read-only, so it never creates one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.db')
    expect(() => createStoredOpeningReader({ file })).toThrow()
    expect(existsSync(file)).toBe(false)
  })

  it('folds a child session with its parent prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:parent'
    const file = await writeSession(dir, key, 'QUJD')
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const parent = await SessionLogImpl.open({
      storage,
      key,
      writerRunId: 'writer',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers,
    })
    const childKey = `${key}:child`
    const child = await parent.forkInto(10, childKey, {
      actor,
      agnesVersion: '0.0.0-test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'child',
      lane: 'main',
    })
    await child.append([user([{ type: 'text', text: 'child question' }])])
    await child.close()
    await parent.close()
    await storage.close()

    const reader = createStoredOpeningReader({ file })
    try {
      const result = await reader.opening(childKey, 200)
      const expected = await control(dir, childKey, 200)
      expect(result.timeline).toEqual(expected.opening.timeline)
      expect(result.lastSeq).toBe(expected.lastSeq)
    } finally {
      reader.close()
    }
  })
})
