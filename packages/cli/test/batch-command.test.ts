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

const ID = 'b0123456789ab'
const rpc = (message: string, code = -32602) => Object.assign(new Error(message), { kind: 'json-rpc', code })
const closed = () => Object.assign(new Error('transport closed: eof'), { kind: 'transport-closed' })
const DANGER = '\x1b[31mred\x1b]52;c;ZXZpbA==\x07tail'
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the check
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/u
const noEscape = (text: string) => expect(text).not.toMatch(CONTROL)

describe('terminal safety', () => {
  it('prints no control character from any daemon-sourced field', async () => {
    const hostile = status({
      status: 'failed',
      reason: DANGER,
      dir: DANGER,
      outDir: `${DANGER}\nsecond line`,
      files: [DANGER, 'b\nc'],
      summary: `# ${DANGER}\nkept line`,
    })
    for (const argv of [['status', ID], ['results', ID], ['cancel', ID], ['list']]) {
      const t = io()
      await runBatchCommand(
        parseBatchArgs(argv),
        fakeClient([argv[0] === 'list' ? { items: [hostile] } : hostile]).client,
        t.io,
      )
      noEscape(t.out.join(''))
    }
    const t = io()
    await runBatchCommand(parseBatchArgs(['status', ID]), fakeClient([hostile]).client, t.io)
    const text = t.out.join('')
    expect(text).toContain('kept line')
    expect(text).toContain('Folder')
    expect(text.split('\n')).toContain('Results folder: [31mred]52;c;ZXZpbA==tail second line')
    const listed = io()
    await runBatchCommand(
      parseBatchArgs(['list']),
      fakeClient([{ items: [hostile, hostile] }]).client,
      listed.io,
    )
    expect(listed.out.join('').trim().split('\n')).toHaveLength(2)
    expect(text).toContain('Files: ')
  })
  it('keeps the daemon error text inert too', async () => {
    const t = io()
    expect(
      await runBatchCommand(parseBatchArgs(['list']), fakeClient([rpc(`bad ${DANGER}\nmore`)]).client, t.io),
    ).toBe(1)
    noEscape(t.err.join('').replace(/\n$/u, ''))
    expect(t.err.join('')).toContain('agh batch: bad')
  })
  it('leaves a --json answer to JSON escaping', async () => {
    const t = io()
    await runBatchCommand(
      parseBatchArgs(['status', ID, '--json']),
      fakeClient([status({ dir: DANGER })]).client,
      t.io,
    )
    noEscape(t.out.join('').replace(/\n$/u, ''))
    expect(JSON.parse(t.out.join('')).dir).toBe(DANGER)
  })
})

describe('exit status', () => {
  it.each([
    ['completed', 0],
    ['running', 0],
    ['failed', 1],
    ['budget_exhausted', 1],
    ['cancelled', 1],
  ] as const)('status of a %s batch exits %i', async (value, code) => {
    expect(
      await runBatchCommand(
        parseBatchArgs(['status', ID]),
        fakeClient([status({ status: value })]).client,
        io().io,
      ),
    ).toBe(code)
  })
  it.each([
    ['completed', 0],
    ['failed', 1],
    ['budget_exhausted', 1],
    ['cancelled', 1],
  ] as const)('a watch that ends on %s exits %i', async (value, code) => {
    const f = fakeClient([status(), status({ status: value })])
    expect(await runBatchCommand(parseBatchArgs(['status', ID, '--watch']), f.client, io().io)).toBe(code)
  })
  it('exits 0 after start, results, cancel and list', async () => {
    writeFileSync(join(cwd, 'p.md'), 'x')
    for (const [argv, answer] of [
      [['start', 'lab', '--prompt', 'x'], status()],
      [['results', ID], status({ status: 'failed' })],
      [['cancel', ID], status({ status: 'cancelled' })],
      [['list'], { items: [] }],
    ] as const)
      expect(await runBatchCommand(parseBatchArgs([...argv]), fakeClient([answer]).client, io().io)).toBe(0)
  })
  it('states the rule in the help text', () => {
    expect(parseBatchArgs(['--help'])).toMatchObject({ verb: 'help' })
    expect(parseBatchArgs(['status', ID, '-h'])).toMatchObject({ verb: 'help' })
  })
})

