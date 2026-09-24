import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCredentialStore, type StoredCredentialV1 } from '../src/adapters/credential-store.js'

const run = promisify(execFile)
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'credential-writer.ts')

describe.runIf(process.getuid !== undefined)('credential store atomic writers', () => {
  let parent: string
  let root: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-credential-race-'))
    chmodSync(parent, 0o700)
    root = join(parent, '.agh')
  })

  afterEach(() => rmSync(parent, { recursive: true, force: true }))

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
