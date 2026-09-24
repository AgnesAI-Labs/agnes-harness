import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('builds local web assets with the shared platform vendor modules', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agnes-local-web-build-'))
  try {
    const { buildLocalWeb } = await import('../tools/build-local.js')
    await buildLocalWeb(output)

    const app = await readFile(join(output, 'app.js'), 'utf8')
    const html = await readFile(join(output, 'index.html'), 'utf8')
    expect(app).toMatch(/from\s+["']react["']/)
    expect(html).toContain('"react": "/vendor/react.js"')

    for (const entry of [
      'react.js',
      'react-jsx-runtime.js',
      'react-dom.js',
      'react-dom-client.js',
      'cordis.js',
      'web-client.js',
    ]) {
      await expect(readFile(join(output, 'vendor', entry), 'utf8')).resolves.toBeTruthy()
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
