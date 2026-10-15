import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchCommand, parseBatchArgs } from '../src/commands/batch.js'

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
      input: { dir: 'missing-folder', spec: { budget: 2, concurrency: 2 } },
    })
    expect(calls[0]!.input.id).toMatch(/^b[0-9a-f]{12}$/u)
    expect(connect).toHaveBeenCalledWith({ cwd: '/workspace', profile: 'synthetic' })
    expect(close).toHaveBeenCalledOnce()
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'running' })
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