describe('watching', () => {
  it('sleeps a positive interval between polls and prints only changes', async () => {
    const waits: number[] = []
    const running = status()
    const moved = status({ counts: { ...running.counts, pending: 299, done: 49 } })
    const f = fakeClient([running, running, moved, status({ status: 'completed' })])
    const t = io()
    const withSleep = { ...t.io, sleep: async (ms: number) => void waits.push(ms) }
    await runBatchCommand(parseBatchArgs(['status', ID, '--watch']), f.client, withSleep)
    expect(f.calls).toHaveLength(4)
    expect(waits).toHaveLength(3)
    expect(waits.every((ms) => ms > 0)).toBe(true)
    const lines = t.out.join('').split('\n')
    expect(lines.filter((l) => l.includes('  running  ')).length).toBe(2)
    expect(t.out.join('')).toContain('Batch b0123456789ab: completed')
  })
  it('waits out up to three transport errors and then gives up', async () => {
    const waits: number[] = []
    const t = io()
    const io2 = { ...t.io, sleep: async (ms: number) => void waits.push(ms) }
    const f = fakeClient([closed(), closed(), closed(), status({ status: 'completed' })])
    expect(await runBatchCommand(parseBatchArgs(['status', ID, '--watch']), f.client, io2)).toBe(0)
    expect(waits).toHaveLength(3)
    expect(t.err.join('')).toContain('retrying (3/3)')
    const g = fakeClient([closed(), closed(), closed(), closed()])
    await expect(
      runBatchCommand(parseBatchArgs(['status', ID, '--watch']), g.client, io2),
    ).rejects.toMatchObject({ kind: 'transport-closed' })
  })
  it('does not retry without --watch, and a refusal ends the watch at once', async () => {
    await expect(
      runBatchCommand(parseBatchArgs(['status', ID]), fakeClient([closed()]).client, io().io),
    ).rejects.toMatchObject({ kind: 'transport-closed' })
    const f = fakeClient([rpc('gone'), status()])
    expect(await runBatchCommand(parseBatchArgs(['status', ID, '--watch']), f.client, io().io)).toBe(1)
    expect(f.calls).toHaveLength(1)
  })
})

describe('what is sent', () => {
  it('maps every option to its own spec field', async () => {
    const f = fakeClient([status()])
    const argv = [
      'start',
      'lab',
      '--prompt',
      'p',
      '--concurrency',
      '3',
      '--max-edge',
      '512',
      '--item-timeout',
      '90',
      '--ext',
      '.JPG,.png ,',
      '--budget',
      '0.25',
      '--out',
      'o',
    ]
    await runBatchCommand(parseBatchArgs(argv), f.client, io().io)
    expect(f.calls[0]?.[1]).toEqual({
      cwd,
      spec: {
        dir: 'lab',
        prompt: 'p',
        concurrency: 3,
        maxEdge: 512,
        itemTimeoutSec: 90,
        ext: ['jpg', 'png'],
        budgetCredits: 0.25,
        outDir: 'o',
      },
    })
  })
  it('sends only the fields that were given', async () => {
    const f = fakeClient([status()])
    await runBatchCommand(parseBatchArgs(['start', 'lab', '--prompt', 'p']), f.client, io().io)
    expect(f.calls[0]?.[1]).toEqual({ cwd, spec: { dir: 'lab', prompt: 'p' } })
  })
  it('sends cancel and status with the batch id', async () => {
    const f = fakeClient([status({ status: 'cancelled' }), status({ status: 'completed' })])
    await runBatchCommand(parseBatchArgs(['cancel', ID]), f.client, io().io)
    await runBatchCommand(parseBatchArgs(['status', ID]), f.client, io().io)
    expect(f.calls).toEqual([
      ['_agnes/v1/batch.cancel', { batchId: ID }],
      ['_agnes/v1/batch.status', { batchId: ID }],
    ])
  })
})

describe('output', () => {
  it('prints the json answer as one line', async () => {
    const t = io()
    await runBatchCommand(
      parseBatchArgs(['status', ID, '--json']),
      fakeClient([status({ status: 'completed' })]).client,
      t.io,
    )
    expect(JSON.parse(t.out.join(''))).toMatchObject({ batchId: ID, status: 'completed' })
    expect(t.out.join('').trim().split('\n')).toHaveLength(1)
  })
  it('lists batches, or says there are none', async () => {
    const t = io()
    await runBatchCommand(
      parseBatchArgs(['list']),
      fakeClient([{ items: [status(), status({ batchId: 'b0000000000aa' })] }]).client,
      t.io,
    )
    expect(t.out.join('').trim().split('\n')).toHaveLength(2)
    expect(t.out.join('')).toContain('48/352 done')
    const none = io()
    await runBatchCommand(parseBatchArgs(['list']), fakeClient([{ items: [] }]).client, none.io)
    expect(none.out.join('')).toBe('No batches.\n')
    const json = io()
    await runBatchCommand(parseBatchArgs(['list', '--json']), fakeClient([{ items: [] }]).client, json.io)
    expect(JSON.parse(json.out.join(''))).toEqual({ items: [] })
  })
  it('exits 1 on a refusal that is not a missing method, without the daemon hint', async () => {
    const t = io()
    expect(
      await runBatchCommand(parseBatchArgs(['cancel', ID]), fakeClient([rpc('no such batch')]).client, t.io),
    ).toBe(1)
    expect(t.err.join('')).toBe('agh batch: no such batch\n')
  })
  it('hands anything that is not a daemon answer to the caller', async () => {
    await expect(
      runBatchCommand(parseBatchArgs(['list']), fakeClient([closed()]).client, io().io),
    ).rejects.toMatchObject({ kind: 'transport-closed' })
    await expect(
      runBatchCommand(parseBatchArgs(['list']), fakeClient([new Error('boom')]).client, io().io),
    ).rejects.toThrow('boom')
  })
})

