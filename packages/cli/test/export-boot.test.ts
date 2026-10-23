import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { bootDefault } from '../src/boot/default.js'
import { bootLocal } from '../src/boot/local.js'
import { exportSession } from '../src/commands/export.js'
import { exportInto } from '../src/commands/export-into.js'

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
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function io(): MainIO {
  const home = mkdtempSync(join(tmpdir(), 'agh-export-boot-'))
  homes.push(home)
  return {
    env: { AGH_HOME: home },
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

it('exports for the TUI on a second connection, redacted, to the given file and format, and closes it', async () => {
  const close = vi.fn(async () => undefined)
  const booted = { client: {}, close } as unknown as Awaited<ReturnType<typeof bootDefault>>
  const boot = vi.fn(async () => booted)
  await exportInto(
    parseArgs(['--profile', 'work']),
    boot,
    { cwd: '/w' },
    { sessionId: 'sess-1', format: 'sharegpt', out: '/w/a.json' },
  )
  expect(boot).toHaveBeenCalledOnce()
  expect(exportSession).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'export',
      positional: ['sess-1'],
      out: '/w/a.json',
      format: 'sharegpt',
      html: false,
      raw: false,
      profile: 'work',
    }),
    expect.objectContaining({ cwd: '/w' }),
    booted.client,
  )
  await exportInto(
    parseArgs([]),
    boot,
    { cwd: '/w' },
    { sessionId: 'sess-1', format: 'html', out: '/w/a.html' },
  )
  expect(vi.mocked(exportSession).mock.calls.at(-1)?.[0]).toMatchObject({ html: true, raw: false })
  expect(vi.mocked(exportSession).mock.calls.at(-1)?.[0].format).toBeUndefined()
  vi.mocked(exportSession).mockRejectedValueOnce(new Error('history integrity failed'))
  await expect(
    exportInto(
      parseArgs([]),
      boot,
      { cwd: '/w' },
      { sessionId: 'sess-1', format: 'agnes', out: '/w/a.jsonl' },
    ),
  ).rejects.toThrow('history integrity failed')
  expect(close).toHaveBeenCalledTimes(3)
})
