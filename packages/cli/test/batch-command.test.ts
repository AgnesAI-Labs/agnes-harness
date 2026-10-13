import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BatchStatus } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBatchArgs, runBatchCommand } from '../src/commands/batch.js'
import { UsageError } from '../src/errors.js'

const status = (over: Partial<BatchStatus> = {}): BatchStatus => ({
  batchId: 'b0123456789ab',
  status: 'running',
  dir: 'lab',
  outDir: 'agh-batch/b0123456789ab',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  counts: { total: 352, pending: 300, running: 4, done: 48, invalid: 0, failed: 0, skipped: 0, cancelled: 0 },
  spentCredits: 1.2,
  ...over,
})
let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agh-batch-cli-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

function fakeClient(answers: unknown[]) {
  const calls: Array<[string, unknown]> = []
  const added: string[] = []
  return {
    calls,
    added,
    client: {
      call: async <T>(method: string, params: unknown): Promise<T> => {
        calls.push([method, params])
        const next = answers.shift()
        if (next instanceof Error) throw next
        return next as T
      },
      workspace: { add: async (path: string) => void added.push(path) },
    },
  }
}
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      cwd,
      write: (t: string) => void out.push(t),
      error: (t: string) => void err.push(t),
      sleep: async () => undefined,
    },
  }
}

describe('parseBatchArgs', () => {
  it('reads the verb, the target and the options', () => {
    expect(
      parseBatchArgs([
        'start',
        'lab',
        '--prompt',
        'Count',
        '--concurrency',
        '4',
        '--max-edge',
        '1024',
        '--json',
      ]),
    ).toMatchObject({
      verb: 'start',
      target: 'lab',
      json: true,
      options: { prompt: 'Count', concurrency: '4', 'max-edge': '1024' },
    })
    expect(parseBatchArgs(['status', 'b0123456789ab', '--watch'])).toMatchObject({
      verb: 'status',
      watch: true,
    })
    expect(parseBatchArgs(['list'])).toMatchObject({ verb: 'list' })
  })
  it('refuses missing pieces with usage', () => {
    for (const argv of [
      [],
      ['start', 'lab'],
      ['start', 'lab', '--prompt', 'a', '--prompt-file', 'b'],
      ['status'],
      ['list', 'x'],
      ['explode'],
      ['start', 'lab', '--bogus'],
    ])
      expect(() => parseBatchArgs(argv)).toThrow(UsageError)
  })
})

describe('runBatchCommand', () => {
  it('registers the workspace, reads the prompt and schema files, and starts', async () => {
    writeFileSync(join(cwd, 'prompt.md'), 'Count weevils in {{name}}')
    writeFileSync(join(cwd, 'schema.json'), '{"type":"object","properties":{"count":{"type":"integer"}}}')
    const f = fakeClient([status()])
    const t = io()
    const command = parseBatchArgs([
      'start',
      'lab',
      '--prompt-file',
      'prompt.md',
      '--schema',
      'schema.json',
      '--ext',
      'JPG, png',
      '--budget',
      '2.5',
      '--item-timeout',
      '120',
      '--out',
      'results',
    ])
    expect(await runBatchCommand(command, f.client, t.io)).toBe(0)
    expect(f.added).toEqual([cwd])
    expect(f.calls).toEqual([
      [
        '_agnes/v1/batch.start',
        {
          cwd,
          spec: {
            dir: 'lab',
            prompt: 'Count weevils in {{name}}',
            schema: { type: 'object', properties: { count: { type: 'integer' } } },
            ext: ['jpg', 'png'],
            budgetCredits: 2.5,
            itemTimeoutSec: 120,
            outDir: 'results',
          },
        },
      ],
    ])
    expect(t.out.join('')).toContain('Batch b0123456789ab: running')
  })

  it('watches until the batch is no longer running', async () => {
    const f = fakeClient([
      status(),
      status({ status: 'completed', counts: { ...status().counts, pending: 0, running: 0, done: 352 } }),
    ])
    const t = io()
    expect(
      await runBatchCommand(parseBatchArgs(['status', 'b0123456789ab', '--watch']), f.client, t.io),
    ).toBe(0)
    expect(f.calls).toHaveLength(2)
    expect(t.out.join('')).toContain('completed')
  })

  it('exports results and prints the summary', async () => {
    const f = fakeClient([
      status({
        status: 'completed',
        files: ['agh-batch/b0123456789ab/results.csv'],
        summary: '# Batch b0123456789ab',
      }),
    ])
    const t = io()
    await runBatchCommand(parseBatchArgs(['results', 'b0123456789ab']), f.client, t.io)
    expect(f.calls).toEqual([['_agnes/v1/batch.status', { batchId: 'b0123456789ab', export: true }]])
    expect(t.out.join('')).toContain('# Batch b0123456789ab')
  })

  it('says the daemon is needed when the method is missing', async () => {
    const f = fakeClient([Object.assign(new Error('Method not found'), { code: -32601 })])
    const t = io()
    expect(await runBatchCommand(parseBatchArgs(['list']), f.client, t.io)).toBe(1)
    expect(t.err.join('')).toContain('agh daemon start')
  })

  it('rejects a schema file that is not JSON', async () => {
    writeFileSync(join(cwd, 'schema.json'), '{nope')
    await expect(
      runBatchCommand(
        parseBatchArgs(['start', 'lab', '--prompt', 'x', '--schema', 'schema.json']),
        fakeClient([]).client,
        io().io,
      ),
    ).rejects.toThrow(UsageError)
  })
})
