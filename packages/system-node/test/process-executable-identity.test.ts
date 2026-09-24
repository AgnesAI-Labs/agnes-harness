import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  windowsExecutableFileIdentitySync,
  windowsProcessExecutableIdentitySync,
  windowsProcessStartTimeSync,
} from '../src/index.js'

describe.skipIf(process.platform !== 'win32')('Windows signed process executable identity', () => {
  it('binds a verified Authenticode signer and executable path to the same live process', () => {
    const identity = windowsProcessExecutableIdentitySync(process.pid)
    expect(identity.executablePath.toLocaleLowerCase('en-US')).toBe(
      realpathSync(process.execPath).toLocaleLowerCase('en-US'),
    )
    expect('publisherSha256' in identity).toBe(true)
    if (!('publisherSha256' in identity)) throw new Error('Node should use Authenticode identity')
    expect(identity.publisherSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(identity.processStartTime).toBe(windowsProcessStartTimeSync(process.pid))
    expect(identity.mappedImagePath).toMatch(/^\\Device\\/i)
    expect(identity.imageBinding).toBe('mapped-image-file-handle-v1')
  })

  it('rejects invalid process identifiers before native dispatch', () => {
    expect(() => windowsProcessExecutableIdentitySync(0)).toThrow('positive Windows process ID')
    expect(() => windowsProcessExecutableIdentitySync(Number.NaN)).toThrow('positive Windows process ID')
  })

  it('verifies an executable file before returning its leaf signer identity', () => {
    const identity = windowsExecutableFileIdentitySync(process.execPath)
    expect(identity.executablePath.toLocaleLowerCase('en-US')).toContain('node.exe')
    expect(identity.publisherSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(identity.leafThumbprint).toMatch(/^[a-f0-9]{40}$/)
    expect(identity.publisher.length).toBeGreaterThan(0)
  })
})
