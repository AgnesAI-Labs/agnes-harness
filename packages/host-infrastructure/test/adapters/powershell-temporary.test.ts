import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverPowerShellDirectories } from '../../src/adapters/powershell-temporary.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe.skipIf(process.platform !== 'win32')('PowerShell temporary directory recovery', () => {
  it('only reclaims private empty directories with a different owner identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-recover-'))
    roots.push(root)
    const identity = windowsProcessStartTimeSync(process.pid)
    if (!identity) throw new Error('missing process identity')
    const name = (time: string) => join(root, `agnes-powershell-v1-${process.pid}-${time}-${randomUUID()}`)
    const stale = name('1'),
      active = name(identity),
      nonempty = name('1'),
      broad = name('1')
    const legacy = join(root, `agnes-powershell-${randomUUID()}`),
      junction = name('1')
    const target = join(root, 'outside-owned-scope')
    for (const path of [stale, active, nonempty, legacy, target]) createPrivateDirectorySync(path)
    mkdirSync(broad)
    symlinkSync(target, junction, 'junction')
    writeFileSync(join(nonempty, 'keep.txt'), 'keep me')
    expect(recoverPowerShellDirectories(root)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    for (const path of [active, nonempty, broad, legacy, junction, target])
      expect(existsSync(path)).toBe(true)
    expect(readFileSync(join(nonempty, 'keep.txt'), 'utf8')).toBe('keep me')
    expect(recoverPowerShellDirectories(root)).toBe(0)
  })
})
