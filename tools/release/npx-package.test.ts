import { describe, expect, it } from 'vitest'
import {
  PUBLIC_PACKAGE_NAME,
  PUBLIC_PACKAGE_VERSION,
  publishableManifest,
  SUPPORTED_PLATFORMS,
} from './npx-package.js'

describe('publishable npx manifest', () => {
  it('ships @agnes/harness with the alpha version and no install-time dependencies', () => {
    const manifest = publishableManifest('darwin-arm64')
    expect(manifest.name).toBe(PUBLIC_PACKAGE_NAME)
    expect(manifest.name).toBe('@agnes/harness')
    expect(manifest.version).toBe(PUBLIC_PACKAGE_VERSION)
    expect(manifest.version).toMatch(/^0\.1\.0-alpha\.\d+$/)
    expect(manifest.bin).toEqual({ agh: './bin/agh' })
    expect(manifest.engines).toEqual({ node: '>=24.10' })
    expect(manifest.os).toEqual(['darwin'])
    expect(manifest.cpu).toEqual(['arm64'])
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
    expect(Object.hasOwn(manifest, 'dependencies')).toBe(false)
    expect(Object.hasOwn(manifest, 'private')).toBe(false)
    expect(SUPPORTED_PLATFORMS).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ])
  })

  it('rejects a triple outside the supported set', () => {
    expect(() => publishableManifest('freebsd-x64')).toThrow(/Unsupported prebuild triple/)
  })
})
