import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as root from '../src/index.js'

describe('@agnes/cordis host-only exports', () => {
  it('keeps prepared installation APIs out of the package root', () => {
    for (const name of [
      'preparedPluginBrand',
      'preparePluginInvocation',
      'normalizePreparedConfig',
      'pluginPrepared',
      'beginPreparedPluginPublication',
    ]) {
      expect(root).not.toHaveProperty(name)
    }
  })

  it('maps the host API only through the explicit subpath', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string>
    }
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './host': './src/host.ts' })
  })
})
