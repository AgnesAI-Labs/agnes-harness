import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import type { EventEnvelope, InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { bootLocal } from '../src/boot/local.js'
import { ensureWorkspace, say, TEST_LOCK, testDeps } from './boot-host.js'

const tmp: string[] = []
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function run(dir: string, argv: string[]) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const io: MainIO = {
    env: { AGH_HOME: dir, HOME: dir },
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
  }
  const code = await main(argv, io, {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir })).host,
  })
  return { code, out, err }
}

const reads = (calls: number): InferenceEvent[] => [
  ...Array.from({ length: calls }, (_, ordinal) => ({
    type: 'toolcall_end' as const,
    call: { toolUseId: '', name: 'read', args: { path: `missing-${ordinal}.txt` }, ordinal },
    via: 'native' as const,
  })),
  { type: 'done', reason: 'toolUse' },
]

async function source(dir: string, script: InferenceEvent[][], turns: number): Promise<string> {
  const booted = await bootLocal(
    parseArgs([]),
    testDeps(dir, { createHostImpl: async () => (await createTestHost({ dataDir: dir, script })).host }),
  )
  try {
    await ensureWorkspace(booted.client, dir)
    const session = await booted.client.session.new({ cwd: dir })
    for (let i = 0; i < turns; i++) await session.prompt([{ type: 'text', text: `question ${i}` }])
    return session.id
  } finally {
    await booted.close()
  }
}

const exportedRows = (file: string): EventEnvelope[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as EventEnvelope)

// The importer writes in batches of up to 500 rows, cut only where no turn is open. Exports longer
// than one batch used to fail at the second batch: the target's title writer answered the first
// batch's rows with rows of its own, and every later row missed its exported sequence. A turn longer
// than one batch was refused outright.
describe('agnes export -> import of a session longer than one import batch', () => {
  it.each([
    ['30 turns', Array.from({ length: 30 }, (_, i) => say(`answer ${i}`)), 30, 540],
    ['70 turns', Array.from({ length: 70 }, (_, i) => say(`answer ${i}`)), 70, 1200],
    ['one turn of 600 tool calls', [reads(600), say('done')], 1, 1200],
  ] as const)(
    'lands every row of %s on its own sequence',
    async (_name, script, turns, atLeast) => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-import-large-'))
      tmp.push(dir)
      const id = await source(dir, [...script], turns)
      const file = join(dir, 'session.jsonl')
      const exported = await run(dir, ['export', id, '-o', file])
      expect(exported.code, exported.err).toBe(0)
      const rows = exportedRows(file)
      expect(rows.length).toBeGreaterThan(atLeast)
      if (turns === 1) expect(rows.filter((row) => row.type === 'turn/start')).toHaveLength(1)

      const imported = await run(dir, ['import', file, '--key', 'restored'])
      expect(imported.code, imported.err).toBe(0)
      expect(imported.out).toContain(`imported ${rows.length - 1} events`)

      // Export verifies the target's hash chain before it reads a row, so a second export both checks
      // the imported ledger's integrity and shows exactly what landed.
      const again = join(dir, 'again.jsonl')
      const reexported = await run(dir, ['export', 'restored', '-o', again])
      expect(reexported.code, reexported.err).toBe(0)
      const landed = exportedRows(again)
      // session/start is the target's own, carrying the import marker; every other row is the source's.
      expect(landed.slice(1)).toEqual(rows.slice(1))
      expect(landed[0]?.data).toMatchObject({ imported: { source: 'agnes' } })
    },
    300_000,
  )
})
