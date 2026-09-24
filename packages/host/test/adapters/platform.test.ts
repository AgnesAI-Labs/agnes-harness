import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CAPABILITY_IDS, createPlatform } from '../../src/adapters/platform.js'
import { createPosixPlatform } from '../../src/adapters/platform-posix.js'
import { createWin32Platform } from '../../src/adapters/platform-win32.js'

describe('platform backends', () => {
  it('exactly one backend matches the running OS', () => {
    const matching = [createPosixPlatform(), createWin32Platform()].filter((b) => b.matches())
    expect(matching).toHaveLength(1)
    expect(createPlatform().os).toBe(matching[0]?.os)
  })
  it('capabilities are unavailable until probed, then declared honestly', async () => {
    const p = createPlatform()
    for (const id of CAPABILITY_IDS)
      expect(p.capability(id)).toMatchObject({ level: 'unavailable', reason: 'not probed' })
    await p.probe()
    const kill = p.capability('exec.kill-tree')
    expect(['full', 'partial', 'unavailable']).toContain(kill.level)
    expect(p.snapshot().capabilities['exec.kill-tree']).toBe(kill.level)
    expect(() => p.capability('nope')).toThrow(/unknown capability/)
  })
  it('does not promote sandbox executable presence, only a completed full-boundary report', async () => {
    const p = createPosixPlatform()
    await p.probe()
    expect(p.capability('sandbox.l1')).toMatchObject({
      level: 'unavailable',
      reason: expect.stringContaining('full-boundary probe'),
    })
    expect(p.capability('sandbox.network').level).toBe('unavailable')

    p.recordSandboxBackend({
      name: 'seatbelt',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
    })
    expect(p.capability('sandbox.l1')).toEqual({
      level: 'full',
      scope: ['file', 'process'],
      value: 'seatbelt',
    })
    expect(p.capability('sandbox.network')).toEqual({
      level: 'full',
      scope: ['network'],
      value: 'seatbelt',
    })

    p.recordSandboxBackend({ name: 'none', enforcement: { level: 'none', scope: [] } })
    expect(p.capability('sandbox.l1').level).toBe('unavailable')
    expect(p.capability('sandbox.network').level).toBe('unavailable')
  })
  it('the capability id set is closed at seven, and each backend answers for every one', async () => {
    expect([...CAPABILITY_IDS].sort()).toEqual([
      'exec.kill-tree',
      'fs.symlink',
      'ipc',
      'sandbox.l1',
      'sandbox.network',
      'terminal.kitty-keys',
      'terminal.truecolor',
    ])
    for (const b of [createPosixPlatform(), createWin32Platform()]) {
      await b.probe()
      for (const id of CAPABILITY_IDS) {
        expect(b.capability(id).reason, `${b.os}/${id}`).not.toBe('not probed')
        expect(Object.keys(b.snapshot().capabilities).sort()).toEqual([...CAPABILITY_IDS].sort())
      }
    }
  })
  it('two backends do not share one capability table', async () => {
    const a = createPosixPlatform()
    const b = createPosixPlatform()
    await a.probe()
    expect(b.capability('ipc').reason).toBe('not probed')
  })
  it('posix backend reports posix shell and case-sensitivity from probe', async () => {
    const p = createPosixPlatform()
    if (!p.matches()) return
    await p.probe()
    expect(p.shell()).toBe('posix')
    expect(typeof p.fs().caseSensitive).toBe('boolean')
    expect(p.fs().pathSep).toBe('/')
  })
  it('an unprobed posix backend claims the safe answer, not the convenient one', () => {
    // `fs.ts` folds when it is told the filesystem is case-insensitive, so `true` is the value that
    // turns folding off. Asserting it before measuring made `createPlatform()` hand a caller a
    // backend through which `.GIT/config` reads straight out of the deny list.
    const p = createPosixPlatform()
    expect(p.fs().caseSensitive).toBe(false)
  })
  // This test only discriminates where tmpdir and the root sit on different volumes. On a
  // single-volume machine both measurements agree, so it pins that the probe answers correctly for
  // the root it was handed, not that it stopped measuring the wrong one.
  it('measures case sensitivity on the root it is given, and agrees with that volume', async () => {
    const p = createPosixPlatform()
    if (!p.matches()) return
    const parent = mkdtempSync(join(tmpdir(), 'agnes-root-'))
    const root = join(parent, 'Workspace')
    try {
      mkdirSync(root)
      // Ground truth for this volume, measured the direct way inside the root itself.
      writeFileSync(join(root, 'A'), '')
      const truth = !existsSync(join(root, 'a'))
      await p.probe({ root })
      expect(p.fs().caseSensitive).toBe(truth)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
  it('fails closed when the requested root offers no case-sensitivity signal', async () => {
    const p = createPosixPlatform()
    if (!p.matches()) return
    const empty = mkdtempSync(join(tmpdir(), 'agnes-empty-root-'))
    try {
      for (const root of [join(tmpdir(), 'agnes-absent-root-x'), empty]) {
        await p.probe({ root })
        expect(p.fs().caseSensitive).toBe(false)
      }
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
  it('win32 backend shape', () => {
    const w = createWin32Platform()
    expect(w.shell()).toBe('powershell')
    expect(w.fs().pathSep).toBe('\\')
    expect(w.fs().caseSensitive).toBe(false)
    expect(w.os).toBe('win32')
  })
  it('reports an ipc shape after probing', async () => {
    const p = createPlatform()
    await p.probe()
    expect(['unix', 'pipe']).toContain(p.capability('ipc').value)
    const w = createWin32Platform()
    await w.probe()
    expect(w.capability('ipc').value).toBe('pipe')
  })
  it('a capability the platform cannot offer says why rather than going quiet', async () => {
    const w = createWin32Platform()
    await w.probe()
    const l1 = w.capability('sandbox.l1')
    expect(l1.level).toBe('unavailable')
    expect(l1.reason).toBeTruthy()
    expect(l1.scope).toEqual([])
    w.recordSandboxBackend({
      name: 'bwrap',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
    })
    expect(w.capability('sandbox.l1')).toMatchObject({ level: 'unavailable' })
    expect(w.capability('sandbox.network')).toMatchObject({ level: 'unavailable' })
  })
  it('snapshot carries the os and arch alongside the levels', async () => {
    const p = createPlatform()
    await p.probe()
    const snap = p.snapshot()
    expect(snap.os).toBe(p.os)
    expect(typeof snap.arch).toBe('string')
    expect(snap.arch.length).toBeGreaterThan(0)
  })
  it('killTree swallows a pid that is already gone rather than throwing', () => {
    const p = createPlatform()
    expect(() => p.killTree(0x7ffffff0)).not.toThrow()
  })
  it('killTree refuses invalid pids instead of targeting the caller process group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const p = createPosixPlatform()
      for (const pid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) p.killTree(pid)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
