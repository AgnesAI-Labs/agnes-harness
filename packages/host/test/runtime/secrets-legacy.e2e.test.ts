import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { expect, it } from 'vitest'
import { composeSecrets, createSecretsEnv, createSecretsFile } from '../../src/adapters/secrets.js'
import {
  boundary,
  cleanup,
  consumer,
  error,
  must,
  resolveInput,
  scan,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

it('preserves file-before-env, managed envelope decoding and refusal-before-fallback through the injected legacy resolver', async () => {
  const root = scratch()
  const store = join(root, 'legacy')
  const file = join(store, 'fixture', 'old')
  createPrivateDirectorySync(store)
  createPrivateDirectorySync(join(store, 'fixture'))
  closeSync(createPrivateFileSync(file))
  const previous = process.env.AGNES_SECRET_FIXTURE_OLD
  process.env.AGNES_SECRET_FIXTURE_OLD = 'env-invalid'
  writeFileSync(
    file,
    JSON.stringify({ version: 1, kind: 'api-key', provider: 'fixture', value: 'file-invalid' }),
    { mode: 0o600 },
  )
  const source = composeSecrets(createSecretsFile({ dir: store }), createSecretsEnv())
  const auth = boundary()
  const broker = secrets('default', join(root, 'broker'), auth, { source })
  try {
    const locator = must(await broker.resolve(resolveInput, auth.call()))
    must(
      await broker.use(locator, consumer, auth.call(), (value) => {
        expect(value === 'file-invalid').toBe(true)
      }),
    )
    if (process.platform === 'win32') {
      // guards-allow-platform: mutate only isolated test file permissions
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
        windowsHide: true,
      })
    } else chmodSync(file, 0o644)
    const refused = await broker.use(locator, consumer, auth.call(), () => {
      throw new Error('Fallback must not expose material')
    })
    expect(error(refused)).toBe('denied/secret_unavailable')
    expect(() => source.resolve('secret://fixture/old')).toThrow()
    scan(join(root, 'broker'), ['file-invalid', 'env-invalid'], [locator, refused])
  } finally {
    if (previous === undefined) delete process.env.AGNES_SECRET_FIXTURE_OLD
    else process.env.AGNES_SECRET_FIXTURE_OLD = previous
    await broker.close()
    cleanup(root)
  }
})
