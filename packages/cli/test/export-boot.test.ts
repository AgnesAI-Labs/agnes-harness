import { PassThrough, Readable } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { bootDefault } from '../src/boot/default.js'
import { bootLocal } from '../src/boot/local.js'
import { exportSession } from '../src/commands/export.js'

vi.mock('../src/boot/default.js', () => ({ bootDefault: vi.fn() }))
vi.mock('../src/boot/local.js', async (original) => ({
  ...(await original<typeof import('../src/boot/local.js')>()),
  bootLocal: vi.fn(),
}))
vi.mock('../src/commands/export.js', async (original) => ({
  ...(await original<typeof import('../src/commands/export.js')>()),
  exportSession: vi.fn(async () => 0),
}))

beforeEach(() => vi.clearAllMocks())

function io(): MainIO {
  return {
    env: {},
    cwd: process.cwd(),
    agnesVersion: '0.0.0-test',
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }
}

it('exports through the same default backend as ordinary sessions and closes its client', async () => {
  const close = vi.fn(async () => undefined)
  const booted = { client: {}, close } as unknown as Awaited<ReturnType<typeof bootDefault>>
  vi.mocked(bootDefault).mockResolvedValue(booted)
  vi.mocked(bootLocal).mockRejectedValue(new Error('unexpected independent Host'))
  expect(await main(['export', 'agnes:local:default:cli:dm:export', '--raw'], io())).toBe(0)
  expect(bootDefault).toHaveBeenCalledOnce()
  expect(bootLocal).not.toHaveBeenCalled()
  expect(exportSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), booted.client)
  expect(close).toHaveBeenCalledOnce()
})

it('rejects a missing session id before starting either backend', async () => {
  expect(await main(['export', '--raw'], io())).not.toBe(0)
  expect(bootDefault).not.toHaveBeenCalled()
  expect(bootLocal).not.toHaveBeenCalled()
  expect(exportSession).not.toHaveBeenCalled()
})

it('preserves explicit embedded boot dependencies and closes after export failure', async () => {
  const close = vi.fn(async () => undefined)
  const booted = { client: {}, close } as unknown as Awaited<ReturnType<typeof bootDefault>>
  vi.mocked(bootDefault).mockResolvedValue(booted)
  vi.mocked(exportSession).mockRejectedValueOnce(new Error('export failed'))
  const log = vi.fn()
  expect(await main(['export', 'agnes:local:default:cli:dm:export'], io(), { log })).not.toBe(0)
  expect(bootDefault).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ log }), {
    useEmbedded: true,
  })
  expect(close).toHaveBeenCalledOnce()
})
