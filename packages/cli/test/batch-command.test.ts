import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { commandHelp } from '../src/command-help.js'
import { batchCommand, parseBatchArgs } from '../src/commands/batch.js'
import { scopedBatchClient } from '../src/commands/batch-client.js'
import { runBatchCli } from '../src/commands/batch-runtime.js'
import { FakeEndpoint } from './fake-endpoint.js'

const id = 'b123456abcdef'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
describe('batch thin client', () => {
  it.each(
    [
      [],
      ['start', 'items'],
      ['start', 'items', '--prompt', 'x', '--budget', '-1'],
      ['start', 'items', '--prompt', 'x', '--budget', '1', '--concurrency', '9'],
      ['start', 'items', '--prompt', 'x', '--budget', '1', '--budget', '2'],
      ['status', '../bad'],
      ['status', id, '--prompt', 'x'],
      ['cancel', id, '--watch'],
      ['export', id],
    ].map((args) => ({ args })),
  )('rejects malformed options before connecting: $args', async ({ args }) => {
    const connect = vi.fn()
    await expect(batchCommand(args, { cwd: '/workspace', write() {}, connect })).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })
  it('forwards input configuration to the backend without enumerating files or creating sessions', async () => {
    const calls: { verb: string; input: Record<string, unknown> }[] = [],
      close = vi.fn(async () => {})
    const connect = vi.fn(async () => ({
      close,
      call: async (verb: string, input: Record<string, unknown>) => {
        calls.push({ verb, input })
        return { id, status: 'running' }
      },
    }))
    const output: string[] = []
    expect(
      await batchCommand(
        ['start', 'missing-folder', '--prompt', 'x', '--budget', '2', '--profile', 'synthetic', '--json'],
        {
          cwd: '/workspace',
          write: (s) => output.push(s),
          connect,
        },
      ),
    ).toBe(0)
    expect(calls[0]).toMatchObject({
      verb: 'start',
      input: { dir: 'missing-folder', spec: { budget: 2, concurrency: 4 } },
    })
    expect(calls[0]!.input.id).toMatch(/^b[0-9a-f]{12}$/u)
    expect(connect).toHaveBeenCalledWith({ cwd: resolve('/workspace'), profile: 'synthetic' })
    expect(close).toHaveBeenCalledOnce()
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'running' })
    await batchCommand(
      [
        'start',
        'inputs',
        '--prompt',
        '{{path}} {{name}} {{ordinal}}',
        '--max-edge',
        '1024',
        '--out',
        'reports',
        '--ext',
        ' .TXT, .Jpg ',
      ],
      { cwd: '/workspace', write() {}, connect },
    )
    expect(calls[1]).toMatchObject({
      input: {
        workspaceRoot: resolve('/workspace'),
        extensions: ['txt', 'jpg'],
        spec: {
          budget: Number.MAX_SAFE_INTEGER,
          concurrency: 4,
          itemTimeoutMs: 600000,
          maxEdge: 1024,
          out: 'reports',
          itemBudget: Number.MAX_SAFE_INTEGER / 4,
        },
      },
    })
  })
  it('follows status with bounded polls and closes on terminal state, failure or abort', async () => {
    for (const end of ['completed', 'failed', 'unknown']) {
      const close = vi.fn(async () => {}),
        sleep = vi.fn(async () => {})
      const states = ['running', end]
      expect(
        await batchCommand(['follow', id], {
          cwd: '/workspace',
          write() {},
          sleep,
          connect: async () => ({ close, call: async () => ({ status: states.shift() }) }),
        }),
      ).toBe(end === 'completed' ? 0 : 1)
      expect(sleep).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
    }
    const controller = new AbortController(),
      close = vi.fn(async () => {})
    await expect(
      batchCommand(['follow', id], {
        cwd: '/workspace',
        write() {},
        signal: controller.signal,
        sleep: async () => {
          controller.abort()
        },
        connect: async () => ({ close, call: async () => ({ status: 'running' }) }),
      }),
    ).rejects.toThrow()
    expect(close).toHaveBeenCalledOnce()
  })
  it('pages result and manifest responses and refuses repeated or unbounded cursors', async () => {
    for (const verb of ['results', 'list']) {
      const payloads: Record<string, unknown>[] = []
      let page = 0
      await batchCommand([verb, ...(verb === 'list' ? [] : [id])], {
        cwd: '/workspace',
        write() {},
        connect: async () => ({
          close: async () => {},
          call: async (_verb, input) => {
            payloads.push(input)
            return ++page === 1
              ? verb === 'list'
                ? { rows: [], nextCursor: 'cursor:one' }
                : { items: [], nextOffset: 3 }
              : {}
          },
        }),
      })
      expect(payloads).toEqual(verb === 'list' ? [{}, { cursor: 'cursor:one' }] : [{ id }, { id, offset: 3 }])
    }
    for (const [verb, result] of [
      ['list', { nextCursor: 'repeated' }],
      ['results', { nextOffset: 100001 }],
    ] as const) {
      await expect(
        batchCommand([verb, ...(verb === 'list' ? [] : [id])], {
          cwd: '/workspace',
          write() {},
          connect: async () => ({ close: async () => {}, call: async () => result }),
        }),
      ).rejects.toThrow('cursor')
    }
  })
  it('dispatches batch grammar and help without treating it as a chat prompt', () => {
    const rest = ['start', 'items', '--prompt', 'x', '--budget', '1']
    expect(parseArgs(['batch', ...rest])).toMatchObject({ command: 'batch', rest })
    expect(parseArgs(['batch', '--help'])).toMatchObject({ command: 'batch', help: true })
    expect(commandHelp('batch')).toContain('agh batch start')
  })
  it('uses the actual SDK scoped facade and preserves native approval and unknown receipts', async () => {
    const client = createClient({
      transport: { kind: 'inproc', endpoint: new FakeEndpoint() },
      auth: { kind: 'local' },
      journal: memoryJournal(),
    })
    const rpc = vi.spyOn(client, 'call')
    const close = vi.fn(async () => {
      await client.close()
    })
    const outputs: string[] = []
    const io = {
      cwd: '/workspace',
      write: (text: string) => {
        outputs.push(text)
      },
      connect: async () => scopedBatchClient(client, close),
    }
    rpc.mockResolvedValueOnce({ state: 'approval-required', operationId: `batch.start:${id}` })
    const start = ['start', 'items', '--id', id, '--prompt', 'x', '--budget', '1', '--json']
    expect(await batchCommand(start, io)).toBe(3)
    expect(JSON.parse(outputs[0]!)).toMatchObject({ batchId: id, operation: { state: 'approval-required' } })
    expect(rpc.mock.calls[0]).toMatchObject([
      '_agnes/v1/extension.callScoped',
      {
        service: 'batch.start',
        input: { id },
        operationId: `batch.start:${id}`,
      },
    ])
    const extension = (rpc.mock.calls[0]![1] as { extension: string }).extension
    expect(extension).toMatch(/^plugin\/[a-f0-9]{16}$/u)
    // Reuse the prepared business id and operation; never answer approval in the CLI.
    rpc.mockResolvedValueOnce({
      state: 'completed',
      operationId: `batch.start:${id}`,
      output: { id, status: 'running' },
    })
    expect(await batchCommand(start, io)).toBe(0)
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0])
    rpc.mockResolvedValueOnce({ state: 'unknown', operationId: 'resume:one', code: 'OUTCOME_UNKNOWN' })
    expect(await batchCommand(['resume', id, '--operation', 'resume:one'], io)).toBe(1)
    expect(rpc.mock.calls).toHaveLength(3)
    expect(close).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls.flat()).not.toContain('_agnes/v1/profile.decisions.answer')
  })
  it('closes only the CLI connection on interrupt and removes signal handlers', async () => {
    const signals = new EventEmitter(),
      stdout = new PassThrough()
    const client = createClient({
      transport: { kind: 'inproc', endpoint: new FakeEndpoint() },
      auth: { kind: 'local' },
      journal: memoryJournal(),
    })
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let reject!: (error: Error) => void
    const rpc = vi.spyOn(client, 'call').mockImplementation(
      () =>
        new Promise<never>((_resolve, fail) => {
          reject = fail
          started()
        }),
    )
    const close = vi.fn(async () => {
      reject(new Error('connection closed'))
      await client.close()
    })
    const result = runBatchCli(['follow', id], { cwd: '/workspace', stdout, signals }, async () => ({
      client,
      close,
      profileName: 'synthetic',
      resolvedProfileHash: null,
      bootMs: 0,
      form: 'connect',
    }))
    await ready
    signals.emit('SIGINT')
    expect(await result).toBe(130)
    expect(close).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0]).toMatchObject(['_agnes/v1/extension.callScoped', { service: 'batch.status' }])
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(signals.listenerCount(name)).toBe(0)
    stdout.destroy()
  })
  it('reads bounded prompt/schema files before connecting and renders terminal controls inert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-batch-cli-unit-'))
    dirs.push(dir)
    await writeFile(join(dir, 'prompt'), 'Count')
    await writeFile(join(dir, 'schema'), '{"type":"object"}')
    const output: string[] = [],
      connect = vi.fn(async () => ({
        close: async () => {},
        call: async () => ({ status: 'running', text: '\u001b[31m\u202e' }),
      }))
    await batchCommand(['start', 'items', '--prompt-file', 'prompt', '--schema', 'schema', '--budget', '1'], {
      cwd: dir,
      connect,
      write: (s) => output.push(s),
    })
    expect(output[0]).not.toContain('\u001b')
    expect(output[0]).not.toContain('\u202e')
    await writeFile(join(dir, 'prompt'), 'x'.repeat(64 * 1024 + 1))
    connect.mockClear()
    await expect(
      batchCommand(['start', 'items', '--prompt-file', 'prompt', '--budget', '1'], {
        cwd: dir,
        connect,
        write() {},
      }),
    ).rejects.toThrow('64 KiB')
    expect(connect).not.toHaveBeenCalled()
    expect(parseBatchArgs(['--help']).verb).toBe('help')
  })
})
