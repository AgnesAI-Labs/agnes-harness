import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { runHeadless } from '@agnes/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { applyHeadlessBundle, loadHeadlessBundle } from '../src/boot/headless.js'
import { parseRunArgs, runCommand } from '../src/commands/run.js'
import type { Booted } from '../src/types.js'

vi.mock('@agnes/sdk', () => ({ runHeadless: vi.fn() }))
const dirs: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
it('owns the run grammar including stdin and refuses incomplete, duplicate and incompatible options', () => {
  expect(parseArgs(['run', '--bundle', 'pkg#demo', '--input', '-', '--json']).rest).toContain('-')
  expect(parseRunArgs(['--bundle', 'pkg#demo', '--input', '-', '--json'])).toMatchObject({
    input: '-',
    batch: false,
  })
  expect(() => parseRunArgs(['--bundle', 'pkg#demo', '--input', '-'])).toThrow('--json')
  expect(() => parseRunArgs(['--bundle', 'pkg#demo', '--input', '-', '--json', '--batch'])).toThrow('folder')
  expect(() => parseRunArgs(['--bundle', 'a', '--bundle', 'b'])).toThrow('duplicate')
})
it('runs folder inputs in stable order, streams each result and returns the first failure status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-batch-'))
  dirs.push(dir)
  await writeFile(join(dir, 'b.txt'), 'second')
  await writeFile(join(dir, 'a.txt'), 'first')
  const output: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, next) {
      output.push(String(chunk))
      next()
    },
  })
  const close = vi.fn(async () => {})
  const boot = vi.fn(
    async () => ({ client: { workspace: { add: async () => ({}) } }, close }) as unknown as Booted,
  )
  vi.mocked(runHeadless).mockImplementation(async (_client, options) => {
    const reason = options.input === 'first' ? 'blocked' : 'completed'
    await options.write({
      schemaVersion: 1,
      runId: options.runId!,
      sessionId: 's',
      type: 'result',
      reason,
      lastSeq: 1,
      eventsComplete: true,
    })
    return { sessionId: 's', reason, lastSeq: 1, eventsComplete: true }
  })
  expect(
    await runCommand(['--bundle', 'pkg#demo', '--input', dir, '--batch', '--json'], {
      cwd: dir,
      stdin: Readable.from([]),
      stdout,
      boot,
      signals: new PassThrough(),
    }),
  ).toBe(4)
  expect(vi.mocked(runHeadless).mock.calls.map((call) => call[1].input)).toEqual(['first', 'second'])
  expect(output.map((line) => JSON.parse(line).input)).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')])
  expect(close).toHaveBeenCalled()
})

it('loads Host bundle documents and applies a transient selection without mutating stored inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-bundle-'))
  dirs.push(dir)
  await writeFile(join(dir, 'bundle.json'), JSON.stringify({ profile: { toolPolicy: { readOnly: true } } }))
  const bundle = await loadHeadlessBundle('./bundle.json', dir)
  const original = { builtin: 'local-dev', adminBundles: ['installed#previous'] }
  const next = applyHeadlessBundle(original, bundle)
  expect(next.adminBundles).toEqual(['headless#run'])
  expect(next.bundleCatalog?.['headless#run']?.document.profile?.toolPolicy).toEqual({ readOnly: true })
  expect(original.adminBundles).toEqual(['installed#previous'])
  expect(() => applyHeadlessBundle(original, { id: 'missing#bundle', catalog: {} })).toThrow()
  await writeFile(join(dir, 'bundle.json'), JSON.stringify({ profile: { nonexistentCapability: true } }))
  await expect(loadHeadlessBundle('./bundle.json', dir)).rejects.toThrow()
})
