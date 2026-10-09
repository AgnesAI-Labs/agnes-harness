import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { administerObservability } from '../src/admin.js'
import { acquireObservability } from '../src/runtime.js'
import { memoryCollector } from '../testkit/index.js'

it('saves private settings, applies them live, and probes all collector signals without session content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-otlp-admin-'))
  const collector = await memoryCollector()
  const lease = acquireObservability(home)
  try {
    expect((await administerObservability({}, home)).health.status).toBe('disabled')
    const settings = {
      enabled: true,
      endpoint: collector.endpoint,
      redaction: 'metadata' as const,
      batchSize: 1,
      queueSize: 1,
    }
    expect((await administerObservability({ settings }, home)).health.status).toBe('idle')
    if (process.platform !== 'win32')
      expect((await stat(join(home, 'observability.json'))).mode & 0o777).toBe(0o600) // guards-allow-platform: POSIX private file mode assertion.
    expect((await administerObservability({ settings, test: true }, home)).connection).toBe('ok')
    expect(collector.requests.map((row) => row.path).sort()).toEqual([
      '/v1/logs',
      '/v1/metrics',
      '/v1/traces',
    ])
    const stored = await readFile(join(home, 'observability.json'), 'utf8')
    await administerObservability({ settings: { ...settings, enabled: false }, test: true }, home)
    expect(await readFile(join(home, 'observability.json'), 'utf8')).toBe(stored)
    collector.refuse(503)
    expect((await administerObservability({ settings, test: true }, home)).connection).toBe('failed')
    await expect(
      administerObservability(
        { settings: { ...settings, headers: { authorization: 'plaintext' } } as never },
        home,
      ),
    ).rejects.toThrow('Invalid OTLP secret refs')
    expect(await readFile(join(home, 'observability.json'), 'utf8')).not.toContain('plaintext')
  } finally {
    await lease.dispose()
    await collector.close()
    await rm(home, { recursive: true, force: true })
  }
})
