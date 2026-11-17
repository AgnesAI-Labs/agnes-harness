import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { batchInvocation, runBatch } from './run-ci-batch.mjs'

const source = JSON.parse(readFileSync(new URL('../ci/web-batches.json', import.meta.url), 'utf8'))
it('runs an exact canonical batch with literal arguments, isolated output and its own widths', () => {
  const batch = source.macos.batches.find((batch: { id: string }) => batch.id === 'narrow-phone')
  expect(
    batchInvocation(JSON.stringify(batch), ['--prepared-local', 'proof'], {
      KEEP: 'value',
      AGH_NARROW_WIDTHS: 'wrong',
    }),
  ).toEqual({
    command: process.execPath,
    args: [
      'tools/e2e-web/ci.mjs',
      'test',
      '--prepared-local',
      'proof',
      'narrow.spec.ts',
      '--grep',
      '375 en/light$',
      '--workers=1',
    ],
    env: { KEEP: 'value', AGH_NARROW_WIDTHS: '375', AGH_WEB_TEST_OUTPUT: '.agnes-tmp/e2e-web/narrow-phone' },
  })
  const nightly = source.nightly[0]
  expect(
    batchInvocation(JSON.stringify(nightly), ['--prepared-local', 'proof'], {}).env.AGH_NARROW_WIDTHS,
  ).toBe('')
})

it('refuses forged identities, options, selectors, widths and preparation arguments', () => {
  const batch = source.macos.batches[0]
  for (const changed of [
    null,
    {},
    { ...batch, id: '../escape' },
    { ...batch, id: 'missing' },
    { ...batch, args: [...batch.args, '--retries=0'] },
    { ...batch, args: ['memory.spec.ts'] },
    { ...batch, widths: '375' },
    { ...batch, timeoutMinutes: 20 },
    { ...batch, unexpected: true },
  ]) {
    expect(() => batchInvocation(JSON.stringify(changed), ['--prepared-local', 'proof'], {})).toThrow()
  }
  for (const args of [
    [],
    ['--prepared-local'],
    ['--prepared-local', '--list'],
    ['--prepared-local', 'proof', '--list'],
  ])
    expect(() => batchInvocation(JSON.stringify(batch), args, {})).toThrow()
})

it('retains child exit status and signal outcomes without a shell or a new timeout', async () => {
  const invocation = batchInvocation(
    JSON.stringify(source.macos.batches[0]),
    ['--prepared-local', 'proof'],
    {},
  )
  for (const result of [
    { code: 7, signal: null },
    { code: null, signal: 'SIGTERM' },
  ]) {
    const start = (_command: string, _args: string[], options: { shell: boolean; timeout?: number }) => {
      expect(options.shell).toBe(false)
      expect(options.timeout).toBeUndefined()
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', result.code, result.signal))
      return child
    }
    await expect(runBatch(invocation, start)).resolves.toEqual(result)
  }
})