describe('usage errors', () => {
  const start = (...more: string[]) => parseBatchArgs(['start', 'lab', '--prompt', 'p', ...more])
  const refused = async (command: ReturnType<typeof parseBatchArgs>) => {
    const f = fakeClient([status()])
    await expect(runBatchCommand(command, f.client, io().io)).rejects.toThrow(UsageError)
    expect(f.calls).toEqual([])
    expect(f.added).toEqual([])
  }
  it.each([
    ['--concurrency', 'abc'],
    ['--concurrency', '0'],
    ['--concurrency', '9'],
    ['--concurrency', '1e3'],
    ['--max-edge', '255'],
    ['--max-edge', '1457'],
    ['--item-timeout', '59'],
    ['--item-timeout', '3601'],
    ['--budget', 'abc'],
    ['--budget', '1e3'],
    ['--budget', '0'],
    ['--budget', '0.0000001'],
    ['--ext', ' , '],
    ['--ext', 'jp g'],
  ])('refuses %s %s before calling the daemon', async (flag, value) => {
    await refused(start(flag, value))
  })
  it('refuses a negative number in either spelling', async () => {
    for (const flag of ['--concurrency', '--budget']) {
      expect(() => start(flag, '-1')).toThrow(UsageError)
      await refused(start(`${flag}=-1`))
    }
  })
  it('accepts the edges of every range', async () => {
    for (const more of [
      ['--concurrency', '1'],
      ['--concurrency', '8'],
      ['--max-edge', '256'],
      ['--max-edge', '1456'],
      ['--item-timeout', '60'],
      ['--item-timeout', '3600'],
      ['--budget', '0.000001'],
    ])
      expect(await runBatchCommand(start(...more), fakeClient([status()]).client, io().io)).toBe(0)
  })
  it('refuses an id that is not a batch id', () => {
    for (const id of ['abc', 'B0123456789ab', 'b0123456789a', 'b0123456789abc', '\x1b[31mb0123456789ab'])
      for (const verb of ['status', 'results', 'cancel'])
        expect(() => parseBatchArgs([verb, id])).toThrow(UsageError)
  })
  it('refuses options that do not belong to the verb, and repeated options', () => {
    for (const argv of [
      ['results', ID, '--watch'],
      ['cancel', ID, '--watch'],
      ['list', '--watch'],
      ['start', 'lab', '--prompt', 'p', '--watch'],
      ['status', ID, '--prompt', 'x'],
      ['list', '--concurrency', '2'],
      ['start', 'lab', '--prompt', 'a', '--prompt', 'b'],
      ['start', 'lab', '--prompt', 'a', '--cwd', 'x', '--cwd', 'y'],
      ['list', '--profile', 'a', '--profile', 'b'],
    ])
      expect(() => parseBatchArgs(argv)).toThrow(UsageError)
  })
  it('refuses an empty or oversized prompt', async () => {
    await refused(parseBatchArgs(['start', 'lab', '--prompt', '']))
    await refused(parseBatchArgs(['start', 'lab', '--prompt', 'x'.repeat(16385)]))
  })
  it('refuses unreadable, oversized or wrongly shaped input files', async () => {
    await refused(parseBatchArgs(['start', 'lab', '--prompt-file', 'missing.md']))
    await refused(parseBatchArgs(['start', 'lab', '--prompt', 'p', '--schema', 'missing.json']))
    writeFileSync(join(cwd, 'big.md'), 'x'.repeat(64 * 1024 + 1))
    await refused(parseBatchArgs(['start', 'lab', '--prompt-file', 'big.md']))
    writeFileSync(join(cwd, 'wide.json'), `{}${' '.repeat(64 * 1024)}`)
    await refused(parseBatchArgs(['start', 'lab', '--prompt', 'p', '--schema', 'wide.json']))
    for (const [index, body] of ['null', '[]', '3', '"s"'].entries()) {
      writeFileSync(join(cwd, `s${index}.json`), body)
      await refused(parseBatchArgs(['start', 'lab', '--prompt', 'p', '--schema', `s${index}.json`]))
    }
  })
})
