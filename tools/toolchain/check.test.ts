import { readFileSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { assertRuntime, verificationEnvironment } from './check.mjs'

it('accepts the actual test worker runtime and refuses version or executable drift with a repair command', () => {
  const version = `v${readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim()}`
  const expected = { version, execPath: process.execPath }
  expect(() =>
    assertRuntime({ version: process.version, execPath: process.execPath }, expected),
  ).not.toThrow()
  for (const actual of [
    { version: 'v0.0.0', execPath: process.execPath },
    { version, execPath: fileURLToPath(import.meta.url) },
  ]) {
    expect(() => assertRuntime(actual, expected)).toThrow('Toolchain mismatch')
    expect(() => assertRuntime(actual, expected)).toThrow('mise exec -- node tools/toolchain/run.mjs')
  }
})

it('scopes runtime resolution to a copy and removes conflicting Windows PATH keys', () => {
  const source = { Path: 'other', PATH: 'legacy', CUSTOM: 'kept' }
  expect(verificationEnvironment(source)).toEqual({
    PATH: `${dirname(process.execPath)}${delimiter}legacy`,
    CUSTOM: 'kept',
  })
  expect(source).toEqual({ Path: 'other', PATH: 'legacy', CUSTOM: 'kept' })
})
