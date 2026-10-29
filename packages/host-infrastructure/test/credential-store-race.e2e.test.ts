import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCredentialStore, type StoredCredentialV1 } from '../src/adapters/credential-store.js'

const run = promisify(execFile)
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../host/test/fixtures',
  'credential-writer.ts',
)

describe.runIf(process.getuid !== undefined)('credential store atomic writers', () => {
  let parent: string
  let root: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-credential-race-'))
    chmodSync(parent, 0o700)
    root = join(parent, '.agh')
  })

  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('persists generic credentials across writer process restart without returning the value', async () => {
    const ref = 'secret://generic/11111111-1111-4111-8111-111111111111'
    const canary = 'synthetic-process-persistence-canary'
    const storeUrl = new URL('../src/adapters/credential-store.ts', import.meta.url).href
    const resolverUrl = new URL('../src/adapters/secrets.ts', import.meta.url).href
    const env = { ...process.env, AGH_TEST_STORE_ROOT: root, AGH_TEST_STORE_VALUE: canary }
    const writer = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      const { createCredentialStore } = await import(${JSON.stringify(storeUrl)});
      await createCredentialStore({ root: process.env.AGH_TEST_STORE_ROOT }).putGeneric(${JSON.stringify(ref)}, process.env.AGH_TEST_STORE_VALUE, { label: 'Persisted', createdAt: '2026-10-11T00:00:00.000Z' });
    `,
      ],
      { env, timeout: 30_000 },
    )
    expect(writer.stdout).toBe('')
    const reader = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
      const { createCredentialStore } = await import(${JSON.stringify(storeUrl)});
      const { createSecretsFile } = await import(${JSON.stringify(resolverUrl)});
      const root = process.env.AGH_TEST_STORE_ROOT;
      if (createSecretsFile({ dir: root + '/secrets' }).resolve(${JSON.stringify(ref)}) !== process.env.AGH_TEST_STORE_VALUE) throw new Error('persistence mismatch');
      process.stdout.write(JSON.stringify(await createCredentialStore({ root }).listGeneric()));
    `,
      ],
      { env, timeout: 30_000 },
    )
    expect(JSON.parse(reader.stdout)).toEqual([
      { id: ref, label: 'Persisted', createdAt: '2026-10-11T00:00:00.000Z', kind: 'api-key' },
    ])
    expect(JSON.stringify([writer, reader])).not.toContain(canary)
  }, 45_000)

  it('leaves one complete closed envelope after twenty processes write the same ref', async () => {
    const values = Array.from({ length: 20 }, (_, index) => `writer-marker-${index}`)
    const writes = await Promise.allSettled(
      values.map((value) =>
        run(process.execPath, ['--import', 'tsx', fixture, root, 'secret://deepseek/default', value], {
          cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
          timeout: 30_000,
        }),
      ),
    )
    expect(writes.filter((write) => write.status === 'rejected')).toEqual([])

    const store = createCredentialStore({ root })
    const stored = (await store.read('secret://deepseek/default')) as StoredCredentialV1
    expect(stored).toMatchObject({ version: 1, kind: 'api-key', provider: 'deepseek' })
    if (stored.kind !== 'api-key') throw new Error('writer produced the wrong credential kind')
    expect(values).toContain(stored.value)
  }, 45_000)
})
