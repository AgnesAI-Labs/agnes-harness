import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createConfigurationService } from '@agnes/host'
import { afterEach, expect, it } from 'vitest'
import { main } from '../src/bin.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('dispatches app clear before generic boot, ignores broken plugins, and only clears presentation using the configuration CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-app-clear-'))
  roots.push(root)
  const config = createConfigurationService({ home: root, profile: 'local-dev' })
  await config.saveApplication({
    revision: 0,
    selection: {
      packageId: 'broken',
      applicationId: 'broken',
      integrity: 'one',
      declarationDigest: 'a'.repeat(64),
      consentDigest: 'b'.repeat(64),
      bindingDigest: 'c'.repeat(64),
    },
  })
  await config.saveSessionDefaults({ revision: 1, defaults: { preset: 'standard' } })
  const directory = join(root, 'profiles', 'local-dev')
  const brokenLock = '{broken package lock'
  await writeFile(join(directory, 'agnes-lock.json'), brokenLock)
  await mkdir(join(root, '.agh', 'plugins'), { recursive: true })
  await writeFile(join(root, '.agh', 'plugins', 'throw.mjs'), 'throw new Error("must not import")')
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  let output = '',
    errors = ''
  stdout.on('data', (bytes) => {
    output += String(bytes)
  })
  stderr.on('data', (bytes) => {
    errors += String(bytes)
  })
  const result = await main(['app', 'clear', '--json'], {
    cwd: root,
    env: { AGH_HOME: root, HOME: root },
    stdin: Readable.from([]),
    stdout,
    stderr,
    agnesVersion: '0.1.0',
  })
  expect({ result, output, errors }).toEqual({ result: 0, output: '{"cleared":true}\n', errors: '' })
  expect(await config.application()).toEqual({ revision: 3, selection: null })
  expect((await config.sessionDefaults()).defaults).toEqual({ preset: 'standard' })
  expect(await readFile(join(directory, 'agnes-lock.json'), 'utf8')).toBe(brokenLock)
})
